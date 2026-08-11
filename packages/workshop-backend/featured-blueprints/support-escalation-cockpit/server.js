import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "support-escalation-cockpit:v2";
const MAX_STORED_RECORDS = 400;
const MAX_IMPORT_RECORDS = 200;
const MAX_LIVE_RECORDS_PER_SYNC = 200;
const MAX_INPUT_TEXT = 256 * 1024;

const CONNECTORS = [
  { key: "GMAIL_INBOX", label: "Gmail inbox", kind: "gmail-list", purpose: "Recent mailbox threads that may contain customer escalations" },
  { key: "GMAIL_SEARCH", label: "Gmail search", kind: "gmail-search", purpose: "A scoped Gmail search resource for escalation mail" },
  { key: "GMAIL_LABEL", label: "Gmail label", kind: "gmail-list", purpose: "A scoped Gmail label such as Escalations or Exec Follow-up" },
  { key: "TEAM_PI", label: "Team PI", kind: "team-pi", purpose: "Team PI searches for Gmail/Zendesk context and team signals" },
  { key: "JARVIS", label: "JARVIS", kind: "presence", purpose: "Internal knowledge and runbook lookup; detected for future agent workflows" },
  { key: "LINEAR_WORKSPACE", label: "Linear workspace", kind: "linear-list", purpose: "Workspace-wide engineering delivery links" },
  { key: "LINEAR_TEAM", label: "Linear team", kind: "linear-list", purpose: "Team-scoped engineering delivery links" },
  { key: "LINEAR_ISSUE", label: "Linear issue", kind: "presence", purpose: "Single linked engineering issue; connected but not listable" },
  { key: "ZENDESK_ROUTE", label: "Zendesk", kind: "route", purpose: "No native Zendesk binding is bundled. Use Team PI zendeskSearch or a vetted MCP resource from Connections." },
  { key: "JIRA_ROUTE", label: "Jira", kind: "route", purpose: "No native Jira binding is bundled. Use a vetted MCP resource from Connections, or connect Linear for native issue lists." },
];

const DEMO_RECORDS = [
  { title: "Enterprise SSO outage blocks renewal champion", customer: "Acme Financial", severity: "sev1", status: "war-room", owner: "Maya Chen", source: "demo", deadline: "2026-08-13", summary: "SAML metadata rotation failed for 4 production tenants. Customer executive asks for hourly status until login is restored.", nextStep: "Confirm hotfix rollout and send executive-ready root cause summary.", tags: ["sso", "renewal", "executive"], links: ["ZD-18422", "JIRA-IAM-9081"], impact: 94 },
  { title: "API latency regression after analytics launch", customer: "Northwind Commerce", severity: "sev2", status: "investigating", owner: "Owen Patel", source: "demo", deadline: "2026-08-15", summary: "P95 latency doubled for bulk order imports. Support suspects a new analytics query path and needs engineering validation.", nextStep: "Attach traces and decide whether to disable the analytics enrichment flag.", tags: ["api", "latency", "launch"], links: ["ZD-18377", "GH-5120"], impact: 77 },
  { title: "Data residency clarification for security review", customer: "Helios Health", severity: "sev3", status: "waiting-customer", owner: "Iris Ng", source: "demo", deadline: "2026-08-20", summary: "Procurement needs a final answer on support transcript retention before contract signature.", nextStep: "Route approved language from legal and attach the residency diagram.", tags: ["security", "legal", "procurement"], links: ["GMAIL-thread-demo-22"], impact: 42 },
  { title: "Premium support callback missed twice", customer: "Globex Manufacturing", severity: "sev2", status: "at-risk", owner: "Sam Rivera", source: "demo", deadline: "2026-08-12", summary: "Customer success escalated after two missed callback windows. Need recovery plan and owner handoff.", nextStep: "Schedule named owner bridge and document follow-up SLA in account notes.", tags: ["sla", "cs", "handoff"], links: ["ZD-18409"], impact: 69 },
];

function nowIso() { return new Date().toISOString(); }
function boundedText(value, limit) { return String(value ?? "").slice(0, limit); }
function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[;,]/).map((tag) => tag.trim()).filter(Boolean);
  return [];
}
function compactRecords(records) { return records.slice(0, MAX_STORED_RECORDS); }
function withoutDemo(records) { return records.filter((record) => record.source !== "demo"); }
function recordIdentity(record) {
  return `${record.source}\n${record.links?.[0] || ""}\n${record.title}`;
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
  let id = typeof input.id === "string" && input.id ? input.id : crypto.randomUUID();
  return {
    id,
    title: boundedText(input.title || input.subject || "Untitled escalation", 160),
    customer: boundedText(input.customer || input.account || input.requester || "Unknown customer", 120),
    severity: ["sev1", "sev2", "sev3", "sev4"].includes(input.severity) ? input.severity : "sev3",
    status: ["new", "investigating", "war-room", "waiting-customer", "at-risk", "resolved"].includes(input.status) ? input.status : "new",
    owner: boundedText(input.owner || input.assignee || "Unassigned", 100),
    source: boundedText(input.source || source, 60),
    deadline: boundedText(input.deadline || input.dueDate || "", 40),
    summary: boundedText(input.summary || input.snippet || input.description || "", 1200),
    nextStep: boundedText(input.nextStep || input.mitigation || "", 500),
    tags: normalizeTags(input.tags || input.labels).slice(0, 12),
    links: normalizeTags(input.links || input.url || input.identifier || input.id).slice(0, 12),
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
  return body.map((cells) => Object.fromEntries(headers.map((header, index) => [header.trim(), cells[index] || ""])));
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
    summary: row.summary || row.snippet || row.description || row.body,
    tags: row.tags || row.labels,
    links: row.links || row.url || row.id,
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
    return { total: records.length, open: open.length, sev1: open.filter((r) => r.severity === "sev1").length, overdue: open.filter((r) => r.deadline && new Date(r.deadline) < new Date()).length, avgImpact: open.length ? Math.round(open.reduce((sum, r) => sum + r.impact, 0) / open.length) : 0 };
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
        } else if (connector.kind === "team-pi") {
          let zendesk = knownList(await this.env.TEAM_PI.zendeskSearch({ query: "escalation OR priority", limit: 20 })).slice(0, 20).map((row) => fromUnknown(row, "TEAM_PI: zendeskSearch")).filter(Boolean);
          let gmail = knownList(await this.env.TEAM_PI.gmailSearch({ query: "escalation OR urgent", limit: 20 })).slice(0, 20).map((row) => fromUnknown(row, "TEAM_PI: gmailSearch")).filter(Boolean);
          records = [...zendesk, ...gmail].slice(0, 20);
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
