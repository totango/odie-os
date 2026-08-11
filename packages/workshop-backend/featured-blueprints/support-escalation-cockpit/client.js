const STATUSES = ["new", "investigating", "war-room", "waiting-customer", "at-risk", "resolved"];
const SEVERITIES = ["sev1", "sev2", "sev3", "sev4"];

let state = null;
let selectedId = null;
let filters = { query: "", severity: "all", status: "all" };

const root = document.createElement("main");
root.className = "app-shell";
root.innerHTML = `
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f7fb; color: #142033; }
    button, input, select, textarea { font: inherit; }
    button { border: 0; cursor: pointer; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 2px; }
    .app-shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    .hero { background: radial-gradient(circle at top left, #dbeafe 0, transparent 34rem), linear-gradient(135deg, #082f49, #0f172a 62%, #312e81); color: white; padding: 28px clamp(18px, 4vw, 44px); }
    .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
    .eyebrow { letter-spacing: .16em; text-transform: uppercase; color: #bae6fd; font-size: 12px; font-weight: 800; }
    h1 { margin: 8px 0 8px; font-size: clamp(30px, 5vw, 56px); line-height: .95; }
    .hero p { max-width: 820px; color: #dbeafe; margin: 0; line-height: 1.6; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn { border-radius: 999px; padding: 10px 15px; font-weight: 800; background: #e0f2fe; color: #082f49; box-shadow: 0 10px 30px #0002; }
    .btn.secondary { background: #ffffff1f; color: white; border: 1px solid #ffffff36; }
    .btn.danger { background: #fee2e2; color: #991b1b; }
    .metrics { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 12px; margin-top: 24px; }
    .metric { background: #ffffff14; border: 1px solid #ffffff26; border-radius: 20px; padding: 16px; backdrop-filter: blur(12px); }
    .metric b { display: block; font-size: 30px; }
    .metric span { color: #bfdbfe; font-size: 13px; }
    .workspace { display: grid; grid-template-columns: 300px minmax(0, 1fr) 360px; gap: 18px; padding: 18px; }
    .panel { background: #fff; border: 1px solid #dbe3ef; border-radius: 24px; box-shadow: 0 18px 50px #0f172a0d; overflow: clip; }
    .panel h2 { margin: 0; font-size: 16px; }
    .panel-head { padding: 18px; border-bottom: 1px solid #e5edf7; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .onboarding { padding: 14px; display: grid; gap: 10px; }
    .connector { border: 1px solid #e2e8f0; border-radius: 16px; padding: 12px; display: grid; gap: 8px; }
    .connector-top { display:flex; align-items:center; justify-content:space-between; gap: 8px; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 8px; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
    .connected { background: #dcfce7; color: #166534; } .missing { background: #fef3c7; color: #92400e; } .skipped { background: #e0e7ff; color: #3730a3; } .unavailable { background: #fee2e2; color: #991b1b; }
    .connector p { margin: 0; color: #64748b; font-size: 13px; line-height: 1.4; }
    .skip { background: transparent; color: #2563eb; min-height: 32px; padding: 6px 8px; font-weight: 700; justify-self: start; }
    .command { display: grid; grid-template-columns: 1fr 140px 140px; gap: 10px; padding: 16px; border-bottom: 1px solid #e5edf7; }
    .command input, .command select, .form-grid input, .form-grid select, .importer select, textarea { width: 100%; border: 1px solid #cbd5e1; border-radius: 12px; padding: 10px 12px; background: white; color: #0f172a; }
    .board { display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 12px; padding: 16px; align-items:start; }
    .lane { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 20px; min-height: 260px; }
    .lane h3 { margin: 0; padding: 14px 14px 8px; font-size: 13px; color: #475569; text-transform: uppercase; letter-spacing: .08em; }
    .cards { display: grid; gap: 10px; padding: 0 10px 10px; }
    .ticket { text-align: left; width: 100%; background: white; border: 1px solid #dbe3ef; border-left: 5px solid #38bdf8; border-radius: 16px; padding: 12px; box-shadow: 0 10px 24px #0f172a0a; }
    .ticket[aria-current="true"] { border-color: #2563eb; box-shadow: 0 0 0 3px #bfdbfe, 0 10px 24px #0f172a0a; }
    .ticket.sev1 { border-left-color: #dc2626; } .ticket.sev2 { border-left-color: #f97316; } .ticket.sev3 { border-left-color: #eab308; } .ticket.sev4 { border-left-color: #22c55e; }
    .ticket strong { display:block; margin: 8px 0; color:#0f172a; }
    .meta { display:flex; flex-wrap:wrap; gap:6px; color:#64748b; font-size:12px; }
    .detail { padding: 18px; display:grid; gap: 16px; }
    .empty { padding: 30px; color: #64748b; text-align:center; }
    .form-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .wide { grid-column: 1 / -1; }
    label { display:grid; gap: 6px; font-size: 13px; font-weight: 800; color:#334155; }
    textarea { min-height: 90px; resize: vertical; }
    .detail-card { border:1px solid #e2e8f0; border-radius:18px; padding:14px; background:#f8fafc; }
    .detail-card h3 { margin:0 0 8px; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; }
    .tag { background:#e0f2fe; color:#075985; border-radius:999px; padding:4px 8px; font-size:12px; font-weight:700; }
    .importer { padding: 14px; border-top: 1px solid #e5edf7; display:grid; gap:10px; }
    .importer textarea { min-height: 130px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .toast { position: fixed; right: 18px; bottom: 18px; background:#0f172a; color:white; border-radius:14px; padding:12px 14px; box-shadow:0 16px 40px #0004; max-width: min(420px, calc(100vw - 36px)); z-index: 5; }
    @media (max-width: 1180px) { .workspace { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 760px) { .command, .board, .form-grid { grid-template-columns: 1fr; } .hero-top { display:grid; } .workspace > section { order:-2; } .workspace > aside:last-child { order:-1; } }
    @media print { .actions, .onboarding, .importer, .command, form button { display:none !important; } .workspace { display:block; } .panel { box-shadow:none; margin-bottom:16px; break-inside: avoid; } }
  </style>
  <section class="hero" aria-labelledby="title">
    <div class="hero-top">
      <div><div class="eyebrow">Source-backed starter · support command center</div><h1 id="title">Escalation Cockpit</h1><p>Run a support war-room from manually entered, imported, demo, or explicitly connected source records. Optional connectors never grant themselves authority; wire them in Connections when ready.</p></div>
      <div class="actions" aria-label="Primary actions">
        <button class="btn" id="new-record">New escalation</button>
        <button class="btn secondary" id="sync">Sync sources</button>
        <button class="btn secondary" id="load-demo">Load / refresh demo</button>
        <button class="btn danger" id="reset-demo">Destructive demo reset</button>
      </div>
    </div>
    <div class="metrics" id="metrics" aria-label="Escalation metrics"></div>
  </section>
  <section class="workspace">
    <aside class="panel" aria-labelledby="onboarding-title"><div class="panel-head"><h2 id="onboarding-title">Connection checklist</h2></div><div class="onboarding" id="connectors"></div><div class="importer"><h2>Manual import</h2><label>Import format<select id="import-format"><option value="json">JSON</option><option value="csv">CSV</option></select></label><label>Import text<textarea id="import-text" placeholder='[{"title":"Customer escalation","customer":"Example Co"}]'></textarea></label><button class="btn" id="import-button">Import records</button></div></aside>
    <section class="panel" aria-labelledby="board-title"><div class="panel-head"><h2 id="board-title">Triage board</h2></div><div class="command"><input id="search" aria-label="Search escalations" placeholder="Search customers, owners, tags…"><select id="severity-filter" aria-label="Filter severity"><option value="all">All severities</option></select><select id="status-filter" aria-label="Filter status"><option value="all">All statuses</option></select></div><div class="board" id="board"></div></section>
    <aside class="panel" aria-labelledby="detail-title"><div class="panel-head"><h2 id="detail-title">Record detail</h2></div><div id="detail" class="detail"></div></aside>
  </section>`;
document.body.appendChild(root);

for (let severity of SEVERITIES) document.querySelector("#severity-filter").append(new Option(severity.toUpperCase(), severity));
for (let status of STATUSES) document.querySelector("#status-filter").append(new Option(status.replaceAll("-", " "), status));

function toast(message) {
  let el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4200);
}

function visibleRecords() {
  let q = filters.query.toLowerCase();
  return (state?.records || []).filter((record) => {
    if (filters.severity !== "all" && record.severity !== filters.severity) return false;
    if (filters.status !== "all" && record.status !== filters.status) return false;
    return !q || [record.title, record.customer, record.owner, record.summary, ...(record.tags || [])].join(" ").toLowerCase().includes(q);
  });
}

function render() {
  renderMetrics();
  renderConnectors();
  renderBoard();
  renderDetail();
}

function renderMetrics() {
  let m = state?.metrics || { total: 0, open: 0, sev1: 0, overdue: 0, avgImpact: 0 };
  document.querySelector("#metrics").innerHTML = [
    [m.total, "Total records"], [m.open, "Open escalations"], [m.sev1, "SEV1 now"], [m.overdue, "Past target"], [m.avgImpact, "Avg impact score"],
  ].map(([value, label]) => `<div class="metric"><b>${value}</b><span>${label}</span></div>`).join("");
}

function renderConnectors() {
  let wrap = document.querySelector("#connectors");
  wrap.innerHTML = "";
  for (let connector of state?.connectors || []) {
    let item = document.createElement("article");
    item.className = "connector";
    let connectorStatus = ["connected", "missing", "skipped", "unavailable"].includes(connector.status) ? connector.status : "missing";
    item.innerHTML = `<div class="connector-top"><strong>${escapeHtml(connector.label)}</strong><span class="badge ${connectorStatus}">${escapeHtml(connector.status)}</span></div><p>${escapeHtml(connector.purpose)}</p>${connector.boundName ? `<p><strong>Bound as:</strong> ${escapeHtml(connector.boundName)}</p>` : ""}<p>${escapeHtml(connector.instruction)}</p>`;
    let skip = document.createElement("button");
    skip.className = "skip";
    skip.textContent = connector.status === "skipped" ? "Mark needed" : "Skip for now";
    skip.addEventListener("click", async () => {
      state = await gadget.setConnectorSkipped(connector.key, connector.status !== "skipped");
      render();
    });
    item.append(skip);
    wrap.append(item);
  }
}

function laneFor(record) {
  if (["war-room", "at-risk"].includes(record.status) || record.severity === "sev1") return "Command";
  if (["resolved", "waiting-customer"].includes(record.status)) return "Waiting / resolved";
  return "Intake and investigation";
}

function renderBoard() {
  let board = document.querySelector("#board");
  let lanes = ["Command", "Intake and investigation", "Waiting / resolved"];
  let records = visibleRecords();
  board.innerHTML = "";
  for (let lane of lanes) {
    let section = document.createElement("section");
    section.className = "lane";
    section.innerHTML = `<h3>${lane}</h3><div class="cards"></div>`;
    let cards = section.querySelector(".cards");
    for (let record of records.filter((r) => laneFor(r) === lane)) cards.append(ticket(record));
    if (!cards.children.length) cards.innerHTML = `<div class="empty">No matching escalations.</div>`;
    board.append(section);
  }
}

function ticket(record) {
  let button = document.createElement("button");
  button.className = `ticket ${record.severity}`;
  button.setAttribute("aria-current", String(record.id === selectedId));
  button.innerHTML = `<div class="meta"><span class="badge ${record.severity === "sev1" ? "unavailable" : "missing"}">${escapeHtml(record.severity)}</span><span>${escapeHtml(String(record.status).replaceAll("-", " "))}</span></div><strong>${escapeHtml(record.title)}</strong><div class="meta"><span>${escapeHtml(record.customer)}</span><span>Owner: ${escapeHtml(record.owner)}</span><span>Impact ${escapeHtml(record.impact)}</span></div>`;
  button.addEventListener("click", () => { selectedId = record.id; render(); });
  return button;
}

function selectedRecord() {
  if (selectedId === null) return null;
  return state?.records?.find((record) => record.id === selectedId) || state?.records?.[0] || null;
}

function renderDetail(editing = false) {
  let detail = document.querySelector("#detail");
  let record = selectedRecord();
  if (!record || editing) {
    detail.innerHTML = formHtml(record || {});
    detail.querySelector("form").addEventListener("submit", saveFromForm);
    detail.querySelector("#cancel-edit")?.addEventListener("click", () => renderDetail(false));
    return;
  }
  selectedId = record.id;
  detail.innerHTML = `<div class="detail-card"><h3>${escapeHtml(record.title)}</h3><p>${escapeHtml(record.summary || "No summary yet.")}</p><div class="tags">${(record.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div></div><div class="detail-card"><h3>Next best action</h3><p>${escapeHtml(record.nextStep || "Add a next step so the owner knows what to do next.")}</p></div><dl class="detail-card"><dt>Customer</dt><dd>${escapeHtml(record.customer)}</dd><dt>Owner</dt><dd>${escapeHtml(record.owner)}</dd><dt>Deadline</dt><dd>${escapeHtml(record.deadline || "Not set")}</dd><dt>Source</dt><dd>${escapeHtml(record.source)}</dd><dt>Links</dt><dd>${(record.links || []).map(escapeHtml).join(", ") || "None"}</dd></dl><div class="actions"><button class="btn" id="edit-record">Edit</button><button class="btn danger" id="delete-record">Delete</button></div>`;
  detail.querySelector("#edit-record").addEventListener("click", () => renderDetail(true));
  detail.querySelector("#delete-record").addEventListener("click", async () => {
    state = await gadget.deleteRecord(record.id);
    selectedId = null;
    render();
    toast("Escalation deleted.");
  });
}

function formHtml(record) {
  return `<form class="form-grid"><input type="hidden" name="id" value="${escapeAttr(record.id || "")}"><label class="wide">Title<input name="title" required value="${escapeAttr(record.title || "")}"></label><label>Customer<input name="customer" required value="${escapeAttr(record.customer || "")}"></label><label>Owner<input name="owner" value="${escapeAttr(record.owner || "")}"></label><label>Severity<select name="severity">${SEVERITIES.map((s) => `<option value="${s}" ${record.severity === s ? "selected" : ""}>${s.toUpperCase()}</option>`).join("")}</select></label><label>Status<select name="status">${STATUSES.map((s) => `<option value="${s}" ${record.status === s ? "selected" : ""}>${s.replaceAll("-", " ")}</option>`).join("")}</select></label><label>Deadline<input name="deadline" type="date" value="${escapeAttr(record.deadline || "")}"></label><label>Impact<input name="impact" type="number" min="0" max="100" value="${escapeAttr(record.impact ?? 50)}"></label><label class="wide">Summary<textarea name="summary">${escapeHtml(record.summary || "")}</textarea></label><label class="wide">Next step<textarea name="nextStep">${escapeHtml(record.nextStep || "")}</textarea></label><label class="wide">Tags (comma separated)<input name="tags" value="${escapeAttr((record.tags || []).join(", "))}"></label><label class="wide">Links (comma separated)<input name="links" value="${escapeAttr((record.links || []).join(", "))}"></label><div class="actions wide"><button class="btn" type="submit">Save escalation</button><button class="btn secondary" id="cancel-edit" type="button">Cancel</button></div></form>`;
}

async function saveFromForm(event) {
  event.preventDefault();
  let data = Object.fromEntries(new FormData(event.currentTarget));
  data.impact = Number(data.impact);
  state = await gadget.saveRecord(data);
  selectedId = data.id || state.records[0]?.id;
  render();
  toast("Escalation saved.");
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, "&#39;"); }

document.querySelector("#new-record").addEventListener("click", () => { selectedId = null; renderDetail(true); });
document.querySelector("#load-demo").addEventListener("click", async () => { state = await gadget.loadDemo(); selectedId = state.records[0]?.id; render(); toast("Demo records refreshed; manual/imported/live records were preserved."); });
document.querySelector("#reset-demo").addEventListener("click", async () => { state = await gadget.resetDemo(); selectedId = state.records[0]?.id; render(); toast("Destructive demo reset complete; prior records were replaced."); });
document.querySelector("#sync").addEventListener("click", async () => { let result = await gadget.syncSources(); state = result.state; render(); toast(result.results.map((r) => `${r.key}: ${r.message}`).join(" ")); });
document.querySelector("#import-button").addEventListener("click", async () => {
  let text = document.querySelector("#import-text").value.trim();
  if (!text) return toast("Paste JSON or CSV records first.");
  try {
    let result = await gadget.importText(text, document.querySelector("#import-format").value);
    state = result.state;
    selectedId = state.records[0]?.id;
    render();
    toast(`Imported ${result.imported} record(s).${result.truncated ? " Extra rows were ignored at the safety limit." : ""}`);
  } catch (error) { toast(error?.message || "Import failed."); }
});
document.querySelector("#search").addEventListener("input", (event) => { filters.query = event.target.value; renderBoard(); });
document.querySelector("#severity-filter").addEventListener("change", (event) => { filters.severity = event.target.value; renderBoard(); });
document.querySelector("#status-filter").addEventListener("change", (event) => { filters.status = event.target.value; renderBoard(); });

state = await gadget.getState();
selectedId = state.records[0]?.id || null;
render();
