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

wait_for_http() {
  local url="$1"
  local log_file="$2"
  for _ in $(seq 1 80); do
    if curl --fail --silent --output /dev/null "$url"; then
      return 0
    fi
    sleep 0.25
  done
  [[ ! -f "$log_file" ]] || tail -n 80 "$log_file" >&2
  return 1
}

[[ "$(node --version)" == "v${NODE_VERSION}" ]] || fail "unexpected Node version"
agentic_pnpm_version="${PNPM_PACKAGE_MANAGER#pnpm@}"
agentic_pnpm_version="${agentic_pnpm_version%%+*}"
repository_pnpm_version="${REPOSITORY_PNPM_PACKAGE_MANAGER#pnpm@}"
repository_pnpm_version="${repository_pnpm_version%%+*}"
[[ "$(pnpm --version)" == "${agentic_pnpm_version}" ]] || fail "unexpected default pnpm version"
sandbox_process_path="/usr/local/bin:/bin:/usr/bin"
for command in node npm npx corepack pnpm pnpx; do
  [[ "$(readlink "/usr/local/bin/$command")" == "/opt/node/bin/$command" ]] || fail "Sandbox process PATH is not pinned for $command"
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
fake_endpoint_pid=""
cleanup() {
  if [[ -n "$editor_pid" ]] && kill -0 "$editor_pid" 2>/dev/null; then
    kill "$editor_pid" 2>/dev/null || true
    wait "$editor_pid" 2>/dev/null || true
  fi
  if [[ -n "$fake_endpoint_pid" ]] && kill -0 "$fake_endpoint_pid" 2>/dev/null; then
    kill "$fake_endpoint_pid" 2>/dev/null || true
    wait "$fake_endpoint_pid" 2>/dev/null || true
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

cat > "$temporary_root/fake-local-endpoints.mjs" <<'NODE'
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const logPath = process.argv[2];
const workspace = process.argv[3];
let chatStep = 0;

function log(event, detail = {}) {
  appendFileSync(logPath, `${JSON.stringify({ event, ...detail })}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendChat(response, body) {
  const completion = chatCompletion(body);
  if (!body.stream) {
    send(response, 200, completion);
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  const choice = completion.choices[0];
  const call = choice.message.tool_calls?.[0];
  if (call) {
    response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
  } else {
    response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: choice.message.content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function sendResponses(response, body) {
  const completion = chatCompletion(body);
  const choice = completion.choices[0];
  const call = choice.message.tool_calls?.[0];
  const responseId = completion.id.replace("chatcmpl", "resp");
  const created = Math.floor(Date.now() / 1000);
  const events = [];
  let output;
  if (call) {
    const item = {
      id: `fc_${call.id}`,
      type: "function_call",
      status: "completed",
      arguments: call.function.arguments,
      call_id: call.id,
      name: call.function.name,
    };
    events.push(
      { type: "response.output_item.added", response_id: responseId, output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", response_id: responseId, item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.function_call_arguments.done", response_id: responseId, item_id: item.id, output_index: 0, arguments: item.arguments },
      { type: "response.output_item.done", response_id: responseId, output_index: 0, item },
    );
    output = [item];
  } else {
    const text = choice.message.content;
    const item = { id: "msg_smoke_final", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
    events.push(
      { type: "response.output_item.added", response_id: responseId, output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, text },
      { type: "response.content_part.done", response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      { type: "response.output_item.done", response_id: responseId, output_index: 0, item },
    );
    output = [item];
  }
  const responseObject = {
    id: responseId,
    object: "response",
    created_at: created,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: body.model ?? "smoke-model",
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: body.tools ?? [],
    top_p: 1,
    truncation: "disabled",
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
    metadata: {},
  };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
  response.write(`data: ${JSON.stringify({ type: "response.created", response: { ...responseObject, status: "in_progress", output: [] } })}\n\n`);
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.write(`data: ${JSON.stringify({ type: "response.completed", response: responseObject })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolName(tools, pattern) {
  return tools.find(tool => pattern.test(tool?.function?.name ?? tool?.name ?? ""))?.function?.name
    ?? tools.find(tool => pattern.test(tool?.name ?? ""))?.name;
}

function parametersFor(tools, name) {
  const tool = tools.find(candidate => (candidate?.function?.name ?? candidate?.name) === name);
  return tool?.function?.parameters ?? tool?.parameters ?? tool?.input_schema ?? tool?.inputSchema ?? {};
}

function argumentForProperty(property, schema, purpose) {
  const key = property.toLowerCase();
  if (schema?.type === "number" || schema?.type === "integer") return 1;
  if (schema?.type === "boolean") return false;
  if (schema?.type === "array") return [];
  if (schema?.type === "object") return {};
  if (/path|file/.test(key)) return `${workspace}/subject.txt`;
  if (/line|offset|limit|count/.test(key)) return 1;
  if (/old/.test(key)) return "alpha";
  if (/new|replace|content|text/.test(key)) return "beta";
  if (/command|cmd|script/.test(key)) return `grep -q beta ${workspace}/subject.txt && printf opencode-command-ok > ${workspace}/opencode-command.txt`;
  if (/description/.test(key)) return `smoke ${purpose}`;
  if (/timeout/.test(key)) return 5;
  return `smoke-${purpose}`;
}

function argumentsFor(tools, name, purpose) {
  const parameters = parametersFor(tools, name);
  const properties = parameters?.properties ?? {};
  const required = Array.isArray(parameters?.required) ? parameters.required : Object.keys(properties);
  const args = {};
  for (const property of required) args[property] = argumentForProperty(property, properties[property], purpose);
  for (const property of Object.keys(properties)) {
    if (property in args) continue;
    if (/path|file|old|new|replace|content|text|command|cmd|script/.test(property.toLowerCase())) {
      args[property] = argumentForProperty(property, properties[property], purpose);
    }
  }
  if (Object.keys(args).length === 0) {
    if (purpose === "read") args.filePath = `${workspace}/subject.txt`;
    if (purpose === "edit") Object.assign(args, { filePath: `${workspace}/subject.txt`, oldString: "alpha", newString: "beta" });
    if (purpose === "command") args.command = `grep -q beta ${workspace}/subject.txt && printf opencode-command-ok > ${workspace}/opencode-command.txt`;
  }
  return args;
}

function chatCompletion(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length === 0) {
    return {
      id: "chatcmpl-smoke-metadata",
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "local smoke" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  const plan = [
    ["read", /(^|[_.-])(read|view|open)([_.-]|$)|file.*read/i],
    ["edit", /(^|[_.-])(edit|patch|write)([_.-]|$)|file.*write/i],
    ["command", /(^|[_.-])(bash|shell|run|exec|command)([_.-]|$)/i],
  ];
  while (chatStep < plan.length) {
    const [purpose, pattern] = plan[chatStep++];
    const name = toolName(tools, pattern);
    if (name) {
      log("fake-model.tool-call", { purpose, name });
      return {
        id: `chatcmpl-smoke-${chatStep}`,
        object: "chat.completion",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_smoke_${chatStep}`,
              type: "function",
              function: { name, arguments: JSON.stringify(argumentsFor(tools, name, purpose)) },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
    log("fake-model.tool-missing", { purpose, names: tools.map(tool => tool?.function?.name ?? tool?.name).filter(Boolean) });
  }
  return {
    id: "chatcmpl-smoke-final",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "local smoke complete" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { ok: true });
    return;
  }
  const raw = await readBody(request);
  const body = raw ? JSON.parse(raw) : {};
  log("request", { method: request.method, url: request.url, jsonrpc: body.method });
  if (request.url === "/mcp" && request.method === "POST") {
    if (body.method === "initialize") {
      send(response, 200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "odie-local-smoke", version: "0.0.0" } } }, { "MCP-Protocol-Version": "2025-03-26" });
      return;
    }
    if (body.method === "notifications/initialized") {
      response.writeHead(202, { "MCP-Protocol-Version": "2025-03-26" });
      response.end();
      return;
    }
    if (body.method === "tools/list") {
      send(response, 200, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "workshop_smoke_discovery", description: "Deterministic smoke-only Workshop MCP tool", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } }, { "MCP-Protocol-Version": "2025-03-26" });
      return;
    }
  }
  if ((request.url === "/v1/chat/completions" || request.url === "/chat/completions") && request.method === "POST") {
    sendChat(response, body);
    return;
  }
  if ((request.url === "/v1/responses" || request.url === "/responses") && request.method === "POST") {
    sendResponses(response, body);
    return;
  }
  if ((request.url === "/v1/models" || request.url === "/models") && request.method === "GET") {
    send(response, 200, { object: "list", data: [{ id: "smoke-model", object: "model", owned_by: "odie-smoke" }] });
    return;
  }
  log("unhandled", { method: request.method, url: request.url, body });
  send(response, 404, { error: { message: "unhandled smoke endpoint" } });
});

server.listen(11434, "127.0.0.1", () => {
  writeFileSync(`${workspace}/fake-endpoint-ready`, "ready\n");
  log("listening", { port: 11434 });
});
NODE

run_workshop_mcp_probe() {
  local label="$1"
  local response_file="$temporary_root/${label}-mcp-response.json"
  curl --fail --silent \
    --header 'content-type: application/json' \
    --header 'MCP-Protocol-Version: 2025-03-26' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"odie-smoke","version":"0.0.0"}}}' \
    http://127.0.0.1:11434/mcp >/dev/null
  curl --fail --silent \
    --header 'content-type: application/json' \
    --header 'MCP-Protocol-Version: 2025-03-26' \
    --data '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
    http://127.0.0.1:11434/mcp >/dev/null
  curl --fail --silent \
    --header 'content-type: application/json' \
    --header 'MCP-Protocol-Version: 2025-03-26' \
    --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    http://127.0.0.1:11434/mcp > "$response_file"
  jq --exit-status '.result.tools[] | select(.name == "workshop_smoke_discovery")' "$response_file" >/dev/null
}

node "$temporary_root/fake-local-endpoints.mjs" "$temporary_root/fake-endpoints.log" "$temporary_root/workspace" >"$temporary_root/fake-endpoints.stdout.log" 2>&1 &
fake_endpoint_pid="$!"
wait_for_http http://127.0.0.1:11434/health "$temporary_root/fake-endpoints.stdout.log" || fail "fake local endpoints did not become ready"

printf '%s\n' alpha > "$temporary_root/workspace/subject.txt"
cat > "$temporary_root/workspace/package.json" <<'JSON'
{"scripts":{"smoke":"test \"$(cat subject.txt)\" = beta"}}
JSON
mkdir -p "$temporary_root/workspace/.opencode"
cat > "$temporary_root/workspace/.opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/smoke-model",
  "enabled_providers": ["openai"],
  "provider": {
    "openai": {
      "name": "Local smoke model",
      "options": { "baseURL": "http://127.0.0.1:11434/v1", "apiKey": "synthetic" },
      "models": {
        "smoke-model": {
          "name": "Smoke Model",
          "tool_call": true,
          "limit": { "context": 4096, "output": 1024 }
        }
      }
    }
  },
  "mcp": {
    "workshop": { "type": "remote", "url": "http://127.0.0.1:11434/mcp", "oauth": false, "enabled": true }
  }
}
JSON

run_workshop_mcp_probe "opencode"
timeout 30s bash -lc "cd '$temporary_root/workspace' && opencode debug config >/dev/null" || fail "OpenCode rejected the local smoke configuration"
: > "$temporary_root/fake-endpoints.log"
timeout --signal=TERM --kill-after=5s 90s bash -lc \
  "cd '$temporary_root/workspace' && OPENCODE_DISABLE_TELEMETRY=1 opencode run --pure --auto --model openai/smoke-model 'Read subject.txt, replace alpha with beta, then run the local smoke check.'" \
  >"$temporary_root/opencode-run.log" 2>&1 || {
    tail -n 120 "$temporary_root/opencode-run.log" >&2
    tail -n 120 "$temporary_root/fake-endpoints.log" >&2
    fail "OpenCode local prompt-driven tool-loop smoke failed"
  }
if [[ "$(cat "$temporary_root/workspace/subject.txt")" != "beta" ]] || [[ ! -f "$temporary_root/workspace/opencode-command.txt" ]]; then
  tail -n 120 "$temporary_root/opencode-run.log" >&2
  tail -n 120 "$temporary_root/fake-endpoints.log" >&2
  fail "OpenCode did not complete the fixture edit and command"
fi
[[ "$(cat "$temporary_root/workspace/opencode-command.txt")" == "opencode-command-ok" ]] || fail "OpenCode command marker was incorrect"
grep --quiet '"event":"fake-model.tool-call".*"purpose":"read"' "$temporary_root/fake-endpoints.log" || fail "OpenCode did not receive a read tool call from the fake model"
grep --quiet '"event":"fake-model.tool-call".*"purpose":"edit"' "$temporary_root/fake-endpoints.log" || fail "OpenCode did not receive an edit tool call from the fake model"
grep --quiet '"event":"fake-model.tool-call".*"purpose":"command"' "$temporary_root/fake-endpoints.log" || fail "OpenCode did not receive a command tool call from the fake model"
grep --quiet '"jsonrpc":"tools/list"' "$temporary_root/fake-endpoints.log" || fail "OpenCode did not perform Workshop MCP discovery"

mkdir -p "$temporary_root/pi-config" "$temporary_root/prime-config"
cat > "$temporary_root/pi-config/odie-runtime.ts" <<'TS'
import { createMcpAdapter } from "/opt/odie-pi/node_modules/pi-mcp-adapter/index.ts";

export default function odieSmokeRuntime(pi) {
  pi.registerProvider("odie-smoke", {
    name: "Odie smoke provider",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "synthetic",
    api: "openai-compatible",
    models: [{ id: "smoke-model", name: "Smoke Model", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }],
  });
  createMcpAdapter({
    config: { mcpServers: { workshop: { url: "http://127.0.0.1:11434/mcp", auth: false, oauth: false, lifecycle: "eager", requestTimeoutMs: 5000 } }, settings: { hostConfigDiscovery: "off", scriptMode: false } },
  })(pi);
}
TS

timeout 30s node \
  --import /opt/odie-pi/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs \
  --eval "import('$temporary_root/pi-config/odie-runtime.ts').then((module) => { const extension = module.default?.default ?? module.default; if (typeof extension !== 'function') throw new Error('missing Pi extension default'); })" \
  >/dev/null
run_workshop_mcp_probe "pi"
timeout 30s pi --help >/dev/null || fail "Pi help smoke failed"

cat > "$temporary_root/prime-ipython-smoke.py" <<PY
from pathlib import Path
import json
import subprocess
import urllib.request
import rlm.mcp

workspace = Path(${temporary_root@Q}) / "workspace"
prime_file = workspace / "prime-subject.txt"
prime_file.write_text("alpha", encoding="utf-8")
assert prime_file.read_text(encoding="utf-8") == "alpha"
prime_file.write_text("beta", encoding="utf-8")
subprocess.run(["/bin/bash", "-lc", f"grep -q beta {prime_file} && printf prime-command-ok > {workspace / 'prime-command.txt'}"], check=True)
assert (workspace / "prime-command.txt").read_text(encoding="utf-8") == "prime-command-ok"
def mcp_request(payload):
    request = urllib.request.Request(
        "http://127.0.0.1:11434/mcp",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type":"application/json", "MCP-Protocol-Version":"2025-03-26"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        body = response.read()
        return json.loads(body.decode("utf-8")) if body else None

mcp_request({"jsonrpc":"2.0","id":19,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"odie-prime-smoke","version":"0.0.0"}}})
mcp_request({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})
payload = mcp_request({"jsonrpc":"2.0","id":20,"method":"tools/list","params":{}})
assert any(tool["name"] == "workshop_smoke_discovery" for tool in payload["result"]["tools"])
PY
PRIME_AGENT_KERNEL_PYTHON=/opt/odie-prime-agent/kernel-venv/bin/python \
  timeout 45s /opt/odie-prime-agent/kernel-venv/bin/python -m IPython "$temporary_root/prime-ipython-smoke.py" >/dev/null

printf 'real-binary local smoke matrix passed\n'

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
