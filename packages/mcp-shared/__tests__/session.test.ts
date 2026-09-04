import { expect, it } from "vitest";

import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { MAX_TOOL_NAME_CHARS } from "../src/client.js";
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

it("tells an agent to return a pending action so its approval can appear in chat", async () => {
  const entry = classifyTool({ name: "jira_create_issue" }, "byo");
  const staged: StoredAction = {
    id: 7,
    toolName: entry.tool.name,
    args: {},
    state: "pending",
    submittedAt: 0,
  };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => entry,
    stageAction: () => staged,
    discardStagedAction() {},
    actionKindFor: () => ({ tag: "jira:create", label: "Create issue" }),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { submitAction() {} } as never);

  const result = await session.callTool(entry.tool.name);

  expect(result).toMatchObject({ status: "pending", actionId: staged.id });
  if (result.status !== "pending") throw new Error("Expected a pending action.");
  expect(result.message).toContain("return from this executeCode call");
  expect(result.message).not.toMatch(/poll/i);
});

it("searches progressively discovered tools and records the catalog read", async () => {
  const found = classifyTool({
    name: "jira_search_issues",
    description: "Search Jira issues",
    annotations: { readOnlyHint: true },
  }, "byo");
  const observations: unknown[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [found],
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: (description: unknown) => { observations.push(description); },
  };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.listTools({ search: "issues" })).resolves.toEqual([{
    name: "jira_search_issues",
    description: "Search Jira issues",
    mode: "read",
    classifiedBy: "server-annotation",
    inputSchema: undefined,
    title: undefined,
  }]);
  expect(observations).toHaveLength(1);
});

it("calls a tool resolved beyond the initial generated catalog", async () => {
  const expanded = classifyTool({
    name: "jira_search_issues",
    annotations: { readOnlyHint: true },
  }, "byo");
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    tools: async () => [],
    findTool: async () => expanded,
    call: async (fn: (client: never) => Promise<unknown>) => fn({
      callTool: async () => ({ content: [{ type: "text", text: "PROJ-1" }] }),
    } as never),
  } as unknown as McpSessionHost;
  const queue = { authorizeObservation() {} };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.callTool("jira_search_issues", { query: "open" })).resolves.toMatchObject({
    status: "ok",
    text: "PROJ-1",
  });
});

it("identifies the tool in a describe observation", async () => {
  const observations: { description: string }[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => classifyTool({ name: "jira_search_issues" }, "byo"),
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: (description: { description: string }) => {
      observations.push(description);
    },
  };
  const session = new McpSessionBase(host, queue as never);

  await session.listTools({ name: "jira_search_issues" });
  expect(observations[0].description).toContain("jira_search_issues");
});

it("names the grant, not the server, when a scoped binding lacks the tool", async () => {
  // On a scoped binding the tool may well exist on the endpoint. "No such tool" would send an agent
  // hunting for a typo it will not find, so both entry points have to say the same thing.
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => undefined,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() {} } as never);

  await expect(session.listTools({ name: "gh_list_issues" })).resolves.toEqual([]);
  await expect(session.callTool("gh_list_issues"))
    .rejects.toThrow('This binding does not grant a tool named "gh_list_issues".');
});

it("says the server has no such tool when the whole endpoint was granted", async () => {
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => undefined,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() {} } as never);

  await expect(session.listTools({ name: "nope" })).resolves.toEqual([]);
});

it("records what was searched, with the agent's text defused", async () => {
  // The query is the agent's, and an observation is read by a person: left alone it can close the
  // markdown it sits in and carry on in the record's own voice.
  const observations: { description: string }[] = [];
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [],
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: (d: { description: string }) => { observations.push(d); },
  };
  const session = new McpSessionBase(host, queue as never);

  await session.listTools({ search: "issues `**Approved**`" });
  expect(observations[0].description).toContain("issues Approved");
  expect(observations[0].description).toContain("returned 0 match(es)");
  expect(observations[0].description).not.toContain("**Approved**");
});

it("returns the same compact summary shape from a complete local catalog", async () => {
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    searchTools: async () => [classifyTool({
      name: "jira_search_issues",
      description: "x".repeat(4000),
      inputSchema: { type: "object" },
    }, "byo")],
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() {} } as never);

  const [summary] = await session.listTools({ search: "issues" });

  expect(summary.description).toBe(`${"x".repeat(256)}\u2026`);
  expect(summary).not.toHaveProperty("inputSchema");
});

it("refuses an empty or oversized query before calling the endpoint", async () => {
  let searches = 0;
  const searchTools = async () => { searches++; return []; };
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    searchTools,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() {} } as never);

  await expect(session.listTools({ search: "   " })).rejects.toThrow(/non-empty query/);
  await expect(session.listTools({ search: " _ - " })).rejects.toThrow(/search terms/);
  // Bounded on the trimmed text, which is what is actually searched and recorded.
  await expect(session.listTools({ search: `${" ".repeat(50)}${"x".repeat(201)}` }))
    .rejects.toThrow(/at most 200 characters/);
  await expect(session.listTools({ search: `  ${"x".repeat(200)}  ` })).resolves.toEqual([]);
  expect(searches).toBe(1);
});

it("refuses ambiguous progressive list options", async () => {
  const host = { serverName: "Jira", endpoint: "https://mcp.example.com", scope: {} } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() {} } as never);

  await expect(session.listTools({ name: "jira_search", search: "jira" } as never))
    .rejects.toThrow(/exactly one/);
  await expect(session.listTools({} as never)).rejects.toThrow(/exactly one/);
});

it("treats optional selectors set to undefined as absent", async () => {
  const found = classifyTool({ name: "jira_search", annotations: { readOnlyHint: true } }, "byo");
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    searchTools: async () => [found],
    findTool: async () => found,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() {} } as never);

  await expect(session.listTools({ search: "jira", name: undefined }))
    .resolves.toHaveLength(1);
  await expect(session.listTools({ name: "jira_search", search: undefined }))
    .resolves.toHaveLength(1);
});

it("refuses oversized tool names before consulting the host", async () => {
  let finds = 0;
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: {},
    findTool: async () => { finds++; return undefined; },
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, { authorizeObservation() {} } as never);
  const oversized = "x".repeat(MAX_TOOL_NAME_CHARS + 1);

  await expect(session.listTools({ name: oversized })).rejects.toThrow(/tool name.*at most/i);
  await expect(session.callTool(oversized)).rejects.toThrow(/tool name.*at most/i);
  expect(finds).toBe(0);
});


it("only exposes and reads resources referenced by granted MCP Apps tools", async () => {
  const observations: unknown[] = [];
  const calls: string[] = [];
  const appTool = classifyTool({
    name: "weather", _meta: { ui: { resourceUri: "ui://weather/dashboard" } },
  }, "byo");
  const host = {
    serverName: "Weather", endpoint: "https://mcp.example.com", scope: {},
    tools: async () => [appTool],
    call: async (fn: (client: unknown) => Promise<unknown>) => fn({
      listResources: async () => ({ resources: [
        { uri: "ui://weather/dashboard", name: "Weather" },
        { uri: "ui://private/admin", name: "Admin" },
      ], truncated: false }),
      readResource: async (uri: string) => {
        calls.push(uri);
        return { contents: [{ uri, mimeType: "text/html", text: "<main>Weather</main>" }] };
      },
    }),
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, {
    authorizeObservation: (description: unknown) => { observations.push(description); },
  } as never);
  await expect(session.listResources()).resolves.toEqual([
    { uri: "ui://weather/dashboard", name: "Weather" },
  ]);
  await expect(session.readResource("ui://private/admin")).rejects.toThrow(/not referenced/);
  await expect(session.readResource("ui://weather/dashboard")).resolves.toEqual({
    contents: [{ uri: "ui://weather/dashboard", mimeType: "text/html", text: "<main>Weather</main>" }],
  });
  expect(calls).toEqual(["ui://weather/dashboard"]);
  expect(observations).toHaveLength(2);
});


it("fails closed on truncated app catalogs and mismatched upstream resource content", async () => {
  const appTool = classifyTool({
    name: "app", _meta: { ui: { resourceUri: "ui://app/main" } },
  }, "byo");
  const makeSession = (client: unknown) => new McpSessionBase({
    serverName: "App", endpoint: "https://mcp.example.com", scope: {},
    tools: async () => [appTool],
    call: async (fn: (value: unknown) => Promise<unknown>) => fn(client),
  } as unknown as McpSessionHost, { authorizeObservation() {} } as never);

  await expect(makeSession({
    listResources: async () => ({ resources: [], truncated: true }),
  }).listResources()).rejects.toThrow(/bounded listing limit/);

  await expect(makeSession({
    readResource: async () => ({ contents: [{ uri: "ui://other/main", text: "wrong" }] }),
  }).readResource("ui://app/main")).rejects.toThrow(/different resource URI/);
});
