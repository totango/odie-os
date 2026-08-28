import { describe, expect, it, vi } from "vitest";

const outboundRegistry = vi.hoisted(() => ({ byHost: undefined as Record<string, unknown> | undefined }));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class ContainerProxy {},
  Sandbox: class Sandbox {
    static get outboundByHost() { return outboundRegistry.byHost; }
    static set outboundByHost(handlers: Record<string, unknown>) { outboundRegistry.byHost = handlers; }
  },
}));

vi.mock("../src/github-app.js", () => ({
  mintGitHubCodingSessionToken: vi.fn(async () => ({ token: "github-token", expiresAt: Date.now() + 60_000 })),
}));

const { CodingSessionSandbox, ProductFeedbackSandbox } = await import("../src/sessions.js");

describe("coding session sandbox outbound policy", () => {
  it("enables general internet while retaining host interceptors for special hosts", () => {
    const sandbox = new (CodingSessionSandbox as any)();

    expect(sandbox.enableInternet).toBe(true);
    expect(sandbox.allowedHosts).toBeUndefined();
    expect(sandbox.interceptHttps).toBe(true);
    expect(CodingSessionSandbox.outboundByHost).toMatchObject({
      "team-pi-proxy.unison.totango.com": expect.any(Function),
      "workshop-mcp.internal": expect.any(Function),
      "registry.npmjs.org": expect.any(Function),
      "pypi.org": expect.any(Function),
      "files.pythonhosted.org": expect.any(Function),
      "proxy.golang.org": expect.any(Function),
      "sum.golang.org": expect.any(Function),
    });
  });

  it("restricts autonomous feedback execution to GitHub and the model relay", () => {
    const sandbox = new (ProductFeedbackSandbox as any)();
    expect(sandbox.enableInternet).toBe(false);
    expect(sandbox.allowedHosts).toEqual(["github.com", "team-pi-proxy.unison.totango.com"]);
  });
});
