import { expect, it } from "vitest";

import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { classifyTool } from "../src/tools.js";

it("reports an execution failure distinctly from a rejected approval", async () => {
  const failed: StoredAction = {
    id: 1,
    toolName: "send",
    args: {},
    surface: "chat",
    state: "failed",
    submittedAt: 0,
    retryable: false,
    error: "The outcome is unknown.",
  };
  const host = {
    serverName: "Example",
    endpoint: "https://mcp.example.com",
    scope: {},
    tools: async () => [classifyTool({ name: "send" }, "byo")],
    lookupAction: () => failed,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, {} as never);

  await expect(session.getActionResult(1)).resolves.toEqual({
    status: "failed",
    message: "The outcome is unknown.",
  });
});

it("refuses an action result outside the session's narrowed tool scope", async () => {
  const host = {
    serverName: "Example",
    endpoint: "https://mcp.example.com",
    scope: { tools: ["list"] },
    tools: async () => [classifyTool({ name: "list" }, "byo")],
    lookupAction: () => ({
      id: 2,
      toolName: "send",
      args: {},
      surface: "chat",
      state: "applied",
      submittedAt: 0,
      result: { status: "ok", content: [], text: "secret result", isError: false },
    } satisfies StoredAction),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, {} as never);

  await expect(session.getActionResult(2)).rejects.toThrow(/does not grant access/);
});
