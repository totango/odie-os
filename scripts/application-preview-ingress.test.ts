import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const repositoryRoot = join(import.meta.dirname, "..");
const templatePath = join(
  repositoryRoot,
  "infra",
  "application-preview-ingress.yaml",
);
const template = readFileSync(templatePath, "utf8");

function extractFunctionCode(): string {
  const startMarker = "      FunctionCode: !Sub |\n";
  const endMarker = "\n  PreviewDistribution:";
  const start = template.indexOf(startMarker);
  const end = template.indexOf(endMarker, start);
  assert.notEqual(start, -1, "FunctionCode block exists");
  assert.notEqual(end, -1, "FunctionCode block has a resource boundary");
  return template
    .slice(start + startMarker.length, end)
    .split("\n")
    .map((line) => (line.startsWith("        ") ? line.slice(8) : line))
    .join("\n")
    .replaceAll("${PreviewDomain}", "previews.example");
}

const sandbox: Record<string, unknown> = {};
vm.runInNewContext(
  `${extractFunctionCode()}\nthis.previewHandler = handler;`,
  sandbox,
);
const previewHandler = sandbox.previewHandler as (event: unknown) => unknown;

function viewerRequest(host: string, uri = "/nested/file.txt") {
  return {
    request: {
      method: "POST",
      uri,
      querystring: {
        first: { value: "one" },
        duplicate: { value: "a", multiValue: [{ value: "a" }, { value: "b" }] },
      },
      headers: {
        host: { value: host },
        authorization: { value: "Bearer test-only" },
        "x-odie-preview-host": { value: "attacker.invalid" },
      },
      cookies: { session: { value: "test-cookie" } },
    },
  };
}

test("viewer Function maps one label and preserves request data", () => {
  const event = viewerRequest("Demo.previews.example");
  const originalQuery = structuredClone(event.request.querystring);
  const originalCookies = structuredClone(event.request.cookies);
  const result = previewHandler(event) as typeof event.request;

  assert.equal(
    result.uri,
    "/gatekeeper/sessions/application-preview/demo/nested/file.txt",
  );
  assert.equal(
    result.headers["x-odie-preview-host"].value,
    "demo.previews.example",
  );
  assert.equal(result.headers.authorization.value, "Bearer test-only");
  assert.deepEqual(result.querystring, originalQuery);
  assert.deepEqual(result.cookies, originalCookies);
  assert.equal(result.method, "POST");
});

test("viewer Function accepts boundary labels and preserves root/encoded URIs", () => {
  const longestLabel = `a${"b".repeat(61)}c`;
  const longest = previewHandler(
    viewerRequest(`${longestLabel}.previews.example`, "/"),
  ) as { uri: string };
  assert.equal(
    longest.uri,
    `/gatekeeper/sessions/application-preview/${longestLabel}/`,
  );

  const encoded = previewHandler(
    viewerRequest("demo.previews.example", "/a%2Fb/%E2%9C%93"),
  ) as { uri: string };
  assert.equal(
    encoded.uri,
    "/gatekeeper/sessions/application-preview/demo/a%2Fb/%E2%9C%93",
  );
});

test("viewer Function rejects non-wildcard and invalid labels generically", () => {
  const invalidHosts = [
    "d111111abcdef8.cloudfront.net",
    "previews.example",
    ".previews.example",
    "a.b.previews.example",
    "-demo.previews.example",
    "demo-.previews.example",
    "under_score.previews.example",
    "demo.previews.example.",
    "demo.previews.example:443",
    `${"a".repeat(64)}.previews.example`,
  ];

  for (const host of invalidHosts) {
    const result = previewHandler(viewerRequest(host)) as {
      statusCode: number;
      statusDescription: string;
      headers: unknown;
    };
    assert.equal(result.statusCode, 400);
    assert.equal(result.statusDescription, "Bad Request");
    assert.equal(JSON.stringify(result).includes(host), false);
    assert.equal(
      JSON.stringify(result.headers),
      JSON.stringify({ "cache-control": { value: "no-store" } }),
    );
  }
});

test("template has the required forwarding, TLS, DNS, and origin contract", () => {
  assert.match(template, /PreviewDomain:\n\s+Type: String/);
  assert.match(template, /PreviewHostedZoneId:\n\s+Type: String/);
  assert.match(template, /DomainName: !Sub "\*\.\$\{PreviewDomain\}"/);
  assert.match(template, /HostedZoneId: !Ref PreviewHostedZoneId/);
  assert.doesNotMatch(template, /sessions\.dev-unison\.totango\.com/);
  assert.doesNotMatch(template, /HostedZoneId: Z063/);
  assert.match(template, /DomainName: odie-os-gk-sessions\.odie-os\.workers\.dev/);
  assert.match(template, /OriginProtocolPolicy: https-only/);
  assert.match(template, /OriginSSLProtocols:\n\s+- TLSv1\.2/);
  assert.match(template, /OriginReadTimeout: 120/);
  assert.match(template, /HeaderName: X-Odie-Preview-Ingress/);
  assert.match(template, /HeaderValue: !Ref PreviewIngressSecret/);
  assert.match(template, /PreviewIngressSecret:\n\s+Type: String\n\s+NoEcho: true/);
  assert.match(template, /MinLength: 64/);
  assert.match(template, /MaxLength: 64/);
  assert.equal(template.includes('AllowedPattern: "^[0-9a-f]{64}$"'), true);
  assert.match(template, /var suffix = '\.\$\{PreviewDomain\}';/);
  assert.match(template, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);
  assert.match(template, /OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac/);
  assert.match(template, /AllowedMethods:\n(?:\s+- (?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)\n){7}/);
  assert.match(template, /Compress: false/);
  assert.match(template, /MinimumProtocolVersion: TLSv1\.2_2021/);
  assert.match(template, /RequireUsEast1:/);
  assert.match(template, /!Ref AWS::Region/);
  assert.match(template, /Type: A\n/);
  assert.match(template, /Type: AAAA\n/);
  assert.doesNotMatch(template, /ResponseCompletionTimeout:/);
});

test("preview domain parameter has no insecure default and rejects Totango", () => {
  const parameterBlock = template.slice(
    template.indexOf("  PreviewDomain:"),
    template.indexOf("  PreviewHostedZoneId:"),
  );
  const match = parameterBlock.match(/AllowedPattern: '([^']+)'/);
  assert.ok(match);
  const pattern = new RegExp(match[1]);
  assert.equal(pattern.test("isolated-previews.example"), true);
  assert.equal(pattern.test("totango.com"), false);
  assert.equal(pattern.test("previews.totango.com"), false);
  assert.equal(pattern.test("*.isolated-previews.example"), false);
  assert.equal(parameterBlock.includes("    Default:"), false);
});

test("template cannot persist bearer-bearing request logs", () => {
  assert.doesNotMatch(template, /^\s+Logging:/m);
  assert.doesNotMatch(template, /RealtimeLogConfigArn:/);
  assert.doesNotMatch(template, /WebACLId:/);
  assert.doesNotMatch(template, /AWS::S3::Bucket/);
  assert.doesNotMatch(template, /console\.log/);
  assert.doesNotMatch(template, /^\s+AccessLog/m);
});


test("operations scripts are executable Bash 3-compatible and redact config", () => {
  const scriptNames = [
    "prepare-application-preview-change-set.sh",
    "execute-application-preview-change-set.sh",
    "inspect-application-preview-distribution.sh",
    "smoke-test-application-preview.sh",
  ];
  for (const name of scriptNames) {
    const path = join(repositoryRoot, "infra", name);
    assert.equal(statSync(path).mode & 0o111, 0o111);
    const syntax = spawnSync("/bin/bash", ["-n", path], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.match(
      readFileSync(path, "utf8"),
      /^#!\/bin\/bash\nset \+x\nset -euo pipefail/,
    );
  }

  const prepare = readFileSync(
    join(repositoryRoot, "infra", "prepare-application-preview-change-set.sh"),
    "utf8",
  );
  assert.match(prepare, /SECURITY-APPROVED:/);
  assert.match(prepare, /DARK-WORKER-VERIFIED:/);
  assert.match(prepare, /globally nonreused label and tombstone non-revival/);
  assert.match(prepare, /537124952465/);
  assert.match(prepare, /Hosted-zone name must equal or be a DNS ancestor/);
  assert.match(prepare, /--stage LIVE/);
  assert.match(prepare, /--stage DEVELOPMENT/);
  assert.match(prepare, /Domain or hosted-zone changes are forbidden/);
  assert.equal(prepare.includes('^[0-9a-f]{64}$'), true);
  assert.match(prepare, /ValidationError\)\.\*does not exist/);
  assert.match(prepare, /didn't contain changes/);

  const scriptArguments: Record<string, string[]> = {
    "prepare-application-preview-change-set.sh": [
      "previews.example",
      "Z123EXAMPLE",
      "abcdef1234567",
    ],
    "execute-application-preview-change-set.sh": [
      "preview-ingress-20260825T120000Z",
    ],
    "inspect-application-preview-distribution.sh": [],
    "smoke-test-application-preview.sh": [
      "previews.example",
      "reviewed-marker",
    ],
  };
  for (const [name, arguments_] of Object.entries(scriptArguments)) {
    const result = spawnSync(join(repositoryRoot, "infra", name), arguments_, {
      encoding: "utf8",
      env: {
        ...process.env,
        AWS_CLI_HISTORY: "enabled",
        PATH: "/usr/bin:/bin",
      },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /AWS CLI history must be disabled/);
  }

  const inspect = readFileSync(
    join(repositoryRoot, "infra", "inspect-application-preview-distribution.sh"),
    "utf8",
  );
  const queryLine = inspect.split("\n").find((line) => line.includes("--query 'DistributionConfig"));
  assert.ok(queryLine);
  assert.doesNotMatch(queryLine, /HeaderValue/);
  assert.match(queryLine, /HeaderName/);
  assert.match(queryLine, /DefaultCacheBehavior\.RealtimeLogConfigArn/);
  assert.match(queryLine, /CacheBehaviors\.Items/);
  assert.match(queryLine, /OrderedRealtimeLogAssociationCount/);
  assert.match(inspect, /537124952465/);
  assert.match(inspect, /assert_cli_history_disabled/);

  const smoke = readFileSync(
    join(repositoryRoot, "infra", "smoke-test-application-preview.sh"),
    "utf8",
  );
  assert.match(smoke, /age is not None/);
  assert.match(smoke, /miss from cloudfront/);
  assert.match(smoke, /status != 200/);
  assert.match(smoke, /expected_marker not in body/);
  assert.match(smoke, /reviewed-nonsecret-body-marker/);
  assert.match(smoke, /status != 404/);
  assert.doesNotMatch(smoke, /except Exception as/);
});

test("template never outputs the ingress secret", () => {
  const outputs = template.slice(template.indexOf("\nOutputs:"));
  assert.doesNotMatch(outputs, /PreviewIngressSecret/);
  assert.doesNotMatch(outputs, /X-Odie-Preview-Ingress/);
});
