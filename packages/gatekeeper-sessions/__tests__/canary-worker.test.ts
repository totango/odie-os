import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = {
  claimed: false,
  destroyCalls: 0,
  async claimOneShot() {
    if (this.claimed) throw new Error("duplicate");
    this.claimed = true;
  },
};
let lifecycleFailure: Error | undefined;

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox: () => sandbox,
}));
vi.mock("@cloudflare/sandbox/interpreter", () => ({ withInterpreter: () => ({}) }));
vi.mock("../canary/checks.js", () => ({
  EXPECTED_NODE_VERSION: "v24.14.0",
  runCanary: vi.fn(),
  runClaimedCanaryLifecycle: async (target: typeof sandbox) => {
    await target.claimOneShot();
    if (lifecycleFailure) throw lifecycleFailure;
    target.destroyCalls++;
    return {
      checks: ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"],
      resourceIds: { process: [], terminal: [] },
    };
  },
}));

const worker = (await import("../canary/worker.js")).default;
const TOKEN = "a".repeat(64);
const env = {
  CANARY_SANDBOX: {},
  CANARY_TOKEN: TOKEN,
  SOURCE_SHA: "b".repeat(40),
  CANDIDATE_IMAGE: `registry.cloudflare.com/${"c".repeat(32)}/odie-os-coding-session@sha256:${"d".repeat(64)}`,
  EXPECTED_NODE_VERSION: "v24.14.0",
};

function request() {
  return new Request("https://canary.example/run", {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe("native canary Worker endpoint", () => {
  beforeEach(() => {
    sandbox.claimed = false;
    sandbox.destroyCalls = 0;
    lifecycleFailure = undefined;
  });

  it("allows one request and a repeat claim never destroys its sandbox", async () => {
    const responses = await Promise.all([
      worker.fetch(request(), env as never), worker.fetch(request(), env as never),
    ]);
    expect(responses.map(response => response.status).toSorted()).toEqual([200, 500]);
    expect(responses.every(response => response.headers.get("Cache-Control") === "no-store")).toBe(true);
    expect(sandbox.destroyCalls).toBe(1);
    const repeat = await worker.fetch(request(), env as never);
    expect(repeat.status).toBe(500);
    expect(await repeat.json()).toEqual({ ok: false });
    expect(sandbox.destroyCalls).toBe(1);
  });

  it("returns bounded cache-safe failures without leaking the error", async () => {
    lifecycleFailure = new Error("sensitive injected detail");
    const response = await worker.fetch(request(), env as never);
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe('{"ok":false}');
  });
});
