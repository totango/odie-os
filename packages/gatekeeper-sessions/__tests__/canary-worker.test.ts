import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = {
  claimed: false,
  destroyCalls: 0,
  async claimOneShot() {
    if (this.claimed) throw new Error("duplicate");
    this.claimed = true;
  },
};
let lifecycleFailure: unknown;
let lifecycleOptions: { runTimeoutMs: number; settleTimeoutMs: number; destroyTimeoutMs: number } | undefined;

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox: () => sandbox,
}));
vi.mock("@cloudflare/sandbox/interpreter", () => ({ withInterpreter: () => ({}) }));
vi.mock("../canary/checks.js", () => ({
  CanaryStageError: class CanaryStageError extends Error {
    constructor(readonly failureStage: string, cause: unknown) {
      super(`Canary ${failureStage} stage failed.`, { cause });
    }
  },
  EXPECTED_NODE_VERSION: "v24.14.0",
  INSTANCE_TIER: "standard-3",
  runCanary: vi.fn(),
  runClaimedCanaryLifecycle: async (
    target: typeof sandbox,
    _run: unknown,
    options: { runTimeoutMs: number; settleTimeoutMs: number; destroyTimeoutMs: number },
  ) => {
    lifecycleOptions = options;
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
const { CanaryStageError } = await import("../canary/checks.js");
const TOKEN = "a".repeat(64);
const env = {
  CANARY_SANDBOX: {},
  CANARY_TOKEN: TOKEN,
  SOURCE_SHA: "b".repeat(40),
  CANDIDATE_IMAGE: `registry.cloudflare.com/${"c".repeat(32)}/odie-os-coding-session@sha256:${"d".repeat(64)}`,
  EXPECTED_NODE_VERSION: "v24.14.0",
  INSTANCE_TIER: "standard-3",
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
    lifecycleOptions = undefined;
  });

  it("bounds a cold native run with the five-minute lifecycle deadline", async () => {
    const response = await worker.fetch(request(), env as never);
    expect(response.status).toBe(200);
    expect(lifecycleOptions).toEqual({
      runTimeoutMs: 300_000,
      settleTimeoutMs: 10_000,
      destroyTimeoutMs: 30_000,
    });
  });

  it("allows one request and a repeat claim never destroys its sandbox", async () => {
    const responses = await Promise.all([
      worker.fetch(request(), env as never), worker.fetch(request(), env as never),
    ]);
    expect(responses.map(response => response.status).toSorted()).toEqual([200, 500]);
    expect(responses.every(response => response.headers.get("Cache-Control") === "no-store")).toBe(true);
    const passed = responses.find(response => response.status === 200)!;
    expect(await passed.json()).toEqual({
      ok: true,
      sourceSha: env.SOURCE_SHA,
      candidateImage: env.CANDIDATE_IMAGE,
      instanceTier: "standard-3",
      checks: ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"],
    });
    expect(sandbox.destroyCalls).toBe(1);
    const repeat = await worker.fetch(request(), env as never);
    expect(repeat.status).toBe(500);
    expect(await repeat.json()).toEqual({ ok: false, failureStage: "lifecycle" });
    expect(sandbox.destroyCalls).toBe(1);
  });

  it("returns bounded cache-safe failures without leaking the error", async () => {
    lifecycleFailure = new Error("sensitive injected detail");
    const response = await worker.fetch(request(), env as never);
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe('{"ok":false,"failureStage":"lifecycle"}');
  });

  it("recursively returns only a closed stage from aggregate failures", async () => {
    lifecycleFailure = new AggregateError([
      new Error("sensitive outer detail"),
      new AggregateError([
        new CanaryStageError("typescript", new Error("sensitive nested detail")),
      ], "sensitive aggregate detail"),
    ]);
    const response = await worker.fetch(request(), env as never);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"ok":false,"failureStage":"typescript"}');
  });

  it("prefers the operation stage when operation and cleanup both fail", async () => {
    lifecycleFailure = new AggregateError([
      new CanaryStageError("code-server", new Error("sensitive operation detail")),
      new CanaryStageError("cleanup", new Error("sensitive cleanup detail")),
    ]);
    const response = await worker.fetch(request(), env as never);
    expect(await response.text()).toBe('{"ok":false,"failureStage":"code-server"}');
  });

  it("preserves lifecycle operation precedence when cleanup also fails", async () => {
    lifecycleFailure = new AggregateError([
      new CanaryStageError("lifecycle", new Error("sensitive startup detail")),
      new CanaryStageError("cleanup", new Error("sensitive cleanup detail")),
    ]);
    const response = await worker.fetch(request(), env as never);
    expect(await response.text()).toBe('{"ok":false,"failureStage":"lifecycle"}');
  });

  it("falls back to lifecycle for an out-of-contract stage", async () => {
    lifecycleFailure = new CanaryStageError("sensitive-invalid-stage" as never, new Error("sensitive detail"));
    const response = await worker.fetch(request(), env as never);
    expect(await response.text()).toBe('{"ok":false,"failureStage":"lifecycle"}');
  });
});
