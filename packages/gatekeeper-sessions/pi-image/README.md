# Coding-session image validation

`test-image-network-none.sh <image-ref>` performs two local, bounded checks against a built amd64
image:

1. It boots the image's normal `/container-server/sandbox` entrypoint read-only with no network or
   Linux capabilities, then requires the container server startup event and a local TCP response.
2. It runs the host-controlled `smoke-image.sh` read-only with no network, bounded CPU, memory, PIDs,
   and time. This verifies the complete pinned tool contract, both offline pnpm versions, login-shell
   resolution, the Prime kernel, the offline browser editor, and the local real-binary smoke matrix.

The real-binary matrix creates disposable files under the smoke temp directory and starts a loopback-only
fake model/MCP endpoint inside the network-none container. It does not talk to the public internet. The
current deterministic coverage is:

- **OpenCode**: runs the shipped `opencode run` binary against a local OpenAI-compatible fake provider,
  observes the real tool catalog the CLI sends to the model, drives a read tool call, an edit/write tool
  call, and a shell/command tool call, verifies the fixture file changed from `alpha` to `beta`, verifies
  the command marker, and requires the OpenCode MCP client to call `tools/list` on the fake Workshop MCP
  endpoint.
- **Pi**: runs the shipped `pi` binary help path, verifies the Odie Pi runtime extension can be loaded by
  the same Jiti loader baked into the image, verifies the `pi-mcp-adapter` import path, and runs a direct
  MCP lifecycle probe against the fake Workshop endpoint. The probe does not exercise Pi's MCP client.
  The smoke intentionally does not claim a prompt-driven Pi tool loop until the installed CLI exposes a
  stable non-interactive entrypoint that can be driven without TUI timing assumptions.
- **Prime Agent**: runs the shipped `prime-agent` binary version check and the shipped Prime kernel's
  IPython entrypoint. The kernel-environment smoke imports `rlm.mcp`, reads and edits a fixture file,
  runs a local shell assertion/marker command, and makes a direct HTTP `tools/list` request to the fake
  Workshop MCP endpoint. This does not exercise Prime Agent's own tool bridge or a prompt-driven loop.

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
