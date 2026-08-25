# Native coding-session image canary

This directory contains the Odie-owned, one-shot native Sandbox SDK canary for an unpromoted
coding-session image. The manual `Publish coding session candidate image` workflow deploys a
separate Worker, Durable Object namespace, and standard-3 container application. It does not read
or change a production sessions Wrangler file and it does not give the sandbox repository, GitHub,
model, Workshop, or AWS credentials.

The Worker destroys the sandbox and proves the SDK's non-waking process and terminal lookups are
empty. The independent `cleanup` job then deletes both control-plane resources: the exact named
container application by UUID and the exact Worker service. `wrangler delete` alone is not enough;
it does not delete the container application.

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
seconds. No later stage, process output or readiness wait, admitted operation,
`OperationInterruptedError`, `RPCTransportError`, other class, or other status is retried.

## Force-cancel residual and manual cleanup

A failed or timed-out canary still reaches the independent `always()` cleanup job. GitHub can,
however, cancel the whole workflow before any cleanup job starts, and a runner can be lost. There is
no broad scheduled janitor because deleting by prefix without trusted age/run provenance could race
a live canary.

Use **Re-run failed jobs** to retry a failed canary or cleanup. A retried canary job starts from
its deploy step, so it recreates the exact stable run-scoped Worker and application after cleanup;
the immutable candidate artifact remains attached to the same logical workflow run. A retried
cleanup job targets the same exact names. **Re-run all jobs** intentionally fails when publish sees
the existing immutable commit tag; use the failed-job rerun or the exact manual cleanup below
instead.

For a force-cancelled run, take its numeric run ID from the Actions page. The stable resource identity uses only the numeric GitHub run ID, so rerunning failed jobs targets
the same resources and artifact. Derive only:

```text
WORKER=odie-coding-canary-<run-id>
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

Run the paginated helper again and require `{"applicationId":null}`. Also GET
`/accounts/<account-id>/workers/services/$WORKER` with the API response body discarded and require
HTTP 404. Never paste or print the Cloudflare token. Do not delete the candidate registry image; the
immutable image is the artifact being evaluated for later, separately reviewed promotion.
