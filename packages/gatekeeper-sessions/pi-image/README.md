# Coding-session image validation

`test-image-network-none.sh <image-ref>` performs two local, bounded checks against a built amd64
image:

1. It boots the image's normal `/container-server/sandbox` entrypoint read-only with no network or
   Linux capabilities, then requires the container server startup event and a local TCP response.
2. It runs the host-controlled `smoke-image.sh` read-only with no network, bounded CPU, memory, PIDs,
   and time. This verifies the complete pinned tool contract, both offline pnpm versions, login-shell
   resolution, the Prime kernel, and the offline browser editor.

The local boot check does not exercise the Worker/DO path in `@cloudflare/sandbox`. That SDK obtains
process, interpreter, and terminal handles through a deployed Cloudflare Container binding; it has no
supported direct-local client for `/container-server/sandbox`.

The publish workflow may mirror a successfully checked GHCR image to the Cloudflare registry only as
an **unpromoted candidate**. Before any production Wrangler configuration PR uses that digest, a
separate canary Worker and Durable Object bound to the candidate must prove all of the following:

- `exec()` reports the exact Node version and can collect process output;
- JavaScript and TypeScript interpreter execution succeeds;
- a terminal can start, accept input, and terminate;
- the browser editor starts and becomes ready;
- processes, terminals, editor state, and the sandbox generation clean up successfully.

A Cloudflare candidate digest artifact is a transport receipt, not evidence of this native canary and
not authorization to deploy it. Keep the previous production digest until the canary passes.

Commit tags are intentionally fail-closed and are never reused. If a run pushes its exact commit tag
to GHCR and then fails, do not rerun it blindly. A package administrator must first verify that the
failed run never promoted the recorded digest and that no checked-in Wrangler configuration refers
to it, then delete that exact unpromoted package version through the GHCR package administration
UI or API. Only then may the same immutable commit be rerun. Never delete a prior production digest
or a version referenced by another tag.
