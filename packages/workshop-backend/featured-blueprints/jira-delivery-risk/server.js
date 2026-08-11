import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "jira-delivery-risk:v2";
const MAX_STORED_RECORDS = 400;
const MAX_IMPORT_RECORDS = 200;
const MAX_LIVE_RECORDS_PER_SYNC = 200;
const MAX_INPUT_TEXT = 256 * 1024;

const CONNECTORS = [
  { key: "LINEAR_WORKSPACE", label: "Linear workspace", kind: "linear-list", purpose: "Workspace-wide issues for delivery risk scanning" },
  { key: "LINEAR_TEAM", label: "Linear team", kind: "linear-list", purpose: "Team-scoped issues for delivery risk scanning" },
  { key: "LINEAR_ISSUE", label: "Linear issue", kind: "presence", purpose: "Single Linear issue; connected but not listable" },
  { key: "GITHUB_REPO", label: "GitHub repo", kind: "github-repo", purpose: "Repository issues and pull requests" },
  { key: "GITHUB_ISSUE", label: "GitHub issue", kind: "presence", purpose: "Single GitHub issue; connected but not listable" },
  { key: "GITHUB_PULL_REQUEST", label: "GitHub pull request", kind: "presence", purpose: "Single GitHub PR; connected but not listable" },
  { key: "GMAIL_INBOX", label: "Gmail inbox", kind: "presence", purpose: "Stakeholder threads; detected for context but not imported by the risk starter" },
  { key: "GMAIL_SEARCH", label: "Gmail search", kind: "presence", purpose: "Stakeholder search scope; detected for context but not imported by the risk starter" },
  { key: "GMAIL_LABEL", label: "Gmail label", kind: "presence", purpose: "Stakeholder label scope; detected for context but not imported by the risk starter" },
  { key: "TEAM_PI", label: "Team PI", kind: "presence", purpose: "Planning confidence and team context; detected for future agent workflows" },
  { key: "JARVIS", label: "JARVIS", kind: "presence", purpose: "Internal launch docs and playbooks; detected for future agent workflows" },
  { key: "JIRA_ROUTE", label: "Jira", kind: "route", purpose: "No native Jira binding is bundled. Use Linear for native issue lists, or add a vetted MCP Jira resource from Connections." },
];

const DEMO_RECORDS = [
  { title: "Identity API migration has unowned rollback plan", program: "Enterprise Admin", release: "2026.08 Control Plane", status: "critical", probability: 72, impact: 91, owner: "Priya Shah", dueDate: "2026-08-14", summary: "Jira epic shows auth migration complete, but GitHub release checklist has no named rollback owner for customer tenants.", mitigation: "Assign rollback commander, run tenant replay in staging, and attach signed runbook before release freeze.", tags: ["identity", "rollback", "release-freeze"], source: "demo", links: ["JIRA-CP-1420", "GH-8124"] },
  { title: "Mobile SDK docs lag implementation by two versions", program: "Developer Platform", release: "SDK 5.0", status: "watch", probability: 48, impact: 64, owner: "Theo Martin", dueDate: "2026-08-21", summary: "Linear project is green, but launch email draft still references deprecated token exchange steps.", mitigation: "Block GA announcement on docs review and add migration snippet to release notes.", tags: ["docs", "sdk", "launch"], source: "demo", links: ["LIN-932", "GMAIL-launch-demo"] },
  { title: "Database migration checks saturate CI minutes", program: "Billing Core", release: "Q3 Monetization", status: "blocked", probability: 66, impact: 78, owner: "Nora Ali", dueDate: "2026-08-16", summary: "GitHub checks are timing out on migration matrix; Jira dependency says infra capacity decision is pending.", mitigation: "Split migration checks into nightly and release-gate suites; request temporary runner quota.", tags: ["ci", "migration", "billing"], source: "demo", links: ["GH-7901", "JIRA-BILL-554"] },
  { title: "Customer beta feedback not triaged into launch scope", program: "Analytics Workspace", release: "Beta 3", status: "monitoring", probability: 38, impact: 58, owner: "Lena Ortiz", dueDate: "2026-08-27", summary: "Gmail threads contain three enterprise asks not represented in Jira. Product wants an explicit accept/defer decision.", mitigation: "Create scope decision log and tag launch-blocking feedback by Friday.", tags: ["beta", "scope", "customer-feedback"], source: "demo", links: ["GMAIL-beta-demo"] },
];

function nowIso() { return new Date().toISOString(); }
function boundedText(value, limit) { return String(value ?? "").slice(0, limit); }
function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}
function clampScore(value, fallback) { return Math.max(0, Math.min(100, Number(value ?? fallback) || 0)); }
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
  let probability = clampScore(input.probability, 50);
  let impact = clampScore(input.impact, 50);
  return {
    id: typeof input.id === "string" && input.id ? input.id : crypto.randomUUID(),
    title: boundedText(input.title || "Untitled delivery risk", 180),
    program: boundedText(input.program || input.project || input.repository || "Unassigned program", 120),
    release: boundedText(input.release || input.milestone || "Unscheduled", 120),
    status: ["new", "watch", "monitoring", "blocked", "critical", "mitigated"].includes(input.status) ? input.status : "new",
    probability,
    impact,
    score: Math.round((probability * impact) / 100),
    owner: boundedText(input.owner || input.assignee?.name || input.author?.name || "Unassigned", 100),
    dueDate: boundedText(input.dueDate || input.deadline || "", 40),
    summary: boundedText(input.summary || input.description || input.url || "", 1200),
    mitigation: boundedText(input.mitigation || "", 700),
    tags: splitList(input.tags || input.labels).slice(0, 12),
    links: splitList(input.links || input.url || input.identifier || input.number).slice(0, 12),
    source: boundedText(input.source || source, 60),
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

function fromLinearIssue(issue, boundName) {
  let state = issue.state?.name || issue.status || "";
  return normalizeRecord({
    id: issue.id || issue.identifier,
    title: issue.title,
    program: issue.project?.name || issue.team?.name || "Linear",
    release: issue.cycle?.name || issue.milestone || "Unscheduled",
    status: /blocked/i.test(state) ? "blocked" : /done|closed|complete/i.test(state) ? "mitigated" : "watch",
    probability: /blocked|urgent|critical/i.test(`${state} ${issue.priorityLabel || ""}`) ? 75 : 45,
    impact: issue.priority ? Math.min(100, 40 + Number(issue.priority) * 12) : 55,
    owner: issue.assignee?.name,
    dueDate: issue.dueDate,
    summary: issue.description || issue.url || issue.identifier,
    tags: ["linear", ...(issue.labels || []).map((label) => label.name || label)],
    links: [issue.url, issue.identifier].filter(Boolean),
    source: `${boundName}: Linear`,
  }, `${boundName}: Linear`);
}

function fromGitHubIssue(issue, boundName) {
  return normalizeRecord({
    id: issue.id || issue.number,
    title: issue.title,
    program: issue.repository || "GitHub",
    release: issue.milestone?.title || "Unscheduled",
    status: issue.state === "closed" ? "mitigated" : /blocked|risk/i.test((issue.labels || []).join(" ")) ? "blocked" : "watch",
    probability: /blocked|risk/i.test((issue.labels || []).join(" ")) ? 70 : 42,
    impact: 60,
    owner: issue.assignee?.login || issue.author?.login,
    summary: issue.body || issue.url || issue.number,
    tags: ["github", ...(issue.labels || []).map((label) => label.name || label)],
    links: [issue.url, issue.number].filter(Boolean),
    source: `${boundName}: GitHub issues`,
  }, `${boundName}: GitHub issues`);
}

function fromGitHubPullRequest(pr, boundName) {
  let labels = (pr.labels || []).map((label) => label.name || label);
  return normalizeRecord({
    id: pr.id || pr.number,
    title: pr.title,
    program: pr.repository || "GitHub",
    release: pr.baseRef || pr.milestone?.title || "Unscheduled",
    status: pr.state === "closed" || pr.merged ? "mitigated" : /blocked|risk/i.test(labels.join(" ")) ? "blocked" : "monitoring",
    probability: pr.isDraft ? 35 : 52,
    impact: /release|migration|breaking/i.test(`${pr.title} ${labels.join(" ")}`) ? 75 : 55,
    owner: pr.author?.login,
    summary: pr.body || pr.url || pr.number,
    tags: ["github", "pull-request", ...labels],
    links: [pr.url, pr.number].filter(Boolean),
    source: `${boundName}: GitHub PRs`,
  }, `${boundName}: GitHub PRs`);
}

export class Gadget extends DurableObject {
  async #read() { return await this.ctx.storage.get(STORAGE_KEY) || { records: [], skippedConnectors: {}, initializedAt: nowIso() }; }
  async #write(state) { state.records = compactRecords(state.records || []); state.updatedAt = nowIso(); await this.ctx.storage.put(STORAGE_KEY, state); return state; }
  #connectorStatus(state) {
    return CONNECTORS.map((connector) => {
      let boundName = this.env?.[connector.key] ? connector.key : undefined;
      if (state.skippedConnectors?.[connector.key]) return { ...connector, boundName, status: "skipped", instruction: "Skipped for this radar. Re-enable when you are ready to connect a source." };
      if (connector.kind === "route") return { ...connector, status: "unavailable", instruction: connector.purpose };
      if (boundName) {
        let listable = connector.kind === "linear-list" || connector.kind === "github-repo";
        return { ...connector, boundName, status: "connected", listable, instruction: listable ? `Detected ${boundName}. Sync will use documented read methods only.` : `Detected ${boundName}; this resource is connected but does not provide list import for this starter.` };
      }
      return { ...connector, status: "missing", instruction: `Optional. Add this connection in the host Connections tab and wire it to this gadget as ${connector.key}.` };
    });
  }
  #metrics(records) {
    let active = records.filter((r) => r.status !== "mitigated");
    return { total: records.length, active: active.length, critical: active.filter((r) => r.status === "critical" || r.score >= 75).length, blocked: active.filter((r) => r.status === "blocked").length, avgScore: active.length ? Math.round(active.reduce((sum, r) => sum + r.score, 0) / active.length) : 0, overdue: active.filter((r) => r.dueDate && new Date(r.dueDate) < new Date()).length };
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
        if (connector.kind === "linear-list") {
          records = (await consumeCursor(
              this.env[connector.key].listIssues({ resultsPerPage: 50 }), 50))
              .map((issue) => fromLinearIssue(issue, connector.key));
        } else if (connector.kind === "github-repo") {
          let issues = await consumeCursor(this.env.GITHUB_REPO.listIssues({ state: "open", resultsPerPage: 50 }), 100);
          let pulls = await consumeCursor(this.env.GITHUB_REPO.listPullRequests({ state: "open", resultsPerPage: 50 }), 100);
          records = [...issues.map((issue) => fromGitHubIssue(issue, connector.key)), ...pulls.map((pr) => fromGitHubPullRequest(pr, connector.key))];
        }
        let remaining = Math.max(0, MAX_LIVE_RECORDS_PER_SYNC - imported.length);
        records = records.slice(0, remaining);
        imported.push(...records);
        results.push({ key: connector.key, boundName: connector.key, status: "connected", imported: records.length, message: records.length ? "Imported connector-provided risks." : "Connected; this binding is non-listable or returned no risks." });
      } catch (error) {
        results.push({ key: connector.key, boundName: connector.key, status: "unavailable", imported: 0, message: error?.message || "Connector read failed safely." });
      }
    }
    let merged = mergeRecords(state.records, imported);
    state.records = merged.records; await this.#write(state);
    return { state: await this.getState(), results, truncated: merged.truncated };
  }
}
