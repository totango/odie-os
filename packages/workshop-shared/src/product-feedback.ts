import type { WorkerEntrypoint } from "cloudflare:workers";

/** Maximum UTF-16 code units accepted for product feedback prose. */
export const PRODUCT_FEEDBACK_MAX_TEXT_LENGTH = 4_000;

/** Maximum frontend diagnostic entries accepted with one feedback submission. */
export const PRODUCT_FEEDBACK_MAX_DIAGNOSTICS = 50;

/** Maximum UTF-16 code units retained for one frontend diagnostic message. */
export const PRODUCT_FEEDBACK_MAX_DIAGNOSTIC_LENGTH = 1_000;

/** User-selected feedback category. */
export type ProductFeedbackKind = "bug" | "feedback";

/** Evidence sections the submitter explicitly consented to include. */
export type ProductFeedbackEvidenceConsent = {
  /** Include bounded server-authored workspace and chat context when available. */
  workspaceContext: boolean;
  /** Include current-tab frontend console and error diagnostics. */
  frontendDiagnostics: boolean;
  /** Include owner-bound coding-session summaries and activity when available. */
  codingSessionContext: boolean;
};

/** One bounded diagnostic event captured in the current browser tab. */
export type ProductFeedbackFrontendDiagnostic = {
  /** Browser-supplied event time. Used only for ordering display and evidence context. */
  timestamp: Date;
  /** Diagnostic source. */
  level: "log" | "info" | "warn" | "error";
  /** Sanitized, bounded message text. */
  message: string;
};

/** Client-supplied context hints for a feedback submission. The server re-authorizes all IDs. */
export type ProductFeedbackContextHint = {
  /** Current route pathname only; query strings and fragments are rejected. */
  pathname: string;
  /** Currently-open workspace ID, when the route identifies one. */
  workspaceId?: string;
  /** Currently-open chat ID, when known by the client. */
  chatId?: number;
  /** Currently-open coding-session ID, when known by the client. */
  codingSessionId?: string;
};

/** Authenticated request to submit product feedback or report a bug. */
export type SubmitProductFeedbackRequest = {
  /** User-selected feedback category. */
  kind: ProductFeedbackKind;
  /** Human-readable title authored by the submitter. */
  title: string;
  /** Human-readable details authored by the submitter. */
  description: string;
  /** Explicit consent flags for optional evidence sections. */
  consent: ProductFeedbackEvidenceConsent;
  /** Client context hints. Server-side evidence collection treats these as untrusted IDs. */
  context: ProductFeedbackContextHint;
  /** Current-tab diagnostics included only when consent.frontendDiagnostics is true. */
  diagnostics?: ProductFeedbackFrontendDiagnostic[];
};

/** Status exposed to the submitting user for one feedback automation run. */
export type ProductFeedbackStatus = {
  /** Stable evidence/job identifier. */
  id: string;
  /** User-selected feedback category. */
  kind: ProductFeedbackKind;
  /** Bounded title authored by the submitter. */
  title: string;
  /** Durable automation state. */
  state: "queued" | "running" | "no-safe-fix" | "pr-created" | "failed";
  /** Draft GitHub PR URL when one was created. */
  prUrl?: string;
  /** Bounded user-facing status or failure message. */
  message?: string;
  /** Creation time. */
  createdAt: Date;
  /** Last state transition time. */
  updatedAt: Date;
};

/** Result returned immediately after a feedback submission is durably accepted. */
export type ProductFeedbackSubmissionResult = {
  /** Stable evidence/job identifier. */
  id: string;
  /** Initial durable status for the submitted automation. */
  status: ProductFeedbackStatus;
};

/** Private Sessions-to-JARVIS notifier for fixed product-feedback Slack notifications. */
export interface ProductFeedbackNotifier extends WorkerEntrypoint {
  /** Sends one fixed-template, fixed-channel PR notification for a feedback job. */
  notifyProductFeedbackPr(request: ProductFeedbackNotificationRequest): Promise<void>;
}

/** Server-owned notification request accepted by the product-feedback notifier. */
export type ProductFeedbackNotificationRequest = {
  /** Stable feedback job identifier. */
  jobId: string;
  /** Draft pull request URL created by the Sessions worker. */
  prUrl: string;
  /** Stable idempotency key for the upstream notification write. */
  idempotencyKey: string;
};

/** Removes URLs and common credential forms from text before it enters product-feedback evidence. */
export function sanitizeProductFeedbackText(value: string): string {
  return `${value ?? ""}`
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([A-Za-z0-9_]*token[A-Za-z0-9_]*|authorization|cookie|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

/** Validates and normalizes a product feedback submission request. */
export function validateSubmitProductFeedbackRequest(value: unknown): SubmitProductFeedbackRequest {
  if (typeof value !== "object" || value === null) throw new Error("Feedback request is invalid.");
  const record = value as Partial<SubmitProductFeedbackRequest>;
  if (record.kind !== "bug" && record.kind !== "feedback") throw new Error("Feedback type is invalid.");
  if (typeof record.title !== "string" || !record.title.trim()) throw new Error("Feedback title is required.");
  if (typeof record.description !== "string" || !record.description.trim()) throw new Error("Feedback details are required.");
  if (record.title.length > PRODUCT_FEEDBACK_MAX_TEXT_LENGTH || record.description.length > PRODUCT_FEEDBACK_MAX_TEXT_LENGTH) {
    throw new Error(`Feedback text must be at most ${PRODUCT_FEEDBACK_MAX_TEXT_LENGTH} characters.`);
  }
  const consent = record.consent;
  if (typeof consent !== "object" || consent === null ||
      typeof consent.workspaceContext !== "boolean" ||
      typeof consent.frontendDiagnostics !== "boolean" ||
      typeof consent.codingSessionContext !== "boolean") {
    throw new Error("Feedback evidence consent is invalid.");
  }
  const context = record.context;
  if (typeof context !== "object" || context === null || typeof context.pathname !== "string") {
    throw new Error("Feedback context is invalid.");
  }
  if (!context.pathname.startsWith("/") || context.pathname.includes("?") || context.pathname.includes("#")) {
    throw new Error("Feedback route pathname is invalid.");
  }
  if (context.pathname.length > 512) throw new Error("Feedback route pathname is too long.");
  if (context.workspaceId !== undefined &&
      (typeof context.workspaceId !== "string" || context.workspaceId.length > 128)) {
    throw new Error("Feedback workspace is invalid.");
  }
  if (context.chatId !== undefined && (!Number.isInteger(context.chatId) || context.chatId < 0)) throw new Error("Feedback chat is invalid.");
  if (context.codingSessionId !== undefined &&
      (typeof context.codingSessionId !== "string" || context.codingSessionId.length > 128)) {
    throw new Error("Feedback coding session is invalid.");
  }
  const diagnostics = record.diagnostics ?? [];
  if (!Array.isArray(diagnostics) || diagnostics.length > PRODUCT_FEEDBACK_MAX_DIAGNOSTICS) {
    throw new Error(`Feedback diagnostics must include at most ${PRODUCT_FEEDBACK_MAX_DIAGNOSTICS} entries.`);
  }
  return {
    kind: record.kind,
    title: record.title,
    description: record.description,
    consent,
    context,
    diagnostics: diagnostics.map(item => {
      if (typeof item !== "object" || item === null) throw new Error("Feedback diagnostic is invalid.");
      const diagnostic = item as Partial<ProductFeedbackFrontendDiagnostic>;
      if (!["log", "info", "warn", "error"].includes(`${diagnostic.level}`)) throw new Error("Feedback diagnostic level is invalid.");
      if (typeof diagnostic.message !== "string" || diagnostic.message.length > PRODUCT_FEEDBACK_MAX_DIAGNOSTIC_LENGTH) {
        throw new Error(`Feedback diagnostic messages must be at most ${PRODUCT_FEEDBACK_MAX_DIAGNOSTIC_LENGTH} characters.`);
      }
      const timestamp = diagnostic.timestamp instanceof Date ? diagnostic.timestamp : new Date(`${diagnostic.timestamp ?? ""}`);
      return { timestamp: Number.isNaN(timestamp.valueOf()) ? new Date() : timestamp, level: diagnostic.level as ProductFeedbackFrontendDiagnostic["level"], message: diagnostic.message };
    }),
  };
}
