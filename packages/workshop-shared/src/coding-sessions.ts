import type { WorkerEntrypoint } from "cloudflare:workers";
import type { ActionDescription, ObservationDescription } from "./gatekeeper.js";
import type {
  CodingSessionAttachCapability,
  CodingSessionRepository,
  CodingSessionSummary,
  CreateCodingSessionRequest,
} from "./api.js";

/** Authenticated Workshop identity supplied to the Sessions service over a private binding. */
export interface CodingSessionOwner {
  /** Stable Workshop user Durable Object identifier. */
  userId: string;
  /** Verified user identity used for model authorization and audit logs. */
  email: string;
  /** Connected GitHub login, when the provider exposes one. */
  githubLogin?: string;
}

/** One MCP tool made available to an authenticated coding session. */
export interface CodingSessionTool {
  /** Stable name exposed through the Workshop MCP server. */
  name: string;
  /** Optional display title supplied by the connected service. */
  title?: string;
  /** Optional tool description supplied by the connected service. */
  description?: string;
  /** JSON Schema describing the tool arguments. */
  inputSchema?: unknown;
}

/** Result of invoking a coding-session MCP tool. */
export interface CodingSessionToolResult {
  /** MCP content blocks returned to OpenCode. */
  content: unknown[];
  /** Whether the connected tool reported an application-level failure. */
  isError?: boolean;
  /** Optional structured result returned by the connected tool. */
  structuredContent?: unknown;
  /** Existing gatekeeper action identifier while this call awaits approval. */
  pendingActionId?: number;
}

/** One durable observation or action emitted by a coding-session tool call. */
export interface CodingSessionActivity {
  /** Opaque activity identifier. */
  id: string;
  /** Coding session that produced this activity. */
  sessionId: string;
  /** Connected account vendor identifier. */
  vendorId: string;
  /** Human-facing connected resource title. */
  resourceTitle: string;
  /** Whether this record is a completed read or an approval-gated action. */
  type: "observation" | "action";
  /** Current action state; observations are always approved. */
  state: "pending" | "applying" | "approved" | "rejected" | "failed";
  /** Bounded description rendered by Workshop approval surfaces. */
  description: ObservationDescription | ActionDescription;
  /** Time the activity was submitted. */
  createdAt: Date;
  /** Failure text when an approved action could not be applied. */
  error?: string;
}

/** Narrow owner-bound capability used by the Sessions worker to serve Workshop MCP. */
export interface CodingSessionToolHost extends WorkerEntrypoint {
  /** Lists the current user's eligible connected MCP tools. */
  listTools(sessionId: string): Promise<CodingSessionTool[]>;

  /** Calls one namespaced tool through its existing gatekeeper approval policy. */
  callTool(
    sessionId: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<CodingSessionToolResult>;

  /** Collects the result of an approval-gated MCP action. */
  getActionResult(
    sessionId: string,
    name: string,
    actionId: number,
  ): Promise<CodingSessionToolResult>;
}

/** Private control-plane RPC implemented by the Sessions service. */
export interface CodingSessionsService extends WorkerEntrypoint {
  /** Lists sessions owned by the authenticated Workshop user. */
  listSessions(owner: CodingSessionOwner): Promise<CodingSessionSummary[]>;

  /** Creates a session after independently validating the repository allowlist. */
  createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
    toolHost: Fetcher<CodingSessionToolHost>,
  ): Promise<CodingSessionSummary>;

  /** Stops a session after verifying ownership. */
  stopSession(owner: CodingSessionOwner, sessionId: string): Promise<void>;

  /** Stops and archives a session after verifying ownership. */
  archiveSession(owner: CodingSessionOwner, sessionId: string): Promise<void>;

  /** Mints a short-lived, single-use terminal attachment capability. */
  mintAttachCapability(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionAttachCapability>;
}

/** Returns whether a value names an allowlisted coding-session repository. */
export function isCodingSessionRepository(value: unknown): value is CodingSessionRepository {
  return typeof value === "string" && [
    "agentic",
    "unison-integrations",
    "leviosa-backend",
    "zords",
    "leviosa-ml-ops",
    "jarvis",
  ].includes(value);
}
