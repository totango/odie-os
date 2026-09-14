import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "jsonc-parser";

const config = (path: string) => parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("production request-build policy is finite and bound to reviewed deployment evidence", () => {
  const sessions = config("packages/gatekeeper-sessions/wrangler.odie-os-production.jsonc");
  const backend = config("packages/workshop-backend/wrangler.odie-os-production.jsonc");
  const jarvis = config("packages/gatekeeper-jarvis/wrangler.odie-os-production.jsonc");
  const policy = JSON.parse(sessions.vars.REQUEST_BUILD_POLICY);
  assert.deepEqual(policy, {
    version: "auto-build-2026-09-14-v1",
    runtimeVersion: "0.85.1",
    model: "gpt-5.6-sol",
    dependencyHosts: ["registry.npmjs.org"],
    wallTimeMs: 3_600_000,
    modelCalls: 1_000,
    spendMicros: 1_000_000_000,
    callChargeMicros: 5_000_000,
    modelInputBytes: 512 * 1024,
    modelOutputTokens: 16_000,
    outputBytes: 8 * 1024 * 1024,
    diffBytes: 1024 * 1024,
    diffFiles: 100,
    concurrency: 1,
  });

  const evidence = JSON.parse(backend.vars.REQUEST_BUILD_DEPLOYMENT_EVIDENCE);
  const publicationModule = new URL("../packages/workshop-shared/src/request-build-publication.ts", import.meta.url).href;
  const policyHash = execFileSync(process.execPath, ["--input-type=module", "--eval",
    `import { buildHash, canonicalBuildJson } from ${JSON.stringify(publicationModule)}; console.log(await buildHash(canonicalBuildJson(${JSON.stringify(policy)})));`],
  {encoding: "utf8"}).trim();
  assert.equal(evidence.policyHash, policyHash);
  assert.equal(evidence.image, sessions.containers.find((entry: {class_name: string}) => entry.class_name === "RequestBuildSandbox").image);
  assert.deepEqual(evidence.pricing, {
    model: policy.model,
    callChargeMicros: policy.callChargeMicros,
    spendMicros: policy.spendMicros,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  });
  assert.deepEqual({repository: evidence.repository, baseBranch: evidence.baseBranch}, {repository: "totango/odie-os", baseBranch: "main"});

  assert.deepEqual(JSON.parse(backend.vars.REQUEST_BUILD_PUBLICATION_POLICY), {
    version: "auto-build-2026-09-14-v1",
    allowedPaths: ["packages/", "docs/"],
    changedLines: 5_000,
    textBytes: 512 * 1024,
  });
  assert.equal(backend.vars.REQUEST_BUILD_NOTIFIER_GENERATION, jarvis.vars.REQUEST_BUILD_NOTIFIER_GENERATION);
  assert.equal(jarvis.vars.REQUEST_BUILD_SLACK_TOKEN, undefined);
});
