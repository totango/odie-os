import { DurableObject } from "cloudflare:workers";

const STATE_KEY = "incident-board:v1";
const MAX_RECORDS = 300;
const MAX_IMPORT_RECORDS = 100;
const MAX_IMPORT_BYTES = 220_000;
const MAX_TEXT = 4000;
const MAX_TITLE = 180;

const CONNECTORS = [
  { key: "JARVIS", label: "JARVIS", names: ["JARVIS"], hint: "Optional ambient JARVIS binding for agents. This persistent gadget records that it is connected but does not call JARVIS tools directly." },
  { key: "TEAM_PI", label: "Team PI", names: ["TEAM_PI"], hint: "Connect Team PI from Connections for documented read routes such as connection inventory, Gmail search, and Zendesk search." },
  { key: "GMAIL", label: "Gmail", names: ["GMAIL_INBOX", "GMAIL_SEARCH", "GMAIL_LABEL"], hint: "Connect Gmail inbox/search/label resources when incident evidence lives in mail. Manual records remain the fallback." },
  { key: "ZENDESK", label: "Zendesk", names: [], hint: "No native Zendesk package is assumed. Route Zendesk context through Team PI or a vetted MCP connector, then capture findings manually." },
  { key: "LINEAR", label: "Linear", names: ["LINEAR_WORKSPACE", "LINEAR_TEAM", "LINEAR_ISSUE"], hint: "Connect Linear workspace/team/issue resources for remediation tracking. Jira should be routed through Team PI or a vetted MCP connector." },
  { key: "GITHUB_REPO", label: "GitHub repository", names: ["GITHUB_REPO"], hint: "Connect a GitHub repository to read repository metadata, open pull requests, and open issues." },
  { key: "GITHUB_ISSUE", label: "GitHub issue", names: ["GITHUB_ISSUE"], hint: "Connect a single GitHub issue for evidence. It will show as connected, but repository-wide lists require GITHUB_REPO." },
  { key: "GITHUB_PULL_REQUEST", label: "GitHub pull request", names: ["GITHUB_PULL_REQUEST"], hint: "Connect a single GitHub pull request for evidence. It will show as connected, but repository-wide lists require GITHUB_REPO." },
];

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function asString(value, fallback = "", limit = MAX_TEXT) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, limit);
}

function cleanList(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean).slice(0, 12) : [];
}

function statusForBinding(binding, skipped) {
  if (skipped) return "Skipped";
  if (!binding) return "Missing";
  return "Connected";
}

async function takeCursor(cursorPromise, limit) {
  const cursor = await cursorPromise;
  const out = [];
  try {
    while (out.length < limit) {
      const batch = await cursor.next();
      if (!batch) break;
      out.push(...batch.slice(0, limit - out.length));
    }
    return out;
  } finally {
    cursor[Symbol.dispose]();
  }
}

export class Gadget extends DurableObject {
  async getState() {
    return this.#normalize(await this.ctx.storage.get(STATE_KEY));
  }

  async saveState(patch) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const next = {
      ...state,
      title: asString(patch?.title, state.title, MAX_TITLE),
      commander: asString(patch?.commander, state.commander, 120),
      severity: asString(patch?.severity, state.severity, 80),
      status: asString(patch?.status, state.status, 80),
      summary: asString(patch?.summary, state.summary),
      updatedAt: nowIso(),
    };
    await this.#put(next);
    return next;
  }

  async listConnectors() {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    return CONNECTORS.map(connector => {
      const bindingName = connector.names.find(name => this.env && this.env[name]);
      return {
        ...connector,
        bindingName: bindingName ?? null,
        status: statusForBinding(bindingName ? this.env[bindingName] : null, state.skippedConnectors.includes(connector.key)),
      };
    });
  }

  async setConnectorSkipped(key, skipped) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const set = new Set(state.skippedConnectors);
    if (skipped) set.add(key); else set.delete(key);
    state.skippedConnectors = [...set];
    state.updatedAt = nowIso();
    await this.#put(state);
    return this.listConnectors();
  }

  async sourceSnapshot() {
    const connectors = await this.listConnectors();
    const enabled = key => connectors.find(connector => connector.key === key)?.status !== "Skipped";
    const live = { repository: null, githubPullRequests: [], githubIssues: [], teamPiConnections: [], notes: [] };
    if (enabled("GITHUB_REPO") && this.env.GITHUB_REPO) {
      try {
        live.repository = await this.env.GITHUB_REPO.getMetadata();
        live.githubPullRequests = await takeCursor(this.env.GITHUB_REPO.listPullRequests({ state: "open" }), 10);
        live.githubIssues = await takeCursor(this.env.GITHUB_REPO.listIssues({ state: "open" }), 10);
      } catch (error) {
        live.notes.push(`GITHUB_REPO is connected, but repository reads were unavailable: ${error?.message ?? String(error)}`);
      }
    }
    if (enabled("GITHUB_ISSUE") && this.env.GITHUB_ISSUE) live.notes.push("GITHUB_ISSUE is connected. Add findings manually or ask an agent to read documented issue details; repository lists require GITHUB_REPO.");
    if (enabled("GITHUB_PULL_REQUEST") && this.env.GITHUB_PULL_REQUEST) live.notes.push("GITHUB_PULL_REQUEST is connected. Add findings manually or ask an agent to read documented PR details; repository lists require GITHUB_REPO.");
    if (enabled("JARVIS") && this.env.JARVIS) live.notes.push("JARVIS is connected for agent-routed production context. This gadget does not invoke JARVIS tools directly from persistent code.");
    if (enabled("TEAM_PI") && this.env.TEAM_PI) {
      try {
        const page = await this.env.TEAM_PI.listConnections({ limit: 8 });
        live.teamPiConnections = Array.isArray(page.items) ? page.items.slice(0, 8) : [];
      } catch (error) {
        live.notes.push(`TEAM_PI is connected, but connection inventory was unavailable: ${error?.message ?? String(error)}`);
      }
    }
    return { connectors, live, generatedAt: nowIso() };
  }

  async addRecord(type, input) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const record = this.#record(type, input);
    state.records.unshift(record);
    state.records = state.records.slice(0, MAX_RECORDS);
    state.updatedAt = nowIso();
    await this.#put(state);
    return record;
  }

  async updateRecord(id, input) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const index = state.records.findIndex(record => record.id === id);
    if (index === -1) throw new Error("No such record.");
    state.records[index] = { ...state.records[index], ...this.#recordPatch(input), id, updatedAt: nowIso() };
    state.updatedAt = nowIso();
    await this.#put(state);
    return state.records[index];
  }

  async deleteRecord(id) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    state.records = state.records.filter(record => record.id !== id);
    state.updatedAt = nowIso();
    await this.#put(state);
    return state;
  }

  async importRecords(records) {
    if (!Array.isArray(records)) throw new TypeError("Expected an array of records.");
    if (JSON.stringify(records).length > MAX_IMPORT_BYTES) throw new Error("Import is too large. Please import fewer or shorter records.");
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const imported = records.slice(0, MAX_IMPORT_RECORDS).map(item => this.#record(asString(item?.type, "evidence", 40), item));
    state.records = [...imported, ...state.records].slice(0, MAX_RECORDS);
    state.updatedAt = nowIso();
    await this.#put(state);
    return { imported: imported.length, state };
  }

  async resetDemo() {
    const state = this.#demoState();
    await this.#put(state);
    return state;
  }

  #record(type, input) {
    return { id: makeId(type || "rec"), type: asString(type, "evidence", 40), createdAt: nowIso(), updatedAt: nowIso(), ...this.#recordPatch(input) };
  }

  #recordPatch(input) {
    return {
      title: asString(input?.title, "Untitled record", MAX_TITLE),
      body: asString(input?.body, ""),
      source: asString(input?.source, "Manual", 120),
      owner: asString(input?.owner, "Unassigned", 120),
      status: asString(input?.status, "Open", 80),
      severity: asString(input?.severity, "Medium", 80),
      tags: cleanList(input?.tags),
      occurredAt: asString(input?.occurredAt, nowIso(), 80),
      link: asString(input?.link, "", 500),
    };
  }

  #normalize(raw) {
    if (raw && typeof raw === "object" && Array.isArray(raw.records)) return raw;
    return this.#demoState();
  }

  #demoState() {
    const base = "2026-08-11T15:00:00.000Z";
    return {
      title: "Checkout elevated 5xx investigation",
      commander: "Maya Chen",
      severity: "SEV-2",
      status: "Investigating",
      summary: "A realistic offline scenario showing timeline reconstruction, evidence intake, and follow-up ownership. Live connector data is only shown after users explicitly add Connections.",
      skippedConnectors: [],
      updatedAt: nowIso(),
      records: [
        { id: "demo_t1", type: "timeline", title: "Alert fired", body: "Synthetic payments-canary alert crossed 5% error rate for two regions.", source: "Demo monitor", owner: "SRE", status: "Confirmed", severity: "High", tags: ["checkout", "5xx"], occurredAt: base, link: "", createdAt: base, updatedAt: base },
        { id: "demo_e1", type: "evidence", title: "Recent deploy narrowed", body: "Manual evidence indicates the only deployment inside the window changed retry behavior around the payment gateway.", source: "Manual import", owner: "Incident commander", status: "Needs validation", severity: "High", tags: ["deploy", "payments"], occurredAt: "2026-08-11T15:07:00.000Z", link: "", createdAt: base, updatedAt: base },
        { id: "demo_d1", type: "decision", title: "Rollback first, then preserve traces", body: "Prefer customer impact reduction before deep forensic collection. Capture dashboard screenshots and owner notes before rollback completes.", source: "War room", owner: "Maya Chen", status: "Accepted", severity: "Medium", tags: ["rollback"], occurredAt: "2026-08-11T15:12:00.000Z", link: "", createdAt: base, updatedAt: base },
        { id: "demo_a1", type: "action", title: "Open remediation ticket", body: "Track idempotency retry fix and customer notification readiness. Link Linear directly when available; route Jira through Team PI or a vetted MCP connector.", source: "Demo follow-up", owner: "Platform", status: "Open", severity: "Medium", tags: ["follow-up"], occurredAt: "2026-08-11T15:25:00.000Z", link: "", createdAt: base, updatedAt: base }
      ],
    };
  }

  async #put(state) {
    await this.ctx.storage.put(STATE_KEY, state);
  }
}
