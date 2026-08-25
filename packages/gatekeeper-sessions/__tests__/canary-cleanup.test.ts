import { describe, expect, it } from "vitest";
import {
  CanaryStageError,
  destroyAndVerifySandbox,
  runCanary,
  runClaimedCanaryLifecycle,
} from "../canary/checks.js";

class FakeSandbox {
  readonly deletedContexts: string[] = [];
  terminalTerminateCount = 0;
  editorKillCount = 0;
  nodeKillCount = 0;
  editorRunning = true;
  nodeRunning = true;
  termTimesOut = false;
  terminalTimesOut = false;
  terminalCleanupFails = false;
  getProcessCount = 0;
  getTerminalCount = 0;
  editorSignals: number[] = [];
  editorCommand: readonly string[] | undefined;
  editorOptions: unknown;
  editorReadiness: unknown;
  destroyed = false;
  destroyCalls = 0;
  fail: "node" | "javascript" | "typescript" | "terminal" | "code-server" | undefined;
  private contextNumber = 0;

  interpreter = {
    createCodeContext: async (options: { language?: string; cwd?: string }) => ({
      id: `context-${++this.contextNumber}`, language: options.language!, cwd: options.cwd!,
      createdAt: new Date(), lastUsed: new Date(),
    }),
    runCode: async (_code: string, options: { context?: { language: string } }) => {
      if (this.fail === options.context?.language) throw new Error("injected interpreter failure");
      const text = options.context?.language === "javascript" ? "odie-js:42\n" : "odie-ts:42\n";
      return { code: _code, logs: { stdout: [text], stderr: [] }, results: [] };
    },
    deleteCodeContext: async (id: string) => { this.deletedContexts.push(id); },
  };

  async exec(command: readonly [string, ...string[]], options?: unknown) {
    const editor = command[0] === "code-server";
    if (editor) { this.editorCommand = command; this.editorOptions = options; }
    if (!editor) Function(command[2])();
    const self = this;
    return {
      id: editor ? "editor" : "node", pid: editor ? 2 : 1, exitCode: Promise.resolve(0),
      async output() {
        if (self.fail === "node") throw new Error("injected node failure");
        return { stdout: "odie-node-version:v24.14.0\nodie-node-stdout:42\n", stderr: "odie-node-stderr:ok\n", exitCode: 0, timedOut: false, truncated: false };
      },
      async waitForPort(port: number, options: unknown) {
        if (editor) self.editorReadiness = { port, options };
        if (editor && self.fail === "code-server") throw new Error("injected editor failure");
      },
      async status() {
        const running = editor ? self.editorRunning : self.fail === "node" && self.nodeRunning;
        return running ? { state: "running" as const } : { state: "exited" as const, exit: { code: 0, timedOut: false } };
      },
      async kill(signal = 15) {
        if (editor) {
          self.editorKillCount++;
          self.editorSignals.push(signal);
          if (signal === 9 || !self.termTimesOut) self.editorRunning = false;
        } else { self.nodeKillCount++; self.nodeRunning = false; }
      },
      async waitForExit() { return { code: 0, timedOut: editor && self.editorRunning }; },
    };
  }

  async createTerminal() {
    const self = this;
    return {
      id: "terminal",
      async resize() {}, async write() {},
      async output() {
        if (self.fail === "terminal") throw new Error("injected terminal failure");
        return new ReadableStream({ start(controller) {
          controller.enqueue({ type: "data", terminalId: "terminal", cursor: "1", timestamp: "now", data: new TextEncoder().encode("odie-terminal:<forty-two>\r\n") });
        } });
      },
      async terminate() {
        self.terminalTerminateCount++;
        if (self.terminalCleanupFails) throw new Error("injected terminal cleanup failure");
      },
      async waitForExit() { return { code: 0, timedOut: self.terminalTimesOut }; },
      async getSnapshot() { return { id: "terminal", command: ["sh"] as const, status: "exited" as const }; },
    };
  }

  async mkdir() {}
  async writeFile() {}
  async containerFetch() { return new Response("ready", { status: 200 }); }
  async listProcesses() { return this.destroyed ? [] : [{ id: "node", state: "exited" }]; }
  async listTerminals() { return []; }
  async getProcess() { this.getProcessCount++; return null; }
  async getTerminal() { this.getTerminalCount++; return null; }
  async destroy() { this.destroyCalls++; this.destroyed = true; }
}

describe("native canary cleanup", () => {
  it("passes all checks and leaves no running resources", async () => {
    const sandbox = new FakeSandbox();
    await expect(runCanary(sandbox as never)).resolves.toEqual({
      checks: ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"],
      resourceIds: { process: ["node", "editor"], terminal: ["terminal"] },
    });
    expect(sandbox.deletedContexts).toHaveLength(2);
    expect(sandbox.terminalTerminateCount).toBe(1);
    expect(sandbox.editorKillCount).toBe(1);
    expect(sandbox.editorCommand).toEqual([
      "code-server", "--bind-addr", "0.0.0.0:13337", "--auth", "none",
      "--disable-telemetry", "--disable-update-check", "--disable-workspace-trust",
      "--extensions-dir", "/opt/odie-code-server/extensions",
      "--user-data-dir", "/workspace/.odie-code-server/user-data", "/workspace",
    ]);
    expect(sandbox.editorOptions).toEqual({
      cwd: "/workspace",
      env: {
        CS_DISABLE_GETTING_STARTED_OVERRIDE: "1",
        EXTENSIONS_GALLERY: "{}",
        VSCODE_PROXY_URI: "./proxy/{{port}}",
      },
    });
    expect(sandbox.editorReadiness).toEqual({
      port: 13_337,
      options: { mode: "http", path: "/", status: { min: 200, max: 399 }, timeout: 30_000 },
    });
  });

  for (const failure of ["node", "javascript", "typescript", "terminal", "code-server"] as const) {
    it(`cleans resources after an injected ${failure} failure`, async () => {
      const sandbox = new FakeSandbox();
      sandbox.fail = failure;
      const error = await runCanary(sandbox as never).catch(caught => caught);
      expect(error).toBeInstanceOf(CanaryStageError);
      expect((error as CanaryStageError).failureStage).toBe(failure);
      expect((error as CanaryStageError).cause).toBeInstanceOf(Error);
      expect(((error as CanaryStageError).cause as Error).message).toContain("injected");
      if (failure === "node") expect(sandbox.nodeKillCount).toBe(1);
      if (failure === "javascript") expect(sandbox.deletedContexts).toEqual(["context-1"]);
      if (failure === "typescript") expect(sandbox.deletedContexts).toEqual(["context-2", "context-1"]);
      if (failure === "terminal") expect(sandbox.terminalTerminateCount).toBe(1);
      if (failure === "code-server") {
        expect(sandbox.deletedContexts).toHaveLength(2);
        expect(sandbox.editorKillCount).toBe(1);
      }
    });
  }

  it("classifies final resource verification as cleanup while preserving its cause", async () => {
    const sandbox = new FakeSandbox();
    const error = await runCanary(sandbox as never, {
      beforeStage(stage) {
        if (stage === "cleanup") throw new Error("sensitive cleanup detail");
      },
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(CanaryStageError);
    expect((error as CanaryStageError).failureStage).toBe("cleanup");
    expect(((error as CanaryStageError).cause as Error).message).toBe("sensitive cleanup detail");
  });

  it("escalates a timed-out TERM wait to SIGKILL", async () => {
    const sandbox = new FakeSandbox();
    sandbox.termTimesOut = true;
    await expect(runCanary(sandbox as never)).resolves.toBeDefined();
    expect(sandbox.editorSignals).toEqual([15, 9]);
  });

  it("rejects a timed-out terminal termination", async () => {
    const sandbox = new FakeSandbox();
    sandbox.terminalTimesOut = true;
    await expect(runCanary(sandbox as never)).rejects.toBeInstanceOf(AggregateError);
  });

  it("preserves operation and cleanup failures together", async () => {
    const sandbox = new FakeSandbox();
    sandbox.fail = "terminal";
    sandbox.terminalCleanupFails = true;
    const error = await runCanary(sandbox as never).catch(caught => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
  });

  it("does not destroy when the one-shot claim is rejected", async () => {
    const sandbox = new FakeSandbox();
    let destroyCalls = 0;
    sandbox.destroy = async () => { destroyCalls++; sandbox.destroyed = true; };
    const lifecycle = sandbox as never as FakeSandbox & { claimOneShot(): Promise<void> };
    lifecycle.claimOneShot = async () => { throw new Error("duplicate"); };
    await expect(runClaimedCanaryLifecycle(lifecycle as never, () => runCanary(lifecycle as never), {
      runTimeoutMs: 20, settleTimeoutMs: 20, destroyTimeoutMs: 20,
    })).rejects.toThrow("duplicate");
    expect(destroyCalls).toBe(0);
  });

  it("preserves run and destroy failures", async () => {
    const sandbox = new FakeSandbox();
    const lifecycle = sandbox as never as FakeSandbox & { claimOneShot(): Promise<void> };
    lifecycle.claimOneShot = async () => {};
    lifecycle.destroy = async () => { throw new Error("destroy failed"); };
    const error = await runClaimedCanaryLifecycle(lifecycle as never, async () => {
      throw new Error("run failed");
    }, { runTimeoutMs: 20, settleTimeoutMs: 20, destroyTimeoutMs: 20 }).catch(caught => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(3);
  });

  it("bounds a hung run and its post-destroy settlement", async () => {
    const sandbox = new FakeSandbox();
    const lifecycle = sandbox as never as FakeSandbox & { claimOneShot(): Promise<void> };
    lifecycle.claimOneShot = async () => {};
    const error = await runClaimedCanaryLifecycle(lifecycle as never, () => new Promise(() => {}), {
      runTimeoutMs: 5, settleTimeoutMs: 5, destroyTimeoutMs: 5,
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(sandbox.destroyed).toBe(true);
  });

  it("times out both never-resolving destroy attempts without unhandled rejection", async () => {
    const sandbox = new FakeSandbox();
    const lifecycle = sandbox as never as FakeSandbox & { claimOneShot(): Promise<void> };
    lifecycle.claimOneShot = async () => {};
    lifecycle.destroy = async () => {
      sandbox.destroyCalls++;
      await new Promise<void>(() => {});
    };
    const error = await runClaimedCanaryLifecycle(lifecycle as never, async () => ({
      checks: ["node", "javascript", "typescript", "terminal", "code-server", "cleanup"],
      resourceIds: { process: [], terminal: [] },
    }), { runTimeoutMs: 20, settleTimeoutMs: 20, destroyTimeoutMs: 5 }).catch(caught => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(sandbox.destroyCalls).toBe(2);
  });

  it("destroys and verifies empty non-waking lookups", async () => {
    const sandbox = new FakeSandbox();
    await expect(destroyAndVerifySandbox(sandbox as never, 20, {
      process: ["node", "editor"], terminal: ["terminal"],
    })).resolves.toBeUndefined();
    expect(sandbox.destroyed).toBe(true);
    expect(sandbox.getProcessCount).toBe(2);
    expect(sandbox.getTerminalCount).toBe(1);
  });

  it("fails when destroy does not leave the runtime empty", async () => {
    const sandbox = new FakeSandbox();
    sandbox.destroy = async () => { sandbox.destroyed = false; };
    await expect(destroyAndVerifySandbox(sandbox as never, 20)).rejects.toThrow("still has runtime resources");
  });
});
