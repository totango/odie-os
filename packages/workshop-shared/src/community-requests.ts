/** Public board limits, measured in UTF-16 code units; quotas are fixed account-scoped windows. */
export const COMMUNITY_REQUEST_LIMITS = {
  title: 160, body: 8000, detail: 4000, query: 160, idempotencyKey: 80,
  page: 50, related: 10, readsPerMinute: 120, writesPerMinute: 30,
  createsPerHour: 5, detailsPerHour: 30,
} as const;

/** Authored public request category; bugs never import historical private feedback. */
export type CommunityRequestKind = "feature" | "bug";

/** Explicitly authored plain text for signed-in deployment users, not diagnostics or evidence. */
export interface CreateCommunityRequest {
  /** Account-scoped retry key (1–80 ASCII letters, digits, hyphens or underscores), retained indefinitely. */
  idempotencyKey: string;
  /** Feature request or newly authored public bug. */
  kind: CommunityRequestKind;
  /** Public plain-text title: input at most 160 code units, trimmed and required to be nonempty. */
  title: string;
  /** Public plain-text description: input at most 8000 code units, trimmed and required to be nonempty. */
  body: string;
}

/** Safe board projection; no author identity, diagnostics, private evidence or execution capability. */
export interface CommunityRequest {
  /** Opaque board identifier, never a capability. */
  id: string;
  /** Authored request category. */
  kind: CommunityRequestKind;
  /** Public plain text; render as text, never HTML. */
  title: string;
  /** Public plain text; render as text, never HTML. */
  body: string;
  /** Moderated lifecycle; closed requests remain readable and can be voted/commented on. */
  status: "open" | "closed";
  /** True only in explicitly authorized moderator reads; hidden requests are otherwise absent. */
  hidden: boolean;
  /** Visible canonical request ID, or null (including when the target is hidden). */
  duplicateOf: string | null;
  /** Creation time in Unix milliseconds. */
  createdAt: number;
  /** Last content/moderation change in Unix milliseconds; votes do not reorder the board. */
  updatedAt: number;
  /** Whether the authenticated account authored this request; not an identity claim about a person. */
  isOwn: boolean;
  /** Number of distinct account votes. */
  voteCount: number;
  /** Whether the current authenticated account has voted. */
  viewerHasVoted: boolean;
}

/** Public detail appended to a request; immutable authored text, with no attached private evidence. */
export interface CommunityRequestDetail {
  /** Opaque detail identifier. */
  id: string;
  /** Public plain text, at most 4000 code units. */
  body: string;
  /** Creation time in Unix milliseconds. */
  createdAt: number;
  /** Whether this authenticated account authored the detail. */
  isOwn: boolean;
}

/** Cursor page options; cursors are opaque, bound to the query, and convey no authority. */
export interface CommunityRequestPageOptions {
  /** Maximum results, 1–50; defaults to 20. */
  limit?: number;
  /** Continue from a previous matching page's nextCursor. */
  cursor?: string;
  /** Explicit moderator-only inclusion of hidden requests; ordinary callers are denied. */
  includeHidden?: boolean;
}

/** List/search filter over public title, description and details only. */
export interface CommunityRequestQuery extends CommunityRequestPageOptions {
  /** Optional category restriction. */
  kind?: CommunityRequestKind;
  /** Optional lifecycle restriction. */
  status?: "open" | "closed";
  /** Literal case-insensitive substring, at most 160 code units; empty means list all. */
  query?: string;
}

/** Bounded page of safe public requests; deliberately no hidden-inclusive totals. */
export interface CommunityRequestPage {
  /** Requests in newest-first creation order. */
  items: CommunityRequest[];
  /** Continuation for this query, or null. */
  nextCursor: string | null;
}

/** Bounded oldest-first public detail page. */
export interface CommunityRequestDetailPage {
  /** Authored public details for one visible request. */
  items: CommunityRequestDetail[];
  /** Continuation for this request, or null. */
  nextCursor: string | null;
}

/** Idempotent append; keys are account-scoped across all detail appends and retained indefinitely. */
export interface AddCommunityRequestDetail {
  /** Stable retry key; reusing it with different canonical text or request rejects. */
  idempotencyKey: string;
  /** Authored public plain text only. */
  body: string;
}

/** Static-admin moderation command, never a grant of administrative authority. */
export interface ModerateCommunityRequest {
  /** Stable account-scoped retry key, retained indefinitely. Conflicting reuses reject. */
  idempotencyKey: string;
  /** Hide/restore visibility, close/reopen lifecycle, or close as a duplicate. Reopen clears duplicateOf. */
  action: "hide" | "restore" | "close" | "reopen" | "duplicate";
  /** Required only for duplicate: a distinct visible canonical request, without duplicate chains. */
  duplicateOf?: string;
}
