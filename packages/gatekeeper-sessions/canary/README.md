# Native coding-session image canary

This directory contains the Odie-owned, one-shot native Sandbox SDK canary for an unpromoted
coding-session image. The manual `Publish coding session candidate image` workflow deploys one
isolated Worker, Durable Object namespace, and container application for each native instance tier:
`standard-1`, `standard-2`, `standard-3`, and `standard-4`. The matrix runs serially with
`max-parallel: 1` to limit conservative account capacity. It does not read or change a production
sessions Wrangler file and it does not give the sandbox repository, GitHub, model, Workshop, or AWS
credentials.

Each Worker destroys its sandbox and proves the SDK's non-waking process and terminal lookups are
empty. An independent, serial `cleanup` matrix then deletes each exact tier's control-plane
resources: the exact named container application by UUID and the exact Worker service. `wrangler
delete` alone is not enough; it does not delete the container application. Only after all four
canaries and all four cleanup jobs succeed does the workflow validate the attempt-qualified tier
receipts and publish one all-tier receipt. Receipts from failed-job reruns must agree exactly; the
aggregate selects the highest run attempt for each tier.

A failed invocation returns only `{ "ok": false, "failureStage": "<closed-stage>" }`. The stage is
one of `node`, `javascript`, `typescript`, `terminal`, `code-server`, `cleanup`, or `lifecycle`.
Caught messages, sandbox output, resource IDs, and other untrusted details are never returned or
printed by the workflow. Internal stage errors retain their causes for focused tests and debugging.

A newly deployed workers.dev route or installed `CANARY_TOKEN` can briefly lag at the public edge.
The workflow retries only exact HTTP 404 or 401 responses, at most six attempts with five seconds
between attempts. Both happen before the Worker reaches the one-shot claim or any Sandbox call, so
these retries cannot duplicate canary work. Transport errors, malformed responses, and every other
HTTP status fail without retry.

The claimed canary also handles native container readiness at the smallest safe boundary. Only the
initial Node `sandbox.exec()` retries `ContainerUnavailableError`, which means the operation was not
admitted. It makes at most six total attempts inside a five-minute lifecycle deadline. Two exact
candidate attempts each exhausted the former three-attempt limit at the Node stage; the larger bound
can distinguish longer cold readiness from persistent failure. A valid non-negative integer
`retryAfterMs` is used up to 10 seconds; otherwise fallback waits grow from one second and cap at 10
seconds. If all attempts remain pre-admission, the closed response reports `lifecycle`; `node` is
reserved for a process that was admitted but failed its output or runtime assertions. No later stage,
process output or readiness wait, admitted operation, `OperationInterruptedError`,
`RPCTransportError`, other class, or other status is retried. The caller allows 10 minutes so the
five-minute run plus both bounded destroy/verify passes and settlement can return its closed result.

## Force-cancel residual and manual cleanup

A failed or timed-out canary still reaches the independent `always()` cleanup matrix. GitHub can,
however, cancel the whole workflow before cleanup starts, and a runner can be lost. There is no
broad scheduled janitor because deleting by prefix without trusted age/run provenance could race a
live canary.

Use **Re-run failed jobs** to retry a failed canary or cleanup. A retried canary recreates the exact
stable run-and-tier-scoped Worker and application after cleanup; its receipt is qualified by the
new run attempt. The immutable candidate artifact remains attached to the same logical workflow
run. **Re-run all jobs** intentionally fails when publish sees the existing immutable commit tag.

For a force-cancelled run, take its canonical numeric run ID from the Actions page. For each tier in
`standard-1` through `standard-4`, derive only:

```text
WORKER=odie-coding-canary-<run-id>-<tier>
APPLICATION=${WORKER}-container
```

Check out the exact workflow SHA and install the frozen lockfile. With the Odie Cloudflare account
selected, use the reviewed helper to walk every applications REST page, fail on duplicates or
malformed pagination, and return only the exact-name UUID:

```sh
node scripts/coding-session-canary-applications.mjs \
  --name "$APPLICATION" --out /tmp/exact-canary-application.json
pnpm exec wrangler containers delete <the-exact-returned-application-uuid>
pnpm exec wrangler delete "$WORKER" --force
```

Repeat this for every tier. Run the paginated helper again and require
`{"applicationId":null}`. Also GET `/accounts/<account-id>/workers/services/$WORKER` with the API
response body discarded and require HTTP 404. Never paste or print the Cloudflare token. Do not
delete the candidate registry image; the immutable image is evaluated for later, separately
reviewed promotion.
