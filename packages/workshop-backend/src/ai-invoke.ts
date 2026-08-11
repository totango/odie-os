import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ModelHandle } from "./ai-models.js";

/**
 * An all-zeros pi Usage record, for synthesizing assistant messages that were never actually
 * produced by a live model call (chat-history replay, compaction prompts).
 */
export function zeroUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A failed model request, thrown by completeText() and the agent turn loop. pi never throws for
 * provider failures -- it reports them as a final assistant message with stopReason "error" --
 * so this converts that shape back into an exception for callers that expect one (the overseer's
 * turn error triage and the one-shot completion helpers).
 */
export class AgentTurnError extends Error {
  /** HTTP status of the failing request, when the handle observed a response for it. */
  readonly statusCode?: number;
  /** Safe message to persist and show instead of raw provider text, when one is available. */
  readonly userMessage?: string;
  /** Machine-readable chat error code for failures with special client behavior. */
  readonly code?: string;

  constructor(message: string, statusCode?: number, teamPiCodex = false) {
    super(message);
    this.statusCode = statusCode;
    if (teamPiCodex && /account_(?:stream|response_create)_cap|server_is_overloaded/i.test(message)) {
      this.userMessage = "Team PI Codex is temporarily at capacity. Please retry in a moment.";
      this.code = "transient_model_capacity";
    } else if (teamPiCodex && (statusCode === 504 || statusCode === 524 ||
        /Team PI Codex (?:request timed out|stream stopped responding)/i.test(message))) {
      this.userMessage = "Team PI Codex stopped responding before the request completed. Please retry.";
      this.code = "transient_model_timeout";
    }
  }
}

/**
 * Best-effort HTTP status extraction for a failed request. pi reports provider failures as
 * error text only, and its onResponse callback never fires for a request the SDK failed (so
 * ModelHandle.lastResponse is unset then) -- but the provider SDKs' error messages conventionally
 * begin with the status code (e.g. "400 {...}"), which is enough for the overseer's triage
 * (report 5xx/unknown, skip expected 4xx).
 */
export function httpStatusFromError(errorMessage: string, handle: ModelHandle)
    : number | undefined {
  const match = /^(?:error code:\s*)?(\d{3})\b/i.exec(errorMessage.trim());
  if (match) {
    const parsed = Number(match[1]);
    return parsed >= 400 ? parsed : undefined;
  }
  const status = handle.lastResponse?.status;
  return status !== undefined && status >= 400 ? status : undefined;
}

/**
 * Run a single non-streaming-style completion against a ModelHandle and return the response
 * text. Used for one-shot calls: title generation, binding naming, compaction summaries, and
 * LanguageModelBinding.run. Always requests thinking off (one-shots should be quick, and none
 * of them benefit from extended thinking; pre-pi, these calls never configured thinking either).
 * Throws AgentTurnError on provider failure, or the abort reason when `signal` fired.
 */
export async function completeText(handle: ModelHandle, args: {
  systemPrompt?: string;
  // Convenience: wraps into a single user message. Exactly one of `prompt`/`messages` required.
  prompt?: string;
  messages?: Message[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: Message[] = args.messages ??
      [{ role: "user", content: args.prompt ?? "", timestamp: Date.now() }];
  const stream = await handle.stream(handle.model, {
    systemPrompt: args.systemPrompt,
    messages,
  }, {
    maxTokens: args.maxTokens,
    signal: args.signal,
    thinking: false,
  });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    // Surface a cancellation as the abort reason, like a directly-aborted request would.
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? "The model request failed.";
    throw new AgentTurnError(
        errorMessage, httpStatusFromError(errorMessage, handle), handle.teamPiCodex);
  }
  return message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
}
