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

/** Strict Zendesk memory partition. All dimensions are required to prevent cross-brand or cross-account recall. */
export type ZendeskTicketMemoryPartition = {
  /** Team PI or provider brand identifier. */
  brandId: string;
  /** Team PI customer/account/organization identifier. */
  accountId: string;
  /** Zendesk subdomain without `.zendesk.com`. */
  subdomain: string;
};

/** Request for an authoritative live Zendesk ticket read. */
export type ZendeskTicketReadRequest = {
  /** Provider-native Zendesk ticket id accepted by Team PI Work Items routes. */
  id: string;
};

/** Minimized non-authoritative Zendesk ticket memory entry stored after successful live reads. */
export type ZendeskTicketMemoryEntry = {
  /** Provider-native Zendesk ticket id. */
  id: string;
  /** Trusted HTTPS `*.zendesk.com` ticket URL, when present on the authoritative read. */
  url?: string;
  /** Bounded Zendesk ticket title or subject. */
  title: string;
  /** Bounded provider status. */
  status?: string;
  /** Bounded provider ticket type. */
  type?: string;
  /** Bounded provider priority. */
  priority?: string;
  /** Exact strict partition used for this memory entry. */
  partition: ZendeskTicketMemoryPartition;
  /** Unix epoch milliseconds when this minimized memory entry was last refreshed from a live read. */
  rememberedAt: number;
};

/** Request for local Zendesk ticket memory search inside one exact strict partition. */
export type ZendeskTicketMemorySearchRequest = {
  /** Exact strict partition to search; memory never falls back to partial or fuzzy partition matching. */
  partition: ZendeskTicketMemoryPartition;
  /** Optional bounded lexical query matched against minimized memory fields only. */
  query?: string;
  /** Maximum entries to return, capped at 25. */
  limit?: number;
};

/** Non-authoritative local Zendesk ticket memory search page. */
export type ZendeskTicketMemorySearchResult = {
  /** Minimized remembered tickets. These may be stale; call readZendeskTicket() before relying on current state. */
  items: ZendeskTicketMemoryEntry[];
};

/** Request for an approval-backed Jira issue creation through Team PI Work Items. */
export type TeamPiCreateJiraIssueRequest = {
  /** Jira project key. Defaults to `AI` when omitted. */
  projectKey?: string;
  /** Jira issue type name. Defaults to `Story` when omitted. */
  issueType?: string;
  /** Required Jira issue summary. */
  summary: string;
  /** Required Jira issue description. */
  description: string;
  /** Optional Jira priority name. */
  priority?: string;
};

/** Safe normalized result of an approved Team PI Jira issue creation. */
export type TeamPiCreateJiraIssueResult = {
  /** Normalized created Jira issue returned by Team PI Work Items. */
  item: WorkItemSummary;
};

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

  /** Requests approval to create a Jira issue through Team PI Work Items. */
  createJiraIssue(request: TeamPiCreateJiraIssueRequest): Promise<TeamPiQueuedAction<TeamPiCreateJiraIssueResult>>;

  /** Polls the result of a previously queued Team PI action. */
  getActionResult(actionId: number): Promise<TeamPiActionResult>;

  /** Searches Jira and Zendesk Work Items as a private read-only observation. */
  workItemsSearch(request: WorkItemSearchRequest): Promise<WorkItemSearchPage>;

  /**
   * Reads the authoritative live Zendesk ticket Work Items model, including detail, comments,
   * activity, update options, transitions, and attachment metadata. When the live ticket includes
   * authoritative brand/account identifiers and a recognized Zendesk ticket URL, minimized
   * non-authoritative memory may be refreshed for later recall.
   */
  readZendeskTicket(request: ZendeskTicketReadRequest): Promise<WorkItemRead>;

  /**
   * Searches non-authoritative minimized local Zendesk ticket memory for one exact strict
   * partition. Results are stale hints only; call readZendeskTicket() before relying on current
   * ticket state, comments, activity, attachments, assignees, requester, or arbitrary fields.
   */
  searchZendeskTicketMemory(request: ZendeskTicketMemorySearchRequest): Promise<ZendeskTicketMemorySearchResult>;
}

/** Team PI Work Items provider kind. */
export type WorkItemProviderKind = "jira" | "zendesk";

/** Stable provider-qualified reference to a work item. */
export type WorkItemProviderRef = {
  /** Source system that owns the item. */
  source: WorkItemProviderKind;
  /** Provider-native item identifier accepted by Team PI Work Items routes. */
  id: string;
  /** Optional human-readable key, such as a Jira issue key. */
  key?: string;
};

/** Current source availability and shared-connection status. */
export type WorkItemSourceStatus = {
  /** Whether Team PI has the deployment-level provider settings required for this source. */
  configured: boolean;
  /** Whether Team PI has a shared connection available for the caller. */
  connected: boolean;
  /** Bounded explanation for an unavailable source. */
  reason?: string;
};

/** Bounded status map for all Team PI Work Items providers. */
export type WorkItemSourceStatuses = Record<WorkItemProviderKind, WorkItemSourceStatus>;

/** Minimal person metadata exposed by normalized provider records. */
export type WorkItemPerson = {
  /** Display name when supplied by the source. */
  name?: string;
  /** Email address when supplied by the source. */
  email?: string;
  /** Provider-native person identifier when no richer metadata is available. */
  id?: string;
};

/** Search-list summary for a Jira issue or Zendesk ticket. */
export type WorkItemSummary = WorkItemProviderRef & {
  /** Trusted provider UI URL, when Team PI can construct one. */
  url?: string;
  /** Bounded title or subject. */
  title: string;
  /** Provider status name. */
  status?: string;
  /** Provider type name. */
  type?: string;
  /** Provider priority name. */
  priority?: string;
  /** Assignee display name or identifier. */
  assignee?: string;
  /** Requester display name or identifier. */
  requester?: string;
  /** Provider update timestamp as an ISO-like string. */
  updatedAt?: string;
  /** Jira project key, when present. */
  projectKey?: string;
  /** First-class normalized description text returned by Team PI, when present. */
  description?: WorkItemDescription;
  /** Allowlisted normalized field values. */
  fields: Record<string, string | number | boolean | null>;
};

/** Normalized provider description content for a work item. */
export type WorkItemDescription = {
  /** Complete or bounded body text in the declared format. */
  body: string;
  /** Text format supplied by the proxy. */
  format: "text" | "markdown";
  /** True when the proxy explicitly truncated the returned description. */
  truncated?: boolean;
};

/** Normalized metadata for an attachment exposed by Team PI. */
export type WorkItemAttachment = {
  /** Provider-native attachment id accepted by readAttachment(). */
  id: string;
  /** Safe display name supplied by the provider. */
  name: string;
  /** Provider content type, when supplied. */
  contentType?: string;
  /** File size in bytes, when supplied. */
  size?: number;
  /** Provider creation timestamp as an ISO-like string. */
  createdAt?: string;
  /** Provider-native comment id associated with the attachment, when supplied. */
  commentId?: string;
};

/** Bounded binary attachment content returned through the Team PI proxy. */
export type WorkItemAttachmentContent = {
  /** Bounded bytes of the attachment content. */
  data: Uint8Array;
  /** Safe display name for the attachment. */
  name: string;
  /** Content type selected from the proxy response, when supplied. */
  contentType?: string;
};

/** Authoritative item detail returned by Team PI. */
export type WorkItemDetail = {
  /** The normalized authoritative item. */
  item: WorkItemSummary;
};

/** Bounded work item comment. */
export type WorkItemComment = {
  /** Provider-native comment id. */
  id: string;
  /** Bounded author display string. */
  author?: string;
  /** Plain text bounded body. */
  body: string;
  /** Whether the comment is public in Zendesk; Jira comments are always public. */
  public: boolean;
  /** Provider creation timestamp as an ISO-like string. */
  createdAt?: string;
};

/** Bounded work item activity entry. */
export type WorkItemActivity = {
  /** Provider-native activity id. */
  id: string;
  /** Provider activity kind, such as changelog or audit. */
  type: string;
  /** Bounded actor display string. */
  author?: string;
  /** Provider creation timestamp as an ISO-like string. */
  createdAt?: string;
  /** Bounded human-readable summary. */
  summary: string;
};

/** Provider-backed field update metadata for one item. */
export type WorkItemUpdateOptions = WorkItemProviderRef & {
  /** Lowercase allowlisted field names accepted by Team PI for this item. */
  allowedFields: string[];
  /** Bounded provider-native editable option names, when available. */
  providerOptions?: string[];
};

/** Jira workflow transition exposed by Team PI. */
export type WorkItemTransition = {
  /** Provider-native transition id. */
  id: string;
  /** Transition display name. */
  name: string;
  /** Destination status name, when supplied. */
  toStatus?: string;
};

/** Full read model for one selected item. */
export type WorkItemRead = {
  /** Authoritative item detail. */
  detail: WorkItemDetail;
  /** Recent provider comments. */
  comments: WorkItemComment[];
  /** Recent provider activity. */
  activity: WorkItemActivity[];
  /** Allowlisted update options. */
  updateOptions: WorkItemUpdateOptions;
  /** Jira workflow transitions; empty for Zendesk. */
  transitions: WorkItemTransition[];
  /** Bounded attachment metadata for the selected item. */
  attachments: WorkItemAttachment[];
};

/** Work item source selector for search. */
export type WorkItemSearchSource = WorkItemProviderKind | "both";

/** Bounded work item search request. */
export type WorkItemSearchRequest = {
  /** Source to search, or both with provider-isolated partial failures. */
  source: WorkItemSearchSource;
  /** Optional provider text query. Empty searches use the provider default. */
  query?: string;
  /** Maximum items per provider, capped by Team PI. */
  limit?: number;
  /** Optional per-provider cursor map. */
  cursors?: Partial<Record<WorkItemProviderKind, string>>;
};

/** Bounded provider search error for partial-result pages. */
export type WorkItemProviderError = {
  /** Provider that failed. */
  source: WorkItemProviderKind;
  /** Bounded non-secret error message. */
  message: string;
  /** HTTP status when Team PI supplied one. */
  status?: number;
};

/** Search page returned by the Work Items management API. */
export type WorkItemSearchPage = {
  /** Normalized items from all successful selected providers. */
  items: WorkItemSummary[];
  /** Next cursors keyed by provider. */
  cursors: Partial<Record<WorkItemProviderKind, string>>;
  /** Whether each provider reported more data. */
  hasMore: Partial<Record<WorkItemProviderKind, boolean>>;
  /** Provider-local failures when searching both. */
  errors?: WorkItemProviderError[];
};

/** Current Team PI Work Items user identity shown in the management UI. */
export type WorkItemsCurrentUser = {
  /** Human-readable display name from the connected Team PI OAuth identity. */
  displayName?: string;
  /** Stable unique user name, usually the connected Team PI OAuth email address. */
  uniqueName?: string;
};

/** Persisted filter selections for a Team PI Work Items saved view. */
export type WorkItemSavedViewFilters = {
  /** Provider status name included by the saved view. */
  status: string;
  /** Provider priority name included by the saved view. */
  priority: string;
  /** Provider work item type name included by the saved view. */
  type: string;
  /** Person display name, email, or identifier included by the saved view. */
  person: string;
};

/** Admin-created Team PI Work Items saved search/view stored on the Team PI account. */
export type WorkItemSavedView = {
  /** Stable user-supplied identifier used for replacement and deletion. */
  id: string;
  /** Human-readable saved view name. */
  name: string;
  /** Provider text query associated with the saved view. */
  query: string;
  /** Source selector searched by the saved view. */
  source: WorkItemSearchSource;
  /** Structured filters applied by the management UI. */
  filters: WorkItemSavedViewFilters;
  /** Preferred saved view presentation. */
  view: "list" | "kanban";
  /** Provider statuses hidden from the saved view. */
  hiddenStatuses: string[];
};

/** Input for adding a provider comment. */
export type WorkItemCommentInput = {
  /** Plain text comment body. */
  body: string;
  /** Visibility override. Zendesk defaults to internal; public must be explicit. Jira allows public only. */
  visibility?: "internal" | "public";
};

/** Bounded allowlisted field patch. */
export type WorkItemFieldPatch = {
  /** Field values keyed by provider field name. */
  fields: Record<string, string | number | boolean | null | string[]>;
};

/** Result of linking a Jira issue and Zendesk ticket through a Jira remote link. */
export type WorkItemLinkResult = {
  /** Stable Team PI remote-link global id. */
  globalId: string;
  /** Jira issue id or key used for the backlink. */
  jiraId: string;
  /** Zendesk ticket id linked from Jira. */
  zendeskTicketId: string;
};

/** Admin-only Team PI Work Items management root capability. */
export interface WorkItemsManagementApi {
  /** Reads the connected Team PI OAuth identity for display in the management UI. */
  getCurrentUser(): Promise<WorkItemsCurrentUser>;
  /** Lists normalized saved Work Items views stored on this Team PI account. */
  listSavedViews(): Promise<WorkItemSavedView[]>;
  /** Saves or replaces one normalized Work Items saved view by its stable user-supplied id. */
  saveSavedView(view: WorkItemSavedView): Promise<WorkItemSavedView>;
  /** Deletes one Work Items saved view by its stable user-supplied id. */
  deleteSavedView(id: string): Promise<void>;
  /** Reads provider configuration and shared-connection statuses. */
  getSourceStatuses(): Promise<WorkItemSourceStatuses>;
  /** Searches Jira, Zendesk, or both; both-provider searches isolate provider failures. */
  search(request: WorkItemSearchRequest): Promise<WorkItemSearchPage>;
  /** Selects one item and returns a narrow per-item capability. The client must dispose it. */
  item(ref: WorkItemProviderRef): Promise<WorkItemManagementApi>;
}

/** Admin-only Team PI Work Items per-item management capability. */
export interface WorkItemManagementApi {
  /** Reads authoritative detail plus comments, activity, update options, and Jira transitions. */
  read(): Promise<WorkItemRead>;
  /** Reads bounded binary content for one attachment id on this item. */
  readAttachment(id: string): Promise<WorkItemAttachmentContent>;
  /** Adds a comment, defaulting Zendesk comments to internal unless public is explicit, then returns refreshed detail. */
  addComment(input: WorkItemCommentInput): Promise<WorkItemDetail>;
  /** Updates allowlisted fields and returns refreshed authoritative detail. */
  updateFields(patch: WorkItemFieldPatch): Promise<WorkItemDetail>;
  /** Applies a Jira transition and returns refreshed authoritative detail. */
  transition(transitionId: string): Promise<WorkItemDetail>;
  /** Links this item to another Jira/Zendesk item by creating the supported Jira backlink. */
  linkTo(other: WorkItemProviderRef): Promise<WorkItemLinkResult>;
}
