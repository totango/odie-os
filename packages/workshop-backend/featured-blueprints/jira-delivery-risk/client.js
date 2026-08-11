const STATUSES = ["new", "watch", "monitoring", "blocked", "critical", "mitigated"];
let state = null;
let selectedId = null;
let filters = { query: "", status: "all", minScore: 0 };

const root = document.createElement("main");
root.className = "risk-app";
root.innerHTML = `
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172033; background: #f8f5ef; }
    button, input, select, textarea { font: inherit; }
    button { border: 0; cursor: pointer; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #fb923c; outline-offset: 2px; }
    .risk-app { min-height: 100vh; display:grid; grid-template-rows:auto 1fr; }
    .masthead { padding: 28px clamp(18px, 4vw, 46px); background: linear-gradient(135deg, #431407, #7c2d12 48%, #111827); color:white; position:relative; overflow:hidden; }
    .masthead:after { content:""; position:absolute; inset:auto -10% -60px 40%; height:180px; background: radial-gradient(circle, #fed7aa55, transparent 70%); }
    .masthead-inner { position:relative; z-index:1; display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }
    .eyebrow { color:#fed7aa; text-transform:uppercase; letter-spacing:.17em; font-size:12px; font-weight:900; }
    h1 { margin:8px 0; font-size:clamp(32px, 5vw, 60px); line-height:.94; }
    .masthead p { margin:0; color:#ffedd5; max-width:820px; line-height:1.6; }
    .actions { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start; }
    .btn { border-radius:12px; background:#ffedd5; color:#7c2d12; padding:10px 14px; font-weight:900; box-shadow:0 14px 36px #0002; }
    .btn.secondary { background:#ffffff1a; color:white; border:1px solid #ffffff36; }
    .btn.danger { background:#fee2e2; color:#991b1b; }
    .scorebar { display:grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap:12px; margin-top:24px; position:relative; z-index:1; }
    .score { background:#ffffff14; border:1px solid #ffffff29; border-radius:18px; padding:14px; }
    .score b { display:block; font-size:29px; } .score span { color:#fed7aa; font-size:12px; text-transform:uppercase; letter-spacing:.06em; font-weight:800; }
    .workbench { display:grid; grid-template-columns:310px minmax(0, 1.2fr) minmax(340px, .8fr); gap:18px; padding:18px; }
    .panel { background:#fffdf9; border:1px solid #eadfd2; border-radius:26px; box-shadow:0 18px 50px #7c2d120d; overflow:clip; }
    .panel-head { padding:18px; border-bottom:1px solid #f1e6da; display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .panel h2 { margin:0; font-size:16px; }
    .connectors, .importer, .detail { padding:14px; display:grid; gap:10px; }
    .connector { border:1px solid #f0dfce; border-radius:16px; padding:12px; background:#fffaf4; display:grid; gap:8px; }
    .connector-top { display:flex; justify-content:space-between; gap:8px; align-items:center; }
    .badge { border-radius:999px; padding:4px 8px; text-transform:uppercase; letter-spacing:.04em; font-size:12px; font-weight:900; display:inline-flex; }
    .connected { background:#dcfce7; color:#166534; } .missing { background:#fef3c7; color:#92400e; } .skipped { background:#e0e7ff; color:#3730a3; } .unavailable { background:#fee2e2; color:#991b1b; }
    .connector p { margin:0; color:#6b7280; font-size:13px; line-height:1.4; }
    .skip { justify-self:start; min-height:32px; padding:6px 8px; background:transparent; color:#c2410c; font-weight:800; }
    .filters { padding:16px; border-bottom:1px solid #f1e6da; display:grid; grid-template-columns:1fr 150px 150px; gap:10px; }
    input, select, textarea { width:100%; border:1px solid #d6c7b7; background:white; color:#111827; border-radius:12px; padding:10px 12px; }
    .radar { padding:16px; display:grid; gap:12px; }
    .risk-row { width:100%; text-align:left; display:grid; grid-template-columns:76px 1fr auto; gap:12px; align-items:center; background:white; border:1px solid #eadfd2; border-radius:18px; padding:12px; box-shadow:0 10px 24px #7c2d1208; }
    .risk-row[aria-current="true"] { box-shadow:0 0 0 3px #fed7aa, 0 10px 24px #7c2d1208; border-color:#f97316; }
    .orb { width:62px; height:62px; border-radius:50%; display:grid; place-items:center; color:white; font-weight:1000; background: conic-gradient(from 210deg, #22c55e, #eab308, #ef4444); box-shadow: inset 0 0 0 8px #ffffff44; }
    .risk-row strong { display:block; color:#111827; margin-bottom:6px; }
    .meta { display:flex; flex-wrap:wrap; gap:7px; color:#6b7280; font-size:12px; }
    .empty { text-align:center; color:#6b7280; padding:32px; }
    .detail-card { background:#fff8f0; border:1px solid #f0dfce; border-radius:18px; padding:14px; }
    .detail-card h3 { margin:0 0 8px; }
    .matrix { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .meter { height:10px; background:#fed7aa; border-radius:999px; overflow:hidden; margin-top:6px; }
    .meter > span { display:block; height:100%; background:linear-gradient(90deg, #22c55e, #eab308, #dc2626); }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .wide { grid-column:1 / -1; }
    label { display:grid; gap:6px; color:#374151; font-weight:900; font-size:13px; }
    textarea { min-height:90px; resize:vertical; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; } .tag { background:#ffedd5; color:#9a3412; border-radius:999px; padding:4px 8px; font-size:12px; font-weight:800; }
    .importer { border-top:1px solid #f1e6da; } .importer textarea { min-height:128px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
    .toast { position:fixed; right:18px; bottom:18px; max-width:min(440px, calc(100vw - 36px)); background:#111827; color:white; padding:12px 14px; border-radius:14px; box-shadow:0 18px 48px #0004; z-index:5; }
    @media (max-width: 1220px) { .workbench { grid-template-columns:1fr; } .scorebar { grid-template-columns:repeat(2, 1fr); } }
    @media (max-width: 720px) { .filters, .risk-row, .form-grid, .matrix { grid-template-columns:1fr; } .workbench > section { order:-2; } .workbench > aside:last-child { order:-1; } }
    @media print { .actions, .connectors, .importer, .filters, form button { display:none !important; } .workbench { display:block; } .panel { box-shadow:none; margin-bottom:16px; break-inside:avoid; } }
  </style>
  <section class="masthead" aria-labelledby="title"><div class="masthead-inner"><div><div class="eyebrow">Source-backed starter · delivery intelligence</div><h1 id="title">Delivery Risk Radar</h1><p>Track release risks with probability × impact scoring, mitigation ownership, and optional source adapters. Missing connectors stay missing until a person wires them in Connections.</p></div><div class="actions"><button class="btn" id="new-record">New risk</button><button class="btn secondary" id="sync">Sync sources</button><button class="btn secondary" id="load-demo">Load / refresh demo</button><button class="btn danger" id="reset-demo">Destructive demo reset</button></div></div><div class="scorebar" id="metrics"></div></section>
  <section class="workbench"><aside class="panel"><div class="panel-head"><h2>Connection checklist</h2></div><div id="connectors" class="connectors"></div><div class="importer"><h2>Manual import</h2><label>Import format<select id="import-format"><option value="json">JSON</option><option value="csv">CSV</option></select></label><label>Import text<textarea id="import-text" placeholder='[{"title":"Release blocker","program":"Checkout"}]'></textarea></label><button class="btn" id="import-button">Import risks</button></div></aside><section class="panel"><div class="panel-head"><h2>Risk queue</h2></div><div class="filters"><input id="search" aria-label="Search risks" placeholder="Search programs, owners, tags…"><select id="status-filter" aria-label="Filter status"><option value="all">All statuses</option></select><select id="score-filter" aria-label="Filter minimum score"><option value="0">Any score</option><option value="50">Score 50+</option><option value="70">Score 70+</option><option value="85">Score 85+</option></select></div><div id="radar" class="radar"></div></section><aside class="panel"><div class="panel-head"><h2>Mitigation brief</h2></div><div id="detail" class="detail"></div></aside></section>`;
document.body.append(root);
for (let status of STATUSES) document.querySelector("#status-filter").append(new Option(status, status));

function toast(message) { let el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); el.textContent = message; document.body.append(el); setTimeout(() => el.remove(), 4200); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, "&#39;"); }
function statusClass(value) { return ["connected", "missing", "skipped", "unavailable"].includes(value) ? value : "missing"; }
function percent(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function records() {
  let q = filters.query.toLowerCase();
  return (state?.records || []).filter((record) => {
    if (filters.status !== "all" && record.status !== filters.status) return false;
    if (record.score < filters.minScore) return false;
    return !q || [record.title, record.program, record.release, record.owner, record.summary, ...(record.tags || [])].join(" ").toLowerCase().includes(q);
  }).toSorted((a, b) => b.score - a.score);
}
function render() { renderMetrics(); renderConnectors(); renderRadar(); renderDetail(); }
function renderMetrics() {
  let m = state?.metrics || { total:0, active:0, critical:0, blocked:0, avgScore:0, overdue:0 };
  document.querySelector("#metrics").innerHTML = [[m.total,"Total"],[m.active,"Active"],[m.critical,"Critical"],[m.blocked,"Blocked"],[m.avgScore,"Avg score"],[m.overdue,"Past due"]].map(([v,l]) => `<div class="score"><b>${v}</b><span>${l}</span></div>`).join("");
}
function renderConnectors() {
  let wrap = document.querySelector("#connectors"); wrap.innerHTML = "";
  for (let connector of state?.connectors || []) {
    let item = document.createElement("article"); item.className = "connector";
    item.innerHTML = `<div class="connector-top"><strong>${escapeHtml(connector.label)}</strong><span class="badge ${statusClass(connector.status)}">${escapeHtml(connector.status)}</span></div><p>${escapeHtml(connector.purpose)}</p>${connector.boundName ? `<p><strong>Bound as:</strong> ${escapeHtml(connector.boundName)}</p>` : ""}<p>${escapeHtml(connector.instruction)}</p>`;
    let skip = document.createElement("button"); skip.className = "skip"; skip.textContent = connector.status === "skipped" ? "Mark needed" : "Skip for now";
    skip.addEventListener("click", async () => { state = await gadget.setConnectorSkipped(connector.key, connector.status !== "skipped"); render(); });
    item.append(skip); wrap.append(item);
  }
}
function renderRadar() {
  let wrap = document.querySelector("#radar"); wrap.innerHTML = "";
  let list = records();
  if (!list.length) { wrap.innerHTML = `<div class="empty">No risks match this view.</div>`; return; }
  for (let record of list) {
    let button = document.createElement("button"); button.className = "risk-row"; button.setAttribute("aria-current", String(record.id === selectedId));
    button.innerHTML = `<div class="orb">${percent(record.score)}</div><div><strong>${escapeHtml(record.title)}</strong><div class="meta"><span>${escapeHtml(record.program)}</span><span>${escapeHtml(record.release)}</span><span>${escapeHtml(record.status)}</span><span>Owner: ${escapeHtml(record.owner)}</span></div></div><span class="badge ${record.score >= 75 ? "unavailable" : record.score >= 50 ? "missing" : "connected"}">${escapeHtml(record.source)}</span>`;
    button.addEventListener("click", () => { selectedId = record.id; render(); }); wrap.append(button);
  }
}
function selectedRecord() {
  if (selectedId === null) return null;
  return state?.records?.find((record) => record.id === selectedId) || state?.records?.[0] || null;
}
function renderDetail(editing = false) {
  let detail = document.querySelector("#detail"); let record = selectedRecord();
  if (!record || editing) { detail.innerHTML = formHtml(record || {}); detail.querySelector("form").addEventListener("submit", saveFromForm); detail.querySelector("#cancel-edit")?.addEventListener("click", () => renderDetail(false)); return; }
  selectedId = record.id;
  let probability = percent(record.probability); let impact = percent(record.impact);
  detail.innerHTML = `<div class="detail-card"><h3>${escapeHtml(record.title)}</h3><p>${escapeHtml(record.summary || "No summary yet.")}</p><div class="tags">${(record.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div></div><div class="matrix"><div class="detail-card"><strong>Probability ${probability}</strong><div class="meter"><span style="width:${probability}%"></span></div></div><div class="detail-card"><strong>Impact ${impact}</strong><div class="meter"><span style="width:${impact}%"></span></div></div></div><div class="detail-card"><h3>Mitigation</h3><p>${escapeHtml(record.mitigation || "Add a mitigation plan and explicit owner before the next review.")}</p></div><dl class="detail-card"><dt>Program</dt><dd>${escapeHtml(record.program)}</dd><dt>Release</dt><dd>${escapeHtml(record.release)}</dd><dt>Owner</dt><dd>${escapeHtml(record.owner)}</dd><dt>Due</dt><dd>${escapeHtml(record.dueDate || "Not set")}</dd><dt>Links</dt><dd>${(record.links || []).map(escapeHtml).join(", ") || "None"}</dd></dl><div class="actions"><button class="btn" id="edit-record">Edit</button><button class="btn danger" id="delete-record">Delete</button></div>`;
  detail.querySelector("#edit-record").addEventListener("click", () => renderDetail(true));
  detail.querySelector("#delete-record").addEventListener("click", async () => { state = await gadget.deleteRecord(record.id); selectedId = null; render(); toast("Risk deleted."); });
}
function formHtml(record) {
  return `<form class="form-grid"><input type="hidden" name="id" value="${escapeAttr(record.id || "")}"><label class="wide">Title<input required name="title" value="${escapeAttr(record.title || "")}"></label><label>Program<input required name="program" value="${escapeAttr(record.program || "")}"></label><label>Release<input name="release" value="${escapeAttr(record.release || "")}"></label><label>Status<select name="status">${STATUSES.map((s) => `<option value="${s}" ${record.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label><label>Owner<input name="owner" value="${escapeAttr(record.owner || "")}"></label><label>Due date<input name="dueDate" type="date" value="${escapeAttr(record.dueDate || "")}"></label><label>Probability<input name="probability" type="number" min="0" max="100" value="${escapeAttr(record.probability ?? 50)}"></label><label>Impact<input name="impact" type="number" min="0" max="100" value="${escapeAttr(record.impact ?? 50)}"></label><label class="wide">Summary<textarea name="summary">${escapeHtml(record.summary || "")}</textarea></label><label class="wide">Mitigation<textarea name="mitigation">${escapeHtml(record.mitigation || "")}</textarea></label><label class="wide">Tags (comma separated)<input name="tags" value="${escapeAttr((record.tags || []).join(", "))}"></label><label class="wide">Links (comma separated)<input name="links" value="${escapeAttr((record.links || []).join(", "))}"></label><div class="actions wide"><button class="btn" type="submit">Save risk</button><button class="btn secondary" type="button" id="cancel-edit">Cancel</button></div></form>`;
}
async function saveFromForm(event) {
  event.preventDefault(); let data = Object.fromEntries(new FormData(event.currentTarget)); data.probability = Number(data.probability); data.impact = Number(data.impact);
  state = await gadget.saveRecord(data); selectedId = data.id || state.records[0]?.id; render(); toast("Risk saved.");
}

document.querySelector("#new-record").addEventListener("click", () => { selectedId = null; renderDetail(true); });
document.querySelector("#load-demo").addEventListener("click", async () => { state = await gadget.loadDemo(); selectedId = state.records[0]?.id; render(); toast("Demo risks refreshed; manual/imported/live records were preserved."); });
document.querySelector("#reset-demo").addEventListener("click", async () => { state = await gadget.resetDemo(); selectedId = state.records[0]?.id; render(); toast("Destructive demo reset complete; prior records were replaced."); });
document.querySelector("#sync").addEventListener("click", async () => { let result = await gadget.syncSources(); state = result.state; render(); toast(result.results.map((r) => `${r.key}: ${r.message}`).join(" ")); });
document.querySelector("#import-button").addEventListener("click", async () => { let text = document.querySelector("#import-text").value.trim(); if (!text) return toast("Paste JSON or CSV risks first."); try { let result = await gadget.importText(text, document.querySelector("#import-format").value); state = result.state; selectedId = state.records[0]?.id; render(); toast(`Imported ${result.imported} risk(s).${result.truncated ? " Extra rows were ignored at the safety limit." : ""}`); } catch (error) { toast(error?.message || "Import failed."); } });
document.querySelector("#search").addEventListener("input", (event) => { filters.query = event.target.value; renderRadar(); });
document.querySelector("#status-filter").addEventListener("change", (event) => { filters.status = event.target.value; renderRadar(); });
document.querySelector("#score-filter").addEventListener("change", (event) => { filters.minScore = Number(event.target.value); renderRadar(); });

state = await gadget.getState();
selectedId = state.records[0]?.id || null;
render();
