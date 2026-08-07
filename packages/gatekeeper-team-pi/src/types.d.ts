/** A bounded result returned when an action has been queued or completed. */
export type TeamPiActionResult<T = unknown> =
  | { status: "pending" }
  | { status: "rejected" }
  | { status: "failed"; message: string }
  | { status: "unknown"; message: string; canRetry: false }
  | { status: "ready"; result: T };

/** A queued Team PI write action that can be polled until it is ready, failed, or rejected. */
export type TeamPiQueuedAction<T = unknown> = { actionId: number; status: "pending"; pollAfterMs: number };

/** Search and pagination options accepted by list-style Team PI reads. */
export type TeamPiListOptions = { query?: string; limit?: number; cursor?: string };

/** Team PI provider kinds that can be connected. */
export type TeamPiProvider = "gmail" | "calendar" | "chorus" | "zendesk" | "salesforce" | "docs";

/** Time-window options for reading calendar events. */
export type TeamPiCalendarOptions = { startIso: string; endIso: string; limit?: number; calendarId?: string };

/** Search options for Gmail, Chorus, Zendesk, and similar Team PI indexes. */
export type TeamPiSearchOptions = { query: string; limit?: number; cursor?: string };

/** Minimal skill metadata exposed by Team PI. */
export type TeamPiSkill = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  status?: string;
  owner?: string;
  tags?: string[];
  requiredConnections?: unknown;
  instructions?: string;
  installed?: boolean;
};

/** Minimal connection metadata exposed by Team PI. */
export type TeamPiConnection = { id?: string; name: string; provider: TeamPiProvider | "unknown"; scope: "user" | "shared" | "token"; status: "connected" | "configured" | "missing" | "unknown" };

/** Result of checking a skill against available connections. */
export type TeamPiSkillCheck = { skillId: string; requiredConnections: unknown; status: unknown };

/** Agent-facing Team PI per-user API. */
export interface TeamPiSession {
  /** Lists available Team PI skills, optionally filtered by query. */
  listSkills(options?: TeamPiListOptions): Promise<{ items: TeamPiSkill[]; nextCursor?: string }>;

  /** Gets one Team PI skill by ID. */
  getSkill(skillId: string): Promise<TeamPiSkill>;

  /** Checks whether a Team PI skill is installable and ready for this user. */
  checkSkill(skillId: string): Promise<TeamPiSkillCheck>;

  /** Lists the user's Team PI connections. */
  listConnections(options?: TeamPiListOptions): Promise<{ items: TeamPiConnection[]; nextCursor?: string }>;

  /** Reads calendar events in an ISO timestamp window. */
  calendarEvents(options: TeamPiCalendarOptions): Promise<unknown[]>;

  /** Searches Gmail messages available to Team PI. */
  gmailSearch(options: TeamPiSearchOptions): Promise<unknown>;

  /** Reads a single Gmail message available to Team PI. */
  gmailMessage(messageId: string): Promise<unknown>;

  /** Searches Chorus records available to Team PI. */
  chorusSearch(options: TeamPiSearchOptions): Promise<unknown>;

  /** Reads a Chorus account by ID. */
  chorusAccount(accountId: string): Promise<unknown>;

  /** Reads a Chorus engagement by ID. */
  chorusEngagement(engagementId: string): Promise<unknown>;

  /** Reads a Chorus conversation by ID. */
  chorusConversation(conversationId: string): Promise<unknown>;

  /** Searches Zendesk tickets available to Team PI. */
  zendeskSearch(options: TeamPiSearchOptions): Promise<unknown>;

  /** Reads a Zendesk ticket by ID. */
  zendeskTicket(ticketId: string): Promise<unknown>;

  /** Reads a Salesforce account by ID. */
  salesforceAccount(accountId: string): Promise<unknown>;

  /** Requests installation of a Team PI skill by ID. */
  installSkill(skillId: string): Promise<TeamPiQueuedAction>;

  /** Requests start of a Team PI connection by provider kind, such as `gmail` or `calendar`. */
  startConnection(provider: TeamPiProvider): Promise<TeamPiQueuedAction>;

  /** Polls the result of a previously queued Team PI action. */
  getActionResult(actionId: number): Promise<TeamPiActionResult>;
}
