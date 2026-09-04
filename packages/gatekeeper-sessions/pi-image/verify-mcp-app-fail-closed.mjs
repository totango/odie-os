import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageRoot = "/opt/odie-pi/node_modules/pi-mcp-adapter";
const visibilityModule = await import(`${packageRoot}/ui-tool-visibility.ts`);
const visibility = visibilityModule.isUiToolCallableByApp
  ? visibilityModule : visibilityModule.default;
assert.equal(
  visibility.isUiToolCallableByApp(["model"]),
  false,
  "pi-mcp-adapter must reject model-only tools from iframe apps",
);

// The package has no public hook that carries an iframe resource/binding into MCP request headers.
// Pin the reviewed dispatch ordering too: the trusted host visibility guard must run before the
// first client.callTool dispatch. This image-build canary reads the exact installed pinned source.
const uiServer = await readFile(`${packageRoot}/ui-server.ts`, "utf8");
const guard = uiServer.indexOf("if (!isUiToolCallableByApp(uiVisibility))");
const dispatch = uiServer.indexOf("connection.client.callTool");
assert.ok(guard >= 0, "pi-mcp-adapter iframe visibility guard is missing");
assert.ok(dispatch > guard, "pi-mcp-adapter dispatch occurs before the iframe visibility guard");
