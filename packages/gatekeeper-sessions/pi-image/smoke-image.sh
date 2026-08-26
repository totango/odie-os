#!/bin/bash
set -euo pipefail

EXPECTED_EXTENSION_HASH="65e3a533e0df9f58a8f81ba5ac430cea826cae6eb507dccdc93498228783c068"

fail() {
  printf 'coding-session image smoke failed: %s\n' "$*" >&2
  exit 1
}

for variable in NODE_VERSION PNPM_PACKAGE_MANAGER REPOSITORY_PNPM_PACKAGE_MANAGER OPENCODE_VERSION PI_VERSION PI_MCP_ADAPTER_VERSION PRIME_AGENT_VERSION VALHALLA_VERSION CODE_SERVER_VERSION; do
  [[ -n "${!variable:-}" ]] || fail "missing exact version contract: $variable"
done

package_version() {
  node -p "require('$1/package.json').version"
}

[[ "$(node --version)" == "v${NODE_VERSION}" ]] || fail "unexpected Node version"
agentic_pnpm_version="${PNPM_PACKAGE_MANAGER#pnpm@}"
agentic_pnpm_version="${agentic_pnpm_version%%+*}"
repository_pnpm_version="${REPOSITORY_PNPM_PACKAGE_MANAGER#pnpm@}"
repository_pnpm_version="${repository_pnpm_version%%+*}"
[[ "$(pnpm --version)" == "${agentic_pnpm_version}" ]] || fail "unexpected default pnpm version"
sandbox_process_path="/usr/local/bin:/bin:/usr/bin"
for command in node npm npx corepack pnpm pnpx; do
  [[ -L "/usr/local/bin/$command" ]] || fail "Sandbox process PATH is not pinned for $command"
done
[[ "$(env PATH="$sandbox_process_path" sh -c 'command -v node')" == "/usr/local/bin/node" ]] || fail "Sandbox process Node is not canonical"
[[ "$(env PATH="$sandbox_process_path" node --version)" == "v${NODE_VERSION}" ]] || fail "Sandbox process Node version is not pinned"
[[ "$(env PATH="$sandbox_process_path" pnpm --version)" == "${agentic_pnpm_version}" ]] || fail "Sandbox process pnpm version is not pinned"
[[ "$(node -p 'process.arch')" == "x64" ]] || fail "unexpected Node architecture"
[[ "$(uname -m)" == "x86_64" ]] || fail "unexpected machine architecture"

login_shell_contract="[[ \"\$(command -v node)\" == \"/opt/node/bin/node\" ]] && [[ \"\$(command -v opencode)\" == \"/usr/local/bin/opencode\" ]] && [[ \"\$(node --version)\" == \"v\${NODE_VERSION}\" ]] && opencode --version >/dev/null"
bash -lc "$login_shell_contract" || fail "bash -lc tool resolution failed"
bash --login -c "$login_shell_contract" || fail "login-shell tool resolution failed"
[[ "$(package_version /usr/local/lib/node_modules/opencode-ai)" == "${OPENCODE_VERSION}" ]] || fail "unexpected OpenCode version"
[[ "$(package_version /opt/odie-pi/node_modules/@earendil-works/pi-coding-agent)" == "${PI_VERSION}" ]] || fail "unexpected Pi version"
[[ "$(package_version /opt/odie-pi/node_modules/pi-mcp-adapter)" == "${PI_MCP_ADAPTER_VERSION}" ]] || fail "unexpected Pi MCP adapter version"
[[ "$(package_version /opt/odie-pi/node_modules/prime-agent)" == "${PRIME_AGENT_VERSION}" ]] || fail "unexpected Prime Agent version"
[[ "$(package_version /opt/odie-pi/node_modules/@howlerops/valhalla)" == "${VALHALLA_VERSION}" ]] || fail "unexpected Valhalla version"
[[ "$(package_version /opt/odie-code-server)" == "${CODE_SERVER_VERSION}" ]] || fail "unexpected code-server version"

for command in ps pgrep pkill setsid stdbuf timeout tail tee flock du df truncate jq curl git bash tini rg; do
  command -v "$command" >/dev/null || fail "missing helper: $command"
done

for path in /root/.npm /root/.cache/uv /root/.ipython /root/.config/code-server /root/.local/share/code-server /tmp/jiti; do
  [[ ! -e "$path" ]] || fail "image contains build state: $path"
done

# Corepack must use both image-baked pnpm packages while the container has no network.
temporary_root="$(mktemp -d)"
editor_pid=""
cleanup() {
  if [[ -n "$editor_pid" ]] && kill -0 "$editor_pid" 2>/dev/null; then
    kill "$editor_pid" 2>/dev/null || true
    wait "$editor_pid" 2>/dev/null || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT
mkdir -p "$HOME" "$temporary_root/agentic" "$temporary_root/repository" "$temporary_root/workspace" "$temporary_root/editor-data"
printf '%s\n' 'bind-addr: 127.0.0.1:13337' 'auth: none' 'cert: false' > "$temporary_root/code-server-config.yaml"
printf '{"packageManager":"%s"}\n' "$PNPM_PACKAGE_MANAGER" > "$temporary_root/agentic/package.json"
printf '{"packageManager":"%s"}\n' "$REPOSITORY_PNPM_PACKAGE_MANAGER" > "$temporary_root/repository/package.json"
[[ "$(cd "$temporary_root/agentic" && COREPACK_ENABLE_NETWORK=0 pnpm --version)" == "${agentic_pnpm_version}" ]] || fail "offline Agentic pnpm activation failed"
[[ "$(cd "$temporary_root/repository" && COREPACK_ENABLE_NETWORK=0 pnpm --version)" == "${repository_pnpm_version}" ]] || fail "offline repository pnpm activation failed"

timeout 30s opencode --version >/dev/null
timeout 30s pi --version >/dev/null
timeout 30s prime-agent --version >/dev/null
/opt/odie-prime-agent/kernel-venv/bin/python -m IPython -c 'import ipykernel, rlm, rlm.mcp; assert 6 * 7 == 42' >/dev/null
[[ "$(code-server --config "$temporary_root/code-server-config.yaml" --user-data-dir "$temporary_root/editor-data" --extensions-dir /opt/odie-code-server/extensions --list-extensions --show-versions | sha256sum | cut -d ' ' -f1)" == "$EXPECTED_EXTENSION_HASH" ]] || fail "unexpected editor extensions"

EXTENSIONS_GALLERY='{}' code-server \
  --config "$temporary_root/code-server-config.yaml" \
  --auth none \
  --disable-update-check \
  --bind-addr 127.0.0.1:13337 \
  --user-data-dir "$temporary_root/editor-data" \
  --extensions-dir /opt/odie-code-server/extensions \
  "$temporary_root/workspace" >"$temporary_root/code-server.log" 2>&1 &
editor_pid="$!"
for _ in $(seq 1 60); do
  if curl --fail --silent --output /dev/null http://127.0.0.1:13337/; then
    break
  fi
  if ! kill -0 "$editor_pid" 2>/dev/null; then
    cat "$temporary_root/code-server.log" >&2
    fail "code-server exited before readiness"
  fi
  sleep 0.25
done
curl --fail --silent --output /dev/null http://127.0.0.1:13337/ || {
  cat "$temporary_root/code-server.log" >&2
  fail "code-server did not become ready"
}

printf 'coding-session image smoke passed\n'
