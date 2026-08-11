import { DurableObject } from "cloudflare:workers";

const STATE_KEY = "delivery-kit:v1";
const MAX_ITEMS = 400;
const MAX_IMPORT_ITEMS = 120;
const MAX_IMPORT_BYTES = 260_000;
const MAX_TEXT = 4000;
const MAX_TITLE = 180;

const CONNECTORS = [
  { key: "GITHUB_REPO", label: "GitHub repository", names: ["GITHUB_REPO"], primary: true, hint: "Connect the native GitHub repository binding for metadata, PR queue, and issue queue reads." },
  { key: "GITHUB_ISSUE", label: "GitHub issue", names: ["GITHUB_ISSUE"], hint: "Optional single-issue binding. It shows as connected; repository-wide queues require GITHUB_REPO." },
  { key: "GITHUB_PULL_REQUEST", label: "GitHub pull request", names: ["GITHUB_PULL_REQUEST"], hint: "Optional single-PR binding. It shows as connected; repository-wide queues require GITHUB_REPO." },
  { key: "LINEAR", label: "Linear", names: ["LINEAR_WORKSPACE", "LINEAR_TEAM", "LINEAR_ISSUE"], hint: "Optional Linear workspace/team/issue binding for delivery risks. Jira should be routed through Team PI or a vetted MCP connector." },
  { key: "GMAIL", label: "Gmail", names: ["GMAIL_INBOX", "GMAIL_SEARCH", "GMAIL_LABEL"], hint: "Optional Gmail inbox/search/label binding for release approvals and customer escalations." },
  { key: "TEAM_PI", label: "Team PI", names: ["TEAM_PI"], hint: "Optional Team PI binding for documented read routes, especially connection inventory and agent-routed delivery context." },
  { key: "JARVIS", label: "JARVIS", names: ["JARVIS"], hint: "Optional ambient JARVIS binding for agents. This persistent gadget records availability but does not call JARVIS tools directly." },
];

function nowIso() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
function text(value, fallback = "", limit = MAX_TEXT) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : fallback;
}
function list(value) { return Array.isArray(value) ? value.map(v => String(v).trim()).filter(Boolean).slice(0, 16) : []; }
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

  async saveOverview(patch) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    Object.assign(state, {
      repo: text(patch?.repo, state.repo, 180),
      release: text(patch?.release, state.release, 180),
      owner: text(patch?.owner, state.owner, 120),
      objective: text(patch?.objective, state.objective),
      readiness: text(patch?.readiness, state.readiness, 80),
      updatedAt: nowIso(),
    });
    await this.#put(state);
    return state;
  }

  async listConnectors() {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    return CONNECTORS.map(connector => {
      const bindingName = connector.names.find(name => this.env && this.env[name]);
      return {
        ...connector,
        bindingName: bindingName ?? null,
        status: state.skippedConnectors.includes(connector.key) ? "Skipped" : bindingName ? "Connected" : "Missing",
      };
    });
  }

  async setConnectorSkipped(key, skipped) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const skippedSet = new Set(state.skippedConnectors);
    if (skipped) skippedSet.add(key); else skippedSet.delete(key);
    state.skippedConnectors = [...skippedSet];
    state.updatedAt = nowIso();
    await this.#put(state);
    return this.listConnectors();
  }

  async sourceSnapshot() {
    const connectors = await this.listConnectors();
    const enabled = key => connectors.find(connector => connector.key === key)?.status !== "Skipped";
    const live = { repository: null, pullRequests: [], issues: [], teamPiConnections: [], notes: [] };
    if (enabled("GITHUB_REPO") && this.env.GITHUB_REPO) {
      try {
        live.repository = await this.env.GITHUB_REPO.getMetadata();
        live.pullRequests = await takeCursor(this.env.GITHUB_REPO.listPullRequests({ state: "open" }), 15);
        live.issues = await takeCursor(this.env.GITHUB_REPO.listIssues({ state: "open" }), 15);
      } catch (error) {
        live.notes.push(`GITHUB_REPO is connected, but repository reads were unavailable: ${error?.message ?? String(error)}`);
      }
    }
    if (enabled("GITHUB_ISSUE") && this.env.GITHUB_ISSUE) live.notes.push("GITHUB_ISSUE is connected. Repository-wide issue queues require GITHUB_REPO; keep single-issue findings as manual records or ask an agent to read details.");
    if (enabled("GITHUB_PULL_REQUEST") && this.env.GITHUB_PULL_REQUEST) live.notes.push("GITHUB_PULL_REQUEST is connected. Repository-wide PR queues require GITHUB_REPO; keep single-PR findings as manual records or ask an agent to read details.");
    if (enabled("JARVIS") && this.env.JARVIS) live.notes.push("JARVIS is connected for agent-routed operational context. This persistent gadget does not invoke JARVIS tools directly.");
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

  async addItem(type, input) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const item = this.#item(type, input);
    state.items.unshift(item);
    state.items = state.items.slice(0, MAX_ITEMS);
    state.updatedAt = nowIso();
    await this.#put(state);
    return item;
  }

  async updateItem(itemId, input) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const index = state.items.findIndex(item => item.id === itemId);
    if (index === -1) throw new Error("No such delivery item.");
    state.items[index] = { ...state.items[index], ...this.#patch(input), id: itemId, updatedAt: nowIso() };
    state.updatedAt = nowIso();
    await this.#put(state);
    return state.items[index];
  }

  async deleteItem(itemId) {
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    state.items = state.items.filter(item => item.id !== itemId);
    state.updatedAt = nowIso();
    await this.#put(state);
    return state;
  }

  async importItems(items) {
    if (!Array.isArray(items)) throw new TypeError("Expected a JSON array.");
    if (JSON.stringify(items).length > MAX_IMPORT_BYTES) throw new Error("Import is too large. Please import fewer or shorter records.");
    const state = this.#normalize(await this.ctx.storage.get(STATE_KEY));
    const imported = items.slice(0, MAX_IMPORT_ITEMS).map(item => this.#item(text(item?.type, "risk", 40), item));
    state.items = [...imported, ...state.items].slice(0, MAX_ITEMS);
    state.updatedAt = nowIso();
    await this.#put(state);
    return { imported: imported.length, state };
  }

  async resetDemo() {
    const state = this.#demoState();
    await this.#put(state);
    return state;
  }

  #item(type, input) {
    return { id: id(type || "item"), type: text(type, "risk", 40), createdAt: nowIso(), updatedAt: nowIso(), ...this.#patch(input) };
  }

  #patch(input) {
    return {
      title: text(input?.title, "Untitled delivery item", MAX_TITLE),
      body: text(input?.body, ""),
      owner: text(input?.owner, "Unassigned", 120),
      status: text(input?.status, "Open", 80),
      impact: text(input?.impact, "Medium", 80),
      source: text(input?.source, "Manual", 120),
      link: text(input?.link, "", 500),
      due: text(input?.due, "", 80),
      labels: list(input?.labels),
    };
  }

  #normalize(raw) {
    if (raw && typeof raw === "object" && Array.isArray(raw.items)) return raw;
    return this.#demoState();
  }

  #demoState() {
    const createdAt = "2026-08-11T12:00:00.000Z";
    return {
      repo: "acme/payments-platform",
      release: "2026.08 checkout resilience train",
      owner: "Delivery captain: Nia Patel",
      readiness: "At risk",
      objective: "Offline demo workspace for consolidating pull requests, release gates, and cross-system delivery risks before shipping.",
      skippedConnectors: [],
      updatedAt: nowIso(),
      items: [
        { id: "demo_health", type: "repo-health", title: "Main branch confidence", body: "Demo signal: build is green, but flaky integration tests were observed twice this week. Replace with live GitHub checks after connecting a repo.", owner: "Platform", status: "Watch", impact: "Medium", source: "Demo", link: "", due: "", labels: ["ci", "quality"], createdAt, updatedAt: createdAt },
        { id: "demo_pr", type: "pr-review", title: "PR #482 retry budget refactor", body: "Needs security and SRE review before release cut. Use GitHub connection for real open PRs; this record is manual demo data.", owner: "Avery", status: "Needs review", impact: "High", source: "Demo GitHub", link: "", due: "2026-08-14", labels: ["payments", "review"], createdAt, updatedAt: createdAt },
        { id: "demo_gate", type: "release-gate", title: "Rollback plan approved", body: "Runbook owner confirmed the rollback button and data migration guardrail. Approval email can be linked manually or via Gmail connection.", owner: "Release captain", status: "Ready", impact: "High", source: "Manual", link: "", due: "2026-08-15", labels: ["rollback", "approval"], createdAt, updatedAt: createdAt },
        { id: "demo_risk", type: "delivery-risk", title: "Ticket scope drift", body: "Linked Linear work includes two ambiguous acceptance criteria. Route Jira context through Team PI or a vetted MCP connector, then capture the decision here.", owner: "PM", status: "Open", impact: "Medium", source: "Demo Linear", link: "", due: "2026-08-13", labels: ["scope", "tickets"], createdAt, updatedAt: createdAt }
      ],
    };
  }

  async #put(state) { await this.ctx.storage.put(STATE_KEY, state); }
}
