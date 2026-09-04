import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "support-escalation-cockpit:v2";
const MAX_STORED_RECORDS = 400;
const MAX_IMPORT_RECORDS = 200;
const MAX_LIVE_RECORDS_PER_SYNC = 200;
const MAX_INPUT_TEXT = 256 * 1024;
const BRANDS = ["totango", "catalyst", "unison", "unspecified"];
const SLA_STATES = ["unknown", "on-track", "at-risk", "breached", "met"];
const HANDOFF_STATES = ["none", "support", "customer-success", "engineering", "product", "resolved"];

const CONNECTORS = [
  { key: "GMAIL_INBOX", label: "Gmail inbox", kind: "gmail-list", purpose: "Recent mailbox threads that may contain customer escalations" },
  { key: "GMAIL_SEARCH", label: "Gmail search", kind: "gmail-search", purpose: "A scoped Gmail search resource for escalation mail" },
  { key: "GMAIL_LABEL", label: "Gmail label", kind: "gmail-list", purpose: "A scoped Gmail label such as Escalations or Exec Follow-up" },
  { key: "ZENDESK", label: "Zendesk", kind: "zendesk-list", purpose: "Native Zendesk ticket search for support escalations" },
  { key: "JARVIS", label: "JARVIS", kind: "presence", purpose: "Internal knowledge and runbook lookup; detected for future agent workflows" },
  { key: "LINEAR_WORKSPACE", label: "Linear workspace", kind: "linear-list", purpose: "Workspace-wide engineering delivery links" },
  { key: "LINEAR_TEAM", label: "Linear team", kind: "linear-list", purpose: "Team-scoped engineering delivery links" },
  { key: "LINEAR_ISSUE", label: "Linear issue", kind: "presence", purpose: "Single linked engineering issue; connected but not listable" },
  { key: "JIRA_SITE", label: "Jira", kind: "presence", purpose: "Native Jira site for linked engineering work" },
];

const DEMO_RECORDS = [
  { title: "Enterprise SSO outage blocks renewal champion", customer: "Acme Financial", brand: "totango", customerRef: "acct-acme-financial", severity: "sev1", status: "war-room", owner: "Maya Chen", source: "demo", sourceRefs: ["demo:zendesk:18422", "demo:jira:IAM-9081"], deadline: "2026-08-13", slaDeadline: "2026-08-13T12:00:00.000Z", slaState: "breached", lastCustomerTouch: "2026-08-11", followUpDate: "2026-08-12", summary: "SAML metadata rotation failed for 4 production tenants. Customer executive asks for hourly status until login is restored.", nextStep: "Confirm hotfix rollout and send executive-ready root cause summary.", resolutionEvidence: "Awaiting hotfix verification.", handoffState: "engineering", confidence: 0.88, tags: ["sso", "renewal", "executive"], links: ["ZD-18422", "JIRA-IAM-9081"], zendeskLinks: ["ZD-18422"], engineeringLinks: ["JIRA-IAM-9081"], impact: 94 },
  { title: "API latency regression after analytics launch", customer: "Northwind Commerce", brand: "unison", customerRef: "acct-northwind", severity: "sev2", status: "investigating", owner: "Owen Patel", source: "demo", sourceRefs: ["demo:zendesk:18377", "demo:github:5120"], deadline: "2026-08-15", slaDeadline: "2026-08-15T12:00:00.000Z", slaState: "at-risk", lastCustomerTouch: "2026-08-10", followUpDate: "2026-08-14", summary: "P95 latency doubled for bulk order imports. Support suspects a new analytics query path and needs engineering validation.", nextStep: "Attach traces and decide whether to disable the analytics enrichment flag.", resolutionEvidence: "Trace bundle attached; engineering owner assigned.", handoffState: "engineering", confidence: 0.74, tags: ["api", "latency", "launch"], links: ["ZD-18377", "GH-5120"], zendeskLinks: ["ZD-18377"], engineeringLinks: ["GH-5120"], impact: 77 },
  { title: "Data residency clarification for security review", customer: "Helios Health", brand: "catalyst", customerRef: "acct-helios", severity: "sev3", status: "waiting-customer", owner: "Iris Ng", source: "demo", sourceRefs: ["demo:gmail:thread-22"], deadline: "2026-08-20", slaDeadline: "2026-08-20T12:00:00.000Z", slaState: "on-track", lastCustomerTouch: "2026-08-09", followUpDate: "2026-08-18", summary: "Procurement needs a final answer on support transcript retention before contract signature.", nextStep: "Route approved language from legal and attach the residency diagram.", resolutionEvidence: "Legal-approved language linked in source reference.", handoffState: "customer-success", confidence: 0.67, tags: ["security", "legal", "procurement"], links: ["GMAIL-thread-demo-22"], impact: 42 },
  { title: "Premium support callback missed twice", customer: "Globex Manufacturing", brand: "unspecified", customerRef: "acct-globex", severity: "sev2", status: "at-risk", owner: "Sam Rivera", source: "demo", sourceRefs: ["demo:zendesk:18409"], deadline: "2026-08-12", slaDeadline: "2026-08-12T12:00:00.000Z", slaState: "breached", lastCustomerTouch: "2026-08-11", followUpDate: "2026-08-12", summary: "Customer success escalated after two missed callback windows. Need recovery plan and owner handoff.", nextStep: "Schedule named owner bridge and document follow-up SLA in account notes.", resolutionEvidence: "Named callback bridge scheduled.", handoffState: "support", confidence: 0.81, tags: ["sla", "cs", "handoff"], links: ["ZD-18409"], zendeskLinks: ["ZD-18409"], impact: 69 },
];

function nowIso() { return new Date().toISOString(); }
function boundedText(value, limit) { return String(value ?? "").slice(0, limit); }
function firstValue(input, keys) {
  for (let key of keys) if (input?.[key] !== undefined && input[key] !== null && input[key] !== "") return input[key];
  return undefined;
}
function normalizeList(value, limit = 12, itemLimit = 220) {
  let values = [];
  if (Array.isArray(value)) values = value;
  else if (typeof value === "string") values = value.split(/[;,\n]/);
  else if (value !== undefined && value !== null) values = [value];
  let seen = new Set();
  let normalized = [];
  for (let item of values) {
    let text = boundedText(item, itemLimit).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
    if (normalized.length >= limit) break;
  }
  return normalized;
}
function normalizeTags(value) {
  let values = [];
  if (Array.isArray(value)) values = value;
  else if (typeof value === "string") values = value.split(/[;,]/);
  else if (value !== undefined && value !== null) values = [value];
  return values.map((tag) => boundedText(tag, 80).trim()).filter(Boolean).slice(0, 12);
}
function normalizeEnum(value, allowed, fallback, aliases = {}) {
  let key = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  key = aliases[key] || key;
  return allowed.includes(key) ? key : fallback;
}
function normalizeConfidence(value) {
  let n = Number(value ?? 0.5);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
function addLists(...lists) {
  return normalizeList(lists.flatMap((list) => normalizeList(list, 24)), 12, 220);
}
function normalizeHeader(header) {
  return header.trim().replace(/^\uFEFF/u, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
function normalizeCsvRow(row) {
  let aliases = {
    account_name: "accountName", account_ref: "accountRef", account_id: "accountId",
    brand_name: "brand", ticket: "ticketId", ticket_id: "ticketId", ticket_url: "ticketUrl",
    zendesk_ticket: "zendeskTicket", zendesk_ticket_url: "zendeskTicketUrl", native_link: "nativeLink",
    engineering_issue: "engineeringIssue", eng_issue: "engineeringIssue", jira_issue: "jiraIssue", github_issue: "githubIssue",
    sla_state: "slaState", sla_deadline: "slaDeadline", last_customer_touch: "lastCustomerTouch",
    last_customer_touch_at: "lastCustomerTouchAt", follow_up: "followUpDate", follow_up_date: "followUpDate",
    resolution: "resolutionEvidence", resolution_evidence: "resolutionEvidence", handoff_state: "handoffState",
    source_ref: "sourceRef", source_refs: "sourceRefs", source_url: "sourceUrl",
  };
  let out = {};
  for (let [key, value] of Object.entries(row)) out[aliases[normalizeHeader(key)] || key] = value;
  return out;
}
function dateText(value) { return boundedText(value || "", 40).trim(); }
function compactRecords(records) { return records.slice(0, MAX_STORED_RECORDS); }
function withoutDemo(records) { return records.filter((record) => record.source !== "demo"); }
function recordIdentity(record) {
  return [record.source, record.sourceRefs?.[0], record.zendeskLinks?.[0], record.engineeringLinks?.[0], record.links?.[0], record.customerRef, record.title].filter(Boolean).join("\n");
}
function mergeRecords(existing, incoming) {
  let records = [...existing];
  let indexes = new Map(records.map((record, index) => [recordIdentity(record), index]));
  let additions = [];
  let additionIndexes = new Map();
  let accepted = 0;
  for (let record of incoming) {
    let key = recordIdentity(record);
    let index = indexes.get(key);
    if (index !== undefined) {
      records[index] = {...records[index], ...record, id: records[index].id,
        createdAt: records[index].createdAt};
      accepted++;
    } else if (additionIndexes.has(key)) {
      let additionIndex = additionIndexes.get(key);
      additions[additionIndex] = {...additions[additionIndex], ...record,
        id: additions[additionIndex].id, createdAt: additions[additionIndex].createdAt};
      accepted++;
    } else if (records.length + additions.length < MAX_STORED_RECORDS) {
      additionIndexes.set(key, additions.length);
      additions.push(record);
      accepted++;
    }
  }
  return {records: [...additions, ...records], accepted, truncated: accepted < incoming.length};
}
function normalizeRecord(input, source = "manual") {
  input = input && typeof input === "object" ? input : {};
  input = {...normalizeCsvRow(input), ...input};
  let id = typeof input.id === "string" && input.id ? input.id : crypto.randomUUID();
  let sourceRefs = addLists(firstValue(input, ["sourceRefs", "sourceReferences", "provenance", "sourceRef"]), firstValue(input, ["sourceUrl", "sourceLink"]));
  let zendeskLinks = addLists(input.zendeskLinks, input.zendeskTicket, input.zendeskTicketUrl, input.zendeskUrl, input.ticketUrl, input.nativeLink, input.ticketId);
  let engineeringLinks = addLists(input.engineeringLinks, input.engineeringIssue, input.engIssue, input.jiraIssue, input.linearIssue, input.githubIssue);
  let links = addLists(input.links || input.url || input.identifier || input.id, zendeskLinks, engineeringLinks);
  let slaDeadline = dateText(firstValue(input, ["slaDeadline", "deadline", "dueDate", "due"]));
  return {
    id,
    title: boundedText(firstValue(input, ["title", "subject", "summary", "name"]) || "Untitled escalation", 160),
    customer: boundedText(firstValue(input, ["customer", "accountName", "account", "organization", "requester"]) || "Unknown customer", 120),
    customerRef: boundedText(firstValue(input, ["customerRef", "accountRef", "accountId", "customerId", "orgId"]) || "", 120),
    brand: normalizeEnum(firstValue(input, ["brand", "product", "lineOfBusiness"]), BRANDS, "unspecified"),
    severity: normalizeEnum(input.severity, ["sev1", "sev2", "sev3", "sev4"], "sev3", {p0: "sev1", p1: "sev1", p2: "sev2", p3: "sev3", p4: "sev4"}),
    status: normalizeEnum(input.status, ["new", "investigating", "war-room", "waiting-customer", "at-risk", "resolved"], "new"),
    owner: boundedText(firstValue(input, ["owner", "assignee", "agent"]) || "Unassigned", 100),
    source: boundedText(input.source || source, 60),
    sourceRefs,
    zendeskLinks,
    customerLink: boundedText(firstValue(input, ["customerLink", "accountUrl", "customerUrl"]) || "", 220),
    engineeringLinks,
    deadline: dateText(firstValue(input, ["deadline", "dueDate", "due", "slaDeadline"]) || slaDeadline),
    slaDeadline,
    slaState: normalizeEnum(firstValue(input, ["slaState", "sla", "slaStatus"]), SLA_STATES, "unknown", {"at risk": "at-risk", atrisk: "at-risk", breached: "breached", breach: "breached", met: "met", ok: "on-track", ontrack: "on-track"}),
    lastCustomerTouch: dateText(firstValue(input, ["lastCustomerTouch", "lastCustomerTouchAt", "lastReplyAt", "lastCustomerReply"])),
    followUpDate: dateText(firstValue(input, ["followUpDate", "followUp", "nextFollowUp"])),
    resolutionEvidence: boundedText(firstValue(input, ["resolutionEvidence", "resolution", "evidence"]) || "", 700),
    handoffState: normalizeEnum(firstValue(input, ["handoffState", "handoff"]), HANDOFF_STATES, "none", {cs: "customer-success", csm: "customer-success", eng: "engineering"}),
    confidence: normalizeConfidence(input.confidence),
    summary: boundedText(input.summary || input.snippet || input.description || "", 1200),
    nextStep: boundedText(input.nextStep || input.mitigation || "", 500),
    tags: normalizeTags(input.tags || input.labels),
    links,
    impact: Math.max(0, Math.min(100, Number(input.impact ?? 50) || 0)),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : nowIso(),
    updatedAt: nowIso(),
  };
}

function parseCsv(text) {
  let rows = [], row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    let char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  row.push(field); rows.push(row);
  let [headers = [], ...body] = rows.filter((r) => r.some((cell) => cell.trim()));
  return body.map((cells) => normalizeCsvRow(Object.fromEntries(headers.map((header, index) => [header.trim(), cells[index] || ""]))));
}

function knownList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (let key of ["items", "results", "records", "tickets", "messages", "threads", "data"]) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  return [];
}

async function consumeCursor(cursorPromise, limit) {
  let cursor = await cursorPromise;
  let rows = [];
  try {
    while (rows.length < limit) {
      let batch = await cursor.next();
      if (!batch || !Array.isArray(batch) || batch.length === 0) break;
      rows.push(...batch.slice(0, limit - rows.length));
    }
  } finally {
    cursor?.[Symbol.dispose]?.();
  }
  return rows;
}

function disposeGmailThreads(entries) {
  for (let entry of entries) entry?.thread?.[Symbol.dispose]?.();
}

function fromGmailEntry(entry, boundName) {
  let info = entry?.info || entry || {};
  return normalizeRecord({
    id: info.id,
    title: info.subject,
    customer: info.from?.name || info.from?.address || "Gmail thread",
    source: `${boundName}: Gmail`,
    summary: info.snippet,
    links: info.id,
    sourceRefs: info.id,
    tags: ["gmail", boundName],
    impact: 45,
  }, `${boundName}: Gmail`);
}

function fromIssue(issue, boundName) {
  return normalizeRecord({
    id: issue.id || issue.identifier || issue.number,
    title: issue.title,
    customer: issue.project?.name || issue.team?.name || "Engineering",
    status: /done|closed|complete/i.test(issue.state?.name || issue.status || "") ? "resolved" : "investigating",
    owner: issue.assignee?.name || issue.assigneeName || "Unassigned",
    source: `${boundName}: Linear`,
    summary: issue.description || issue.url || issue.identifier,
    tags: ["linear", ...(issue.labels || []).map((l) => l.name || l)],
    links: [issue.url, issue.identifier].filter(Boolean),
    engineeringLinks: [issue.url, issue.identifier].filter(Boolean),
    sourceRefs: issue.id || issue.url || issue.identifier,
    impact: 55,
  }, `${boundName}: Linear`);
}

function fromUnknown(row, label) {
  if (!row || typeof row !== "object") return null;
  return normalizeRecord({
    id: row.id || row.ticketId || row.messageId || row.url,
    title: row.title || row.subject || row.summary || row.name,
    customer: row.customer || row.account || row.requester || row.from?.name || row.from?.address,
    owner: row.owner || row.assignee || row.agent,
    source: label,
    sourceRefs: row.sourceRefs || row.sourceRef || row.provenance || row.sourceUrl,
    summary: row.summary || row.snippet || row.description || row.body,
    tags: row.tags || row.labels,
    links: row.links || row.url || row.id,
    zendeskLinks: row.zendeskLinks || row.ticketUrl || row.zendeskTicketUrl || row.ticketId,
    engineeringLinks: row.engineeringLinks || row.engineeringIssue || row.jiraIssue || row.linearIssue || row.githubIssue,
    impact: row.impact,
  }, label);
}

export class Gadget extends DurableObject {
  async #read() { return await this.ctx.storage.get(STORAGE_KEY) || { records: [], skippedConnectors: {}, initializedAt: nowIso() }; }
  async #write(state) { state.records = compactRecords(state.records || []); state.updatedAt = nowIso(); await this.ctx.storage.put(STORAGE_KEY, state); return state; }
  #hasBinding(key) { return !!this.env?.[key]; }
  #connectorStatus(state) {
    return CONNECTORS.map((connector) => {
      let boundName = this.#hasBinding(connector.key) ? connector.key : undefined;
      if (state.skippedConnectors?.[connector.key]) return { ...connector, boundName, status: "skipped", instruction: "Skipped for this workspace. Re-enable it here if you want to wire a source later." };
      if (connector.kind === "route") return { ...connector, status: "unavailable", instruction: connector.purpose };
      if (boundName) {
        let listable = !["presence"].includes(connector.kind);
        return { ...connector, boundName, status: "connected", listable, instruction: listable ? `Detected ${boundName}. Sync will use documented read methods only.` : `Detected ${boundName}; this resource is connected but does not provide list import for this starter.` };
      }
      return { ...connector, status: "missing", instruction: `Optional. Add this connection in the host Connections tab and wire it to this gadget as ${connector.key}.` };
    });
  }
  #metrics(records) {
    let open = records.filter((r) => r.status !== "resolved");
    let now = new Date();
    let overdue = open.filter((r) => (r.slaDeadline || r.deadline) && new Date(r.slaDeadline || r.deadline) < now);
    return { total: records.length, open: open.length, sev1: open.filter((r) => r.severity === "sev1").length, overdue: overdue.length, breached: open.filter((r) => r.slaState === "breached").length, followUpsDue: open.filter((r) => r.followUpDate && new Date(r.followUpDate) <= now).length, avgImpact: open.length ? Math.round(open.reduce((sum, r) => sum + r.impact, 0) / open.length) : 0, avgConfidence: open.length ? Math.round(open.reduce((sum, r) => sum + (r.confidence ?? 0.5), 0) / open.length * 100) : 0 };
  }
  async getState() { let state = await this.#read(); return { ...state, connectors: this.#connectorStatus(state), metrics: this.#metrics(state.records || []) }; }
  async saveRecord(record) {
    let state = await this.#read(); let normalized = normalizeRecord(record);
    let index = state.records.findIndex((item) => item.id === normalized.id);
    if (index >= 0) state.records[index] = { ...state.records[index], ...normalized, createdAt: state.records[index].createdAt };
    else state.records.unshift(normalized);
    await this.#write(state); return this.getState();
  }
  async deleteRecord(id) { let state = await this.#read(); state.records = state.records.filter((record) => record.id !== id); await this.#write(state); return this.getState(); }
  async importText(text, format = "json") {
    text = String(text || "");
    if (text.length > MAX_INPUT_TEXT) throw new Error("Import text is too large. Keep it under 256 KiB.");
    let parsed = format === "csv" ? parseCsv(text) : JSON.parse(text);
    let incoming = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(incoming)) throw new Error("Import must be an array or an object with a records array.");
    let records = incoming.slice(0, MAX_IMPORT_RECORDS).map((record) => normalizeRecord(record, "import"));
    let state = await this.#read(); let merged = mergeRecords(state.records, records);
    state.records = merged.records; await this.#write(state);
    return { state: await this.getState(), imported: merged.accepted,
      truncated: incoming.length > records.length || merged.truncated };
  }
  async loadDemo() {
    let state = await this.#read();
    state.records = compactRecords([...DEMO_RECORDS.map((record) => normalizeRecord(record, "demo")), ...withoutDemo(state.records)]);
    await this.#write(state); return this.getState();
  }
  async resetDemo() { await this.#write({ records: DEMO_RECORDS.map((record) => normalizeRecord(record, "demo")), skippedConnectors: {}, initializedAt: nowIso() }); return this.getState(); }
  async setConnectorSkipped(key, skipped) { let state = await this.#read(); state.skippedConnectors ||= {}; if (skipped) state.skippedConnectors[key] = true; else delete state.skippedConnectors[key]; await this.#write(state); return this.getState(); }
  async syncSources() {
    let state = await this.#read(); let results = []; let imported = [];
    for (let connector of CONNECTORS) {
      if (state.skippedConnectors?.[connector.key]) {
        results.push({ key: connector.key, boundName: null, status: "skipped", imported: 0,
          message: "Skipped for this workspace." });
        continue;
      }
      if (!this.env?.[connector.key]) { results.push({ key: connector.key, boundName: null, status: connector.kind === "route" ? "unavailable" : "missing", imported: 0, message: connector.kind === "route" ? connector.purpose : "No binding wired." }); continue; }
      try {
        let records = [];
        if (connector.kind === "gmail-list") {
          let entries = await consumeCursor(this.env[connector.key].listThreads(), 20);
          try { records = entries.map((entry) => fromGmailEntry(entry, connector.key)); } finally { disposeGmailThreads(entries); }
        } else if (connector.kind === "gmail-search") {
          let entries = await consumeCursor(this.env[connector.key].search("escalation OR urgent OR incident"), 20);
          try { records = entries.map((entry) => fromGmailEntry(entry, connector.key)); } finally { disposeGmailThreads(entries); }
        } else if (connector.kind === "zendesk-list") {
          records = knownList(await this.env.ZENDESK.searchTickets({ query: "escalation OR priority", limit: 20 }))
              .slice(0, 20).map((row) => fromUnknown(row, "ZENDESK: searchTickets")).filter(Boolean);
        } else if (connector.kind === "linear-list") {
          records = (await consumeCursor(
              this.env[connector.key].listIssues({ resultsPerPage: 20 }), 20))
              .map((issue) => fromIssue(issue, connector.key));
        }
        let remaining = Math.max(0, MAX_LIVE_RECORDS_PER_SYNC - imported.length);
        records = records.slice(0, remaining);
        imported.push(...records);
        results.push({ key: connector.key, boundName: connector.key, status: "connected", imported: records.length, message: records.length ? "Imported connector-provided records." : "Connected; no listable records returned." });
      } catch (error) {
        results.push({ key: connector.key, boundName: connector.key, status: "unavailable", imported: 0, message: error?.message || "Connector read failed safely." });
      }
    }
    let merged = mergeRecords(state.records, imported);
    state.records = merged.records; await this.#write(state);
    return { state: await this.getState(), results, truncated: merged.truncated };
  }
}
