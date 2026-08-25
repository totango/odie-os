import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import { withInterpreter } from "@cloudflare/sandbox/interpreter";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  CanaryStageError,
  EXPECTED_NODE_VERSION,
  runCanary,
  runClaimedCanaryLifecycle,
  type CanaryChecksReport,
  type CanaryFailureStage,
} from "./checks.js";
import { claimCanaryRun, rejectCanaryRequest } from "./policy.js";

const SANDBOX_ID = "one-shot";
const CANARY_DEADLINE_MS = 300_000;
const POST_DESTROY_SETTLE_MS = 10_000;
const DESTROY_TIMEOUT_MS = 30_000;

type CanaryLogFields = {
  phase?: "run" | "destroy" | "verify";
  failureStage?: CanaryFailureStage;
};

const logger = createLogger<CanaryLogFields>({ component: "gatekeeper.sessions.canary" });

interface Env {
  CANARY_SANDBOX: DurableObjectNamespace<CodingSessionImageCanarySandbox>;
  CANARY_TOKEN: string;
  SOURCE_SHA: string;
  CANDIDATE_IMAGE: string;
  EXPECTED_NODE_VERSION: string;
  INSTANCE_TIER: string;
}

/** Ephemeral tier-specific Sandbox used only by the native candidate-image canary. */
export class CodingSessionImageCanarySandbox extends Sandbox<Env> {
  sleepAfter = "1m";
  enableInternet = false;
  interpreter = withInterpreter(this);

  /** Atomically admits one invocation with the synchronous Durable Object KV transaction API. */
  claimOneShot(): void {
    this.ctx.storage.transactionSync(() => claimCanaryRun(this.ctx.storage.kv));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const rejection = await rejectCanaryRequest(request, env.CANARY_TOKEN);
    if (rejection) return rejection;
    if (!validSourceSha(env.SOURCE_SHA) || !validCandidateImage(env.CANDIDATE_IMAGE) ||
        env.EXPECTED_NODE_VERSION !== EXPECTED_NODE_VERSION || !validInstanceTier(env.INSTANCE_TIER)) {
      logger.error("native canary configuration is invalid", {
        event: "coding.session.canary.configuration.invalid",
        phase: "run",
      });
      return failureResponse("lifecycle");
    }

    const sandbox = getSandbox(env.CANARY_SANDBOX, SANDBOX_ID, { normalizeId: true });
    let report: CanaryChecksReport;
    try {
      report = await runClaimedCanaryLifecycle(
        sandbox,
        () => runCanary(sandbox),
        {
          runTimeoutMs: CANARY_DEADLINE_MS,
          settleTimeoutMs: POST_DESTROY_SETTLE_MS,
          destroyTimeoutMs: DESTROY_TIMEOUT_MS,
        },
      );
    } catch (error) {
      const failureStage = extractFailureStage(error);
      logger.error("native candidate-image canary failed", {
        event: "coding.session.canary.failed",
        phase: "run",
        failureStage,
      });
      return failureResponse(failureStage);
    }
    logger.info("native candidate-image canary passed", {
      event: "coding.session.canary.passed",
      phase: "verify",
    });
    return jsonResponse({
      ok: true,
      sourceSha: env.SOURCE_SHA,
      candidateImage: env.CANDIDATE_IMAGE,
      instanceTier: env.INSTANCE_TIER,
      checks: report.checks,
    }, 200);
  },
};

function failureResponse(failureStage: CanaryFailureStage): Response {
  return jsonResponse({ ok: false, failureStage }, 500);
}

function extractFailureStage(error: unknown): CanaryFailureStage {
  const pending = [error];
  const seen = new Set<unknown>();
  let inspected = 0;
  while (pending.length > 0 && inspected < 64) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    inspected++;
    if (current instanceof CanaryStageError && isCanaryFailureStage(current.failureStage)) {
      return current.failureStage;
    }
    if (current instanceof AggregateError && Array.isArray(current.errors)) {
      for (const nested of current.errors.slice(0, 32).toReversed()) pending.push(nested);
    }
  }
  return "lifecycle";
}

function isCanaryFailureStage(value: unknown): value is CanaryFailureStage {
  return value === "lifecycle" || isCanaryStage(value);
}

function isCanaryStage(value: unknown): value is Exclude<CanaryFailureStage, "lifecycle"> {
  return value === "node" || value === "javascript" || value === "typescript" || value === "terminal" ||
    value === "code-server" || value === "cleanup";
}

function validSourceSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function validInstanceTier(value: string): boolean {
  return /^(?:standard-[1-4])$/.test(value);
}

function validCandidateImage(value: string): boolean {
  return /^registry\.cloudflare\.com\/[0-9a-f]{32}\/odie-os-coding-session@sha256:[0-9a-f]{64}$/.test(value);
}

function jsonResponse(value: { ok: boolean } & Record<string, unknown>, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
