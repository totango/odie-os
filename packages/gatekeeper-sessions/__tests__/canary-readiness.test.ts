import type { SandboxProcess } from "@cloudflare/sandbox";
import {
  ContainerUnavailableError,
  OperationInterruptedError,
  RPCTransportError,
} from "@cloudflare/sandbox/errors";
import { describe, expect, it } from "vitest";
import { classifyCanaryOperationFailure, startNodeCanaryProcess } from "../canary/checks.js";

const process = { id: "node" } as SandboxProcess;

function unavailable(retryAfterMs?: number): ContainerUnavailableError {
  return new ContainerUnavailableError({
    code: "CONTAINER_UNAVAILABLE",
    message: "container is starting",
    context: {
      reason: "container_starting",
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
    httpStatus: 503,
    timestamp: "2026-08-24T00:00:00.000Z",
  });
}

function runWith(
  outcomes: unknown[],
): {
  result: Promise<SandboxProcess>;
  attempts: () => number;
  delays: number[];
  calls: Array<{ command: readonly string[]; options: unknown }>;
} {
  let attempts = 0;
  const calls: Array<{ command: readonly string[]; options: unknown }> = [];
  const sandbox = {
    async exec(command: readonly string[], options: unknown) {
      calls.push({ command, options });
      const outcome = outcomes[attempts++];
      if (outcome instanceof Error) throw outcome;
      return outcome as SandboxProcess;
    },
  };
  const delays: number[] = [];
  return {
    result: startNodeCanaryProcess(sandbox, async delayMs => { delays.push(delayMs); }),
    attempts: () => attempts,
    delays,
    calls,
  };
}

describe("native canary failure classification", () => {
  it("reports exhausted pre-admission Node startup as lifecycle", () => {
    expect(classifyCanaryOperationFailure("node", unavailable())).toBe("lifecycle");
  });

  it("keeps admitted Node failures and later stages unchanged", () => {
    expect(classifyCanaryOperationFailure("node", new Error("node output"))).toBe("node");
    expect(classifyCanaryOperationFailure("javascript", unavailable())).toBe("javascript");
  });
});

describe("native canary initial Node readiness", () => {
  it("returns the first successful exec after scheduling output for log attachment", async () => {
    const run = runWith([process]);
    await expect(run.result).resolves.toBe(process);
    expect(run.attempts()).toBe(1);
    expect(run.delays).toEqual([]);
    expect(run.calls[0]?.command.slice(0, 2)).toEqual(["node", "--eval"]);
    expect(run.calls[0]?.command[2]).toContain("setTimeout(() => {");
    expect(run.calls[0]?.command[2]).toContain("}, 5000)");
    expect(run.calls[0]?.options).toEqual({ timeout: 30_000 });
  });

  it("retries the exact ContainerUnavailableError and honors retryAfterMs", async () => {
    const run = runWith([unavailable(250), process]);
    await expect(run.result).resolves.toBe(process);
    expect(run.attempts()).toBe(2);
    expect(run.delays).toEqual([250]);
  });

  it("uses bounded fallback backoff when retryAfterMs is absent", async () => {
    const run = runWith([unavailable(), process]);
    await expect(run.result).resolves.toBe(process);
    expect(run.attempts()).toBe(2);
    expect(run.delays).toEqual([1_000]);
  });

  it("bounds the delay and total attempts", async () => {
    const final = unavailable(50);
    const run = runWith([
      unavailable(100_000), unavailable(-1), unavailable(), unavailable(Number.NaN),
      unavailable(Number.MAX_SAFE_INTEGER + 1), final, process,
    ]);
    await expect(run.result).rejects.toBe(final);
    expect(run.attempts()).toBe(6);
    expect(run.delays).toEqual([10_000, 2_000, 4_000, 8_000, 10_000]);
  });

  it.each([
    new Error("ordinary failure"),
    Object.assign(new Error("lookalike"), { name: "ContainerUnavailableError", httpStatus: 503 }),
    new OperationInterruptedError({
      code: "OPERATION_INTERRUPTED",
      message: "operation may have started",
      context: { reason: "runtime_replaced", operation: "process.exec", admitted: true, retryable: true },
      httpStatus: 409,
      timestamp: "2026-08-24T00:00:00.000Z",
    }),
    new RPCTransportError({
      code: "RPC_TRANSPORT_ERROR",
      message: "lost contact",
      context: { kind: "peer_closed", originalMessage: "closed" },
      httpStatus: 503,
      timestamp: "2026-08-24T00:00:00.000Z",
    }),
  ])("does not retry any other error class or status", async error => {
    const run = runWith([error, process]);
    await expect(run.result).rejects.toBe(error);
    expect(run.attempts()).toBe(1);
    expect(run.delays).toEqual([]);
  });
});
