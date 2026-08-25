import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import { withInterpreter } from "@cloudflare/sandbox/interpreter";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  EXPECTED_NODE_VERSION,
  runCanary,
  runClaimedCanaryLifecycle,
  type CanaryChecksReport,
} from "./checks.js";
import { claimCanaryRun, rejectCanaryRequest } from "./policy.js";

const SANDBOX_ID = "one-shot";
const CANARY_DEADLINE_MS = 180_000;
const POST_DESTROY_SETTLE_MS = 10_000;
const DESTROY_TIMEOUT_MS = 30_000;

type CanaryLogFields = {
  phase?: "run" | "destroy" | "verify";
};

const logger = createLogger<CanaryLogFields>({ component: "gatekeeper.sessions.canary" });

interface Env {
  CANARY_SANDBOX: DurableObjectNamespace<CodingSessionImageCanarySandbox>;
  CANARY_TOKEN: string;
  SOURCE_SHA: string;
  CANDIDATE_IMAGE: string;
  EXPECTED_NODE_VERSION: string;
}

/** Ephemeral standard-3 Sandbox used only by the native candidate-image canary. */
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
        env.EXPECTED_NODE_VERSION !== EXPECTED_NODE_VERSION) {
      logger.error("native canary configuration is invalid", {
        event: "coding.session.canary.configuration.invalid",
        phase: "run",
      });
      return jsonResponse({ ok: false }, 500);
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
    } catch {
      logger.error("native candidate-image canary failed", {
        event: "coding.session.canary.failed",
        phase: "run",
      });
      return jsonResponse({ ok: false }, 500);
    }
    logger.info("native candidate-image canary passed", {
      event: "coding.session.canary.passed",
      phase: "verify",
    });
    return jsonResponse({
      ok: true,
      sourceSha: env.SOURCE_SHA,
      candidateImage: env.CANDIDATE_IMAGE,
      checks: report.checks,
    }, 200);
  },
};

function validSourceSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
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
