import type { WorkerEntrypoint } from "cloudflare:workers";
import type { ActionDescription, ObservationDescription } from "./gatekeeper.js";
import type {
  CodingSessionAttachCapability,
  CodingSessionRepository,
  CodingSessionSummary,
  CodingSessionTerminalKind,
  CreateCodingSessionRequest,
  OpenCodeUserCustomization,
} from "./api.js";

const MAX_OPENCODE_PLUGINS = 20;
const MAX_OPENCODE_SKILLS = 20;
const MAX_OPENCODE_SKILL_NAME_LENGTH = 64;
const MAX_OPENCODE_SKILL_DESCRIPTION_LENGTH = 1024;
const MAX_OPENCODE_SKILL_INSTRUCTIONS_LENGTH = 65536;
const MAX_OPENCODE_CUSTOMIZATION_BYTES = 256 * 1024;
const OPENCODE_SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NPM_PACKAGE_WITH_OPTIONAL_VERSION_REGEX = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)(?:@(?:\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?|[~^]?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?|[<>]=?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?))?$/;

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
  /**
   * Revalidates startup authority for the current user and returns ephemeral OpenCode
   * customization for immediate materialization. This private control-plane call is made only by
   * the Sessions worker's startup alarm, never by public clients.
   */
  prepareSessionStartup(
    owner: CodingSessionOwner,
    sessionId: string,
    repositories: CodingSessionRepository[],
  ): Promise<OpenCodeUserCustomization>;

  /** Lists the current user's eligible connected MCP tools. */
  listTools(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionTool[]>;

  /** Calls one namespaced tool through its existing gatekeeper approval policy. */
  callTool(
    owner: CodingSessionOwner,
    sessionId: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<CodingSessionToolResult>;

  /** Collects the result of an approval-gated MCP action. */
  getActionResult(
    owner: CodingSessionOwner,
    sessionId: string,
    name: string,
    actionId: number,
  ): Promise<CodingSessionToolResult>;
}

/** Private control-plane RPC implemented by the Sessions service. */
export interface CodingSessionsService extends WorkerEntrypoint {
  /** Lists sessions owned by the authenticated Workshop user. */
  listSessions(owner: CodingSessionOwner): Promise<CodingSessionSummary[]>;

  /**
   * Retrieves one non-archived session owned by the authenticated Workshop user and reconciles its
   * live runtime metadata without exposing sandbox or terminal identifiers.
   */
  getSession(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined>;

  /**
   * Retrieves persisted metadata for one non-archived owned session without contacting its sandbox.
   * This avoids re-entering a sandbox while authorizing an outbound tool call from that sandbox.
   */
  getSessionMetadata(owner: CodingSessionOwner, sessionId: string): Promise<CodingSessionSummary | undefined>;

  /** Creates a session after independently validating the repository allowlist. */
  createSession(
    owner: CodingSessionOwner,
    request: CreateCodingSessionRequest,
  ): Promise<CodingSessionSummary>;

  /** Stops a session after verifying ownership. */
  stopSession(owner: CodingSessionOwner, sessionId: string): Promise<void>;

  /** Destroys and rebuilds a session after verifying ownership. */
  restartSession(
    owner: CodingSessionOwner,
    sessionId: string,
  ): Promise<CodingSessionSummary>;

  /** Stops and archives a session after verifying ownership. */
  archiveSession(owner: CodingSessionOwner, sessionId: string): Promise<void>;

  /** Mints a short-lived, single-use terminal attachment capability. */
  mintAttachCapability(
    owner: CodingSessionOwner,
    sessionId: string,
    terminal?: CodingSessionTerminalKind,
  ): Promise<CodingSessionAttachCapability>;
}

/** Returns whether a value is a canonical GitHub repository name accepted by Coding Sessions. */
export function isCodingSessionRepository(value: unknown): value is CodingSessionRepository {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(value);
}

/** Validates and normalizes account-scoped OpenCode customization before persistence or use. */
export function validateOpenCodeCustomization(value: OpenCodeUserCustomization): OpenCodeUserCustomization {
  if (typeof value !== "object" || value === null || !Array.isArray(value.plugins) || !Array.isArray(value.skills)) {
    throw new Error("Invalid OpenCode customization.");
  }
  if (value.plugins.length > MAX_OPENCODE_PLUGINS) {
    throw new Error(`OpenCode customization may include at most ${MAX_OPENCODE_PLUGINS} plugins.`);
  }
  if (value.skills.length > MAX_OPENCODE_SKILLS) {
    throw new Error(`OpenCode customization may include at most ${MAX_OPENCODE_SKILLS} skills.`);
  }

  const plugins: string[] = [];
  const pluginSet = new Set<string>();
  for (const plugin of value.plugins) {
    if (typeof plugin !== "string" || plugin.trim() !== plugin || !NPM_PACKAGE_WITH_OPTIONAL_VERSION_REGEX.test(plugin)) {
      throw new Error("OpenCode plugins must be npm package names with optional semver suffixes.");
    }
    if (pluginSet.has(plugin)) throw new Error(`Duplicate OpenCode plugin: ${plugin}`);
    pluginSet.add(plugin);
    plugins.push(plugin);
  }

  const skills: OpenCodeUserCustomization["skills"] = [];
  const skillSet = new Set<string>();
  for (const skill of value.skills) {
    if (typeof skill !== "object" || skill === null) throw new Error("Invalid OpenCode skill.");
    const { name, description, instructions } = skill;
    if (typeof name !== "string" || name.length > MAX_OPENCODE_SKILL_NAME_LENGTH || !OPENCODE_SKILL_NAME_REGEX.test(name)) {
      throw new Error("OpenCode skill names must be lowercase kebab-case and at most 64 characters.");
    }
    if (skillSet.has(name)) throw new Error(`Duplicate OpenCode skill: ${name}`);
    if (typeof description !== "string" || description.length < 1 || description.length > MAX_OPENCODE_SKILL_DESCRIPTION_LENGTH) {
      throw new Error("OpenCode skill descriptions must be between 1 and 1024 characters.");
    }
    if (typeof instructions !== "string" || instructions.length < 1 || instructions.length > MAX_OPENCODE_SKILL_INSTRUCTIONS_LENGTH) {
      throw new Error("OpenCode skill instructions must be between 1 and 65536 characters.");
    }
    skillSet.add(name);
    skills.push({ name, description, instructions });
  }

  const result = { plugins, skills };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_OPENCODE_CUSTOMIZATION_BYTES) {
    throw new Error("OpenCode customization is too large.");
  }
  return result;
}
