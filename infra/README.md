# Application preview ingress proposal

This directory is an **undeployed plain-CloudFormation foundation**. It is not
SAM. Nothing here authorizes a deployment.

The old proposed hostname, `*.sessions.dev-unison.totango.com` in Route53 zone
`Z063214418XG77IQADPMR`, is retained only as rejected historical evidence. It is
not a template default or deploy input.

## Blocking browser-isolation requirement

Any user-authored preview under `*.totango.com` is forbidden. Such a preview is
same-site with trusted Totango production properties. Its JavaScript and forms
can make same-site requests, `SameSite=Lax` or `SameSite=Strict` is not a CSRF
boundary, and it can cookie-toss toward `.totango.com`. Adding only a nested
`sessions.dev-unison.totango.com` Public Suffix List (PSL) rule would not stop a
child from targeting broader ancestors. Rewriting `Set-Cookie` is also not a
sufficient browser security boundary.

`PreviewDomain` therefore has no default and rejects `totango.com` and its
descendants. Security must approve a dedicated registrable domain that:

- is used only for untrusted previews and has no trusted applications/cookies;
- has its exact apex live as a public/private suffix, making every capability
  hostname directly below that browser-enforced boundary;
- has independent reviewed evidence for both facts.

Do not query or modify the PSL repository from this project. Verify the live
browser-consumed rule externally and attach evidence to the security review.
The prepare script requires explicit attestations but those prompts are not a
substitute for the evidence.

The origin Worker is a second hard dependency and must land dark first. It must
reject missing/invalid `X-Odie-Preview-Ingress`, consume and strip both
`X-Odie-Preview-Ingress` and `X-Odie-Preview-Host` before application code, and
persist no host/path/capability/ingress-secret request data. Do not enable the
Worker or ingress until both dependencies are externally verified.

## Resources and request contract

`application-preview-ingress.yaml` takes the required, non-secret
`PreviewDomain` and `PreviewHostedZoneId` parameters. It creates:

- a DNS-validated us-east-1 ACM wildcard certificate;
- a CloudFront distribution and viewer-request CloudFront Function;
- wildcard Route53 A and AAAA aliases in the supplied public hosted zone.

A template Rule rejects every region except `us-east-1`.

For `https://<label>.<PreviewDomain>/<path>`, the Function canonicalizes the host
to lower case, requires exactly one valid DNS label, overwrites
`X-Odie-Preview-Host`, and maps the origin URI to
`/gatekeeper/sessions/application-preview/<label>/<path>`. Invalid hosts get a
generic non-echoing 400.

CloudFront adds `X-Odie-Preview-Ingress` from an exactly 64-character lower-case
hexadecimal `NoEcho` parameter. The origin is
`odie-os-gk-sessions.odie-os.workers.dev` over TLS 1.2. The managed
`AllViewerExceptHostHeader` policy forwards all viewer headers (including
Authorization and WebSocket handshake headers), cookies, and query strings,
while setting the correct origin Host. Every method is allowed. Managed
`CachingDisabled`, `Compress: false`, viewer `TLSv1.2_2021`, and a 120-second
origin read timeout are explicit. There is no response-completion timeout, so
SSE can stay open; the origin must flush SSE or WS heartbeat traffic every
30–60 seconds.

The preview label is a bearer capability. This template intentionally has no
CloudFront standard/real-time logs, WAF request logs, log bucket, or logging
association. Use only aggregate CloudFront/Function metrics without host, path,
query, cookie, or header dimensions. Do not add request logging without a
separate security review proving removal before persistence.

## Repository validation

Pin the external Python validator once in an approved tool environment; do not
make repository tests download an unpinned tool:

```sh
uv tool install 'cfn-lint==1.55.1'
cfn-lint infra/application-preview-ingress.yaml
node --test scripts/application-preview-ingress.test.ts
pnpm types:scripts
```

Read-only AWS validation, with no secret or resource creation:

```sh
export AWS_PROFILE=semantic-dev-rollout
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
aws sts get-caller-identity
aws cloudformation validate-template --region us-east-1 \
  --template-body file://infra/application-preview-ingress.yaml
```

The tests execute the extracted Function against a synthetic dedicated domain,
validate boundary cases, inspect the template contract, and forbid logging and
secret outputs.

## Preflight and reviewed deployment flow

This section is a future runbook, not deployment approval. The approved secret
manager workflow must use `openssl rand -hex 32` as its generation primitive
and capture its stdout directly, without displaying it in a terminal. Configure
the dark Worker from that manager. Do not commit, print, ticket, or pass the
value in argv.

Every executable script starts with `set +x`. Before any secret, capability, state
change, or raw distribution-config read, it fails if effective AWS CLI v2
`cli_history` is enabled through config or environment. AWS CLI history records
the request and raw response before JMESPath projection, so a query or safe argv
is not enough. Keep CLI debug disabled too.

The executable Bash 3-compatible prepare script validates the exact 64-character
format before AWS receives it. It checks effective profile/region, identity,
template, hosted-zone access, ACM/list permissions, current distribution and
Function counts in both DEVELOPMENT and LIVE, available CloudFront service
quotas, conflicting wildcard aliases/every RRSet at that owner, fixed Function
name conflicts in both stages, and stack existence. It asserts AWS account
`537124952465`, and it parses the hosted zone and fails unless it is public and
its normalized name equals or is a DNS ancestor of `PreviewDomain`. Security
and dark-Worker evidence is reconfirmed against the actual domain, zone,
PriceClass, and immutable deployed Worker SHA/version. The Worker evidence must
include permanent globally nonreused-label and tombstone non-revival tests. It treats only a confirmed CloudFormation
`ValidationError ... does not exist` as CREATE. AccessDenied/network failures
abort. An unchanged UPDATE is deleted as a clean no-op; every other failure
aborts. Ordinary UPDATE explicitly forbids changing domain or hosted zone;
that requires a separate migration plan. The parameter file is mode 0600 and removed immediately after change-set
creation.

```sh
export AWS_PROFILE=semantic-dev-rollout
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
infra/prepare-application-preview-change-set.sh \
  approved-preview.example Z123APPROVEDZONE 0123456789abcdef0123456789abcdef01234567
# For a non-rotation update only:
infra/prepare-application-preview-change-set.sh \
  approved-preview.example Z123APPROVEDZONE 0123456789abcdef0123456789abcdef01234567 \
  --use-previous-secret
```

The domain above is illustrative syntax, not an approved domain. Stop and
review the named change set. In a fresh approval terminal, re-export the three
AWS variables and pass only the non-secret change-set name:

```sh
infra/execute-application-preview-change-set.sh \
  preview-ingress-YYYYMMDDTHHMMSSZ
```

The execution script asserts account `537124952465`, re-reads and validates
change-set type/status, displays and requires exact reconfirmation of only the
nonsecret domain, zone, PriceClass, Worker version, and change-set name, uses the
correct CREATE/UPDATE waiter, waits for CloudFront
`Deployed`, and enables stack termination protection after CREATE. It never
continues after a failed command.

CloudFront Function name and stack name are fixed and under their limits. Before
execution, budget for CloudFront request/data transfer and Function invocation
charges. ACM has no additional charge and Route53 CloudFront alias queries have
no query charge; the existing hosted-zone fee remains. `PriceClass_100` is the
cost-limited default. Recheck current CloudFront quotas and pricing rather than
assuming historical defaults.

## Capability-safe inspection and smoke tests

`cloudfront:GetDistributionConfig` is secret-reading authority because the raw
response contains the custom origin `HeaderValue`. Never dump or save it. AWS
CLI history must be disabled because it records before query projection. Run
the inspection script only under a dedicated trusted role whose CloudFront
permission is exactly `cloudfront:GetDistributionConfig` on this distribution
ARN (plus the narrow STS/CloudFormation reads needed to assert account
`537124952465` and resolve the ID), never `cloudfront:*`. Limit who can assume
that role and protect its local process/stdout. The JMESPath projection is an
additional output guard, not the trust boundary: it emits only logging enabled,
empty WebACL/default-realtime fields, the ordered cache-behavior count and its
realtime-association count, and custom-header name/count. It fails if the
default behavior or any ordered behavior has a realtime-log ARN, or if another
safe-contract field differs:

```sh
infra/inspect-application-preview-distribution.sh
```

The basic HTTPS/cache/direct-origin smoke script starts with xtrace off, refuses
enabled AWS CLI history, reads a short-lived sacrificial label silently, and
sends it to Python on stdin—not history or argv. A reviewed nonsecret body marker
is a separate argument. It emits only generic network or TLS failures; requires
both sacrificial-preview responses to be exactly 200, no larger than 1 MiB,
contain that marker, have no `Age`, and report a CloudFront Miss; and requires
exact generic 404 from direct `workers.dev`. This prevents a wrong ingress
secret or cache-miss 404 from passing:

```sh
infra/smoke-test-application-preview.sh \
  approved-preview.example reviewed-nonsecret-marker
```

Revoke the sacrificial capability immediately. Use a dedicated capability-safe
harness—not CI logs or ordinary CLI argv—to test all methods, bodies,
Authorization, required headers, cookies, duplicate queries, encoded/root paths,
TLS 1.2/1.3 (and rejection of 1.0/1.1), A/AAAA, isolation between labels,
WebSockets with 30-second heartbeats, and five-minute SSE with gaps below 120
seconds. Direct-origin tests use no real ingress secret. Confirm aggregate
metrics populate and persisted Worker telemetry contains no sacrificial label.

## Rotation, rollback, and deletion

Zero-downtime rotation order is mandatory:

1. make the dark Worker accept old and new values;
2. make a reviewed stack UPDATE supplying new securely;
3. wait for stack completion and `distribution-deployed`, then probe;
4. remove old from the Worker.

Never revoke old first. To roll back a completed rotation, `UsePreviousValue`
is wrong because it now retains the **new** value. Re-supply the old value from
the approved secret manager through the same stdin/mode-0600 flow while the
Worker still accepts both.

CloudFormation automatically rolls back failed operations. If rollback stops,
inspect events, fix the cause, and only then use `continue-update-rollback`.
Roll back a successful bad template with a reviewed last-known-good change set.

Stack deletion is destructive: it removes wildcard DNS, the global distribution,
Function, and certificate, can take a long time, and terminates active previews.
Termination protection is enabled after CREATE. Break-glass deletion requires
explicit security/operations approval, draining previews, retaining required
aggregate incident evidence, disabling termination protection, issuing
`delete-stack`, and waiting for `stack-delete-complete`. Never use deletion as
an ordinary rollback.
