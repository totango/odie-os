const TABS = [
  "overview",
  "setup",
  "variances",
  "contracts",
  "forecasts",
  "anomalies",
  "evidence",
  "imports",
  "briefing",
];
const SETUP_STATUSES = ["unanswered", "answered", "needs-artifact", "blocked"];
const REVIEW_STATUSES = ["draft", "in-review", "approved", "resolved"];
const DISPOSITIONS = ["open", "investigating", "explained", "accepted", "resolved"];

let state;
let activeTab = "overview";
let editing = null;
let resetArmed = false;
let deleteArmed = null;
let sheetPreview = null;

const app = document.createElement("main");
app.innerHTML = `
  <style>
    :root { color-scheme: light; font-family: "IBM Plex Sans", "Avenir Next", ui-sans-serif, system-ui, sans-serif; --ink:#18201b; --muted:#68736b; --paper:#f5f1e7; --sheet:#fffdf7; --rule:#d8d1c2; --green:#174f3a; --red:#a33a2b; --amber:#9a651c; --blue:#305d78; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); }
    button,input,select,textarea { font:inherit; }
    button { cursor:pointer; }
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:3px solid #e0a92e; outline-offset:2px; }
    .masthead { padding:30px clamp(18px,5vw,72px) 22px; background:#153c2f; color:#fffdf7; border-bottom:7px solid #c89531; }
    .mast-grid { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:30px; align-items:end; }
    .kicker { font:700 11px/1.2 ui-monospace,SFMono-Regular,monospace; letter-spacing:.18em; text-transform:uppercase; color:#e8cf92; }
    h1 { margin:8px 0 7px; font-family:Georgia,"Times New Roman",serif; font-size:clamp(34px,5vw,64px); font-weight:500; letter-spacing:-.035em; line-height:.95; }
    .masthead p { margin:0; max-width:850px; color:#dce7df; line-height:1.55; }
    .cert { border:1px solid #ffffff45; padding:12px 15px; max-width:260px; background:#ffffff0b; }
    .cert strong { display:block; font-family:Georgia,serif; font-size:18px; margin-bottom:3px; }
    .top-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:20px; }
    .btn { border:1px solid #224436; background:var(--green); color:white; padding:9px 13px; font-weight:750; min-height:40px; }
    .btn.light { background:#fffdf7; color:#174f3a; border-color:#c8c1b3; }
    .btn.ghost { background:transparent; color:inherit; border-color:currentColor; }
    .btn.danger { background:#8d3025; border-color:#8d3025; }
    .btn.small { min-height:32px; padding:5px 9px; font-size:12px; }
    nav { display:flex; overflow-x:auto; padding:0 clamp(10px,4vw,60px); background:#ece6d9; border-bottom:1px solid #c9c1b1; scrollbar-width:thin; }
    nav button { flex:0 0 auto; border:0; border-right:1px solid #d5cebf; background:transparent; color:#3e4841; padding:14px 17px; font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:.055em; }
    nav button[aria-selected="true"] { background:var(--sheet); color:var(--green); box-shadow:inset 0 -4px #b88320; }
    .page { padding:24px clamp(12px,4vw,60px) 54px; max-width:1600px; margin:auto; }
    .page-head { display:flex; justify-content:space-between; align-items:end; gap:18px; margin-bottom:18px; border-bottom:2px solid var(--ink); padding-bottom:10px; }
    .page-head h2 { font:500 clamp(25px,3vw,38px)/1 Georgia,serif; margin:0; }
    .page-head p { margin:4px 0 0; color:var(--muted); max-width:760px; }
    .metrics { display:grid; grid-template-columns:repeat(6,minmax(130px,1fr)); border:1px solid var(--rule); background:var(--sheet); }
    .metric { padding:17px; border-right:1px solid var(--rule); }
    .metric:last-child { border:0; }
    .metric b { display:block; font:500 30px/1 Georgia,serif; }
    .metric span { display:block; margin-top:6px; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    .grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:16px; margin-top:18px; }
    .card { grid-column:span 6; background:var(--sheet); border:1px solid var(--rule); padding:18px; box-shadow:3px 3px 0 #ded7c9; }
    .card.wide { grid-column:1/-1; }
    .card.third { grid-column:span 4; }
    .card h3 { margin:0 0 10px; font:600 20px/1.2 Georgia,serif; }
    .card p { color:#4e5b52; line-height:1.55; }
    .status { display:inline-flex; padding:4px 7px; border:1px solid currentColor; font:700 10px/1.2 ui-monospace,monospace; letter-spacing:.04em; text-transform:uppercase; }
    .status.answered,.status.approved,.status.resolved,.status.connected-not-read { color:#176044; background:#e8f2e9; }
    .status.blocked,.status.high,.status.unavailable { color:#922f25; background:#f8e8e2; }
    .status.needs-artifact,.status.medium,.status.investigating { color:#885a18; background:#fbf0d8; }
    .status.unanswered,.status.draft,.status.missing,.status.open,.status.needs-review { color:#58635b; background:#efede6; }
    .status.reconciled { color:#176044; background:#e8f2e9; }
    .status.skipped { color:#305d78; background:#e5eef2; }
    .blockers { margin:0; padding:0; list-style:none; border-top:1px solid var(--rule); }
    .blockers li { padding:9px 0; border-bottom:1px solid var(--rule); color:#69372e; }
    .source-list { display:grid; gap:8px; }
    .source { display:grid; grid-template-columns:minmax(150px,1fr) auto; gap:8px 14px; padding:11px 0; border-top:1px solid var(--rule); }
    .source p { grid-column:1/-1; margin:0; font-size:13px; }
    .setup-list { display:grid; gap:12px; }
    .setup-item { background:var(--sheet); border:1px solid var(--rule); padding:16px; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; }
    .setup-item h3 { margin:0; font:600 19px Georgia,serif; }
    .setup-item p { margin:7px 0; color:var(--muted); }
    .answer { border-left:3px solid #b88320; padding-left:12px; color:#303a33; white-space:pre-wrap; }
    .table-wrap { overflow-x:auto; background:var(--sheet); border:1px solid var(--rule); }
    table { width:100%; border-collapse:collapse; min-width:900px; }
    th { text-align:left; background:#eae4d7; color:#455047; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    th,td { padding:11px 10px; border-bottom:1px solid var(--rule); vertical-align:top; }
    td.num { text-align:right; font-variant-numeric:tabular-nums; }
    tr:hover td { background:#faf7ef; }
    .negative { color:var(--red); } .positive { color:var(--green); }
    .record-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:13px; }
    .record { background:var(--sheet); border:1px solid var(--rule); padding:15px; position:relative; }
    .record:before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:#b88320; }
    .record h3 { margin:8px 0 5px; font:600 19px Georgia,serif; }
    .record dl { display:grid; grid-template-columns:auto 1fr; gap:6px 12px; font-size:13px; }
    dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
    .record .actions { display:flex; gap:7px; margin-top:13px; }
    .anomaly { display:grid; grid-template-columns:110px minmax(0,1fr) 320px; gap:15px; border-top:1px solid var(--rule); padding:15px 0; }
    .anomaly h3 { margin:0 0 5px; font:600 18px Georgia,serif; }
    .anomaly p { margin:0; color:var(--muted); }
    form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    label { display:grid; gap:5px; font-size:12px; font-weight:800; color:#475149; }
    label.wide,.form-actions { grid-column:1/-1; }
    input,select,textarea { width:100%; border:1px solid #aaa393; border-radius:0; background:white; color:var(--ink); padding:9px 10px; }
    textarea { min-height:90px; resize:vertical; }
    .form-actions { display:flex; gap:8px; flex-wrap:wrap; }
    dialog { width:min(760px,calc(100vw - 24px)); max-height:90vh; overflow:auto; border:1px solid #655f53; padding:0; background:var(--paper); box-shadow:12px 12px 0 #173c2f45; }
    dialog::backdrop { background:#16251dbb; }
    .dialog-head { display:flex; justify-content:space-between; padding:16px 19px; background:#173c2f; color:white; }
    .dialog-head h2 { margin:0; font:500 25px Georgia,serif; }
    .dialog-body { padding:19px; }
    .import-layout { display:grid; grid-template-columns:minmax(260px,1fr) minmax(0,2fr); gap:18px; }
    .import-layout textarea { min-height:330px; font:12px/1.5 ui-monospace,SFMono-Regular,monospace; }
    .note { background:#efe9dc; border-left:4px solid #b88320; padding:12px; color:#4b554e; line-height:1.5; }
    .evidence { font:12px/1.5 ui-monospace,SFMono-Regular,monospace; color:#536057; overflow-wrap:anywhere; }
    .bar { height:8px; background:#ded8ca; margin-top:10px; }
    .bar span { display:block; height:100%; background:#b88320; }
    .toast { position:fixed; right:18px; bottom:18px; z-index:10; max-width:min(440px,calc(100vw - 36px)); background:#17271f; color:white; border-left:5px solid #d2a445; padding:13px 16px; box-shadow:6px 6px 0 #0003; }
    .empty { padding:32px; text-align:center; color:var(--muted); }
    @media(max-width:1050px){ .metrics{grid-template-columns:repeat(3,1fr)} .metric:nth-child(3){border-right:0} .record-grid{grid-template-columns:1fr 1fr} .anomaly{grid-template-columns:90px 1fr}.anomaly form{grid-column:1/-1} }
    @media(max-width:700px){ .mast-grid{grid-template-columns:1fr}.cert{max-width:none}nav{flex-wrap:wrap;overflow-x:visible;padding:0}nav button{flex:1 0 30%;text-align:center}.metrics{grid-template-columns:1fr 1fr}.metric:nth-child(3){border-right:1px solid var(--rule)}.metric:nth-child(even){border-right:0}.card,.card.third{grid-column:1/-1}.record-grid,.import-layout{grid-template-columns:1fr}.setup-item{grid-template-columns:1fr}.anomaly{grid-template-columns:1fr}form{grid-template-columns:1fr}label.wide,.form-actions{grid-column:auto}.page-head{align-items:start;flex-direction:column}.variance-table th:first-child,.variance-table td:first-child{position:sticky;left:0;background:var(--sheet);box-shadow:2px 0 0 var(--rule);z-index:1}.variance-table th:first-child{background:#eae4d7;z-index:2} }
    @media print { body{background:white;font-size:10pt}.masthead{background:white!important;color:black!important;border-bottom:3px solid black;padding:10px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}.masthead p,.top-actions,nav,.page form,.page button,dialog,.toast{display:none!important}.page{padding:12px 0;max-width:none}.cert{display:block!important;border:1px solid black;background:white!important;color:black!important}.card,.record,.table-wrap{box-shadow:none;break-inside:avoid;background:white}.metrics{grid-template-columns:repeat(6,1fr)}.metric{padding:8px}.metric b{font-size:18px}.page-head{margin-top:10px}.record-grid{grid-template-columns:repeat(2,1fr)} }
  </style>
  <header class="masthead">
    <div class="mast-grid"><div><div class="kicker">Internal finance · working review file</div><h1>Finance Operations Workbench</h1><p>Actuals, contracts, assumptions, and exceptions in one evidence-aware review surface. Start offline; connect sources only when scope and authority are approved.</p></div><div class="cert" id="trust-label"></div></div>
    <div class="top-actions"><button class="btn light" data-action="refresh-demo">Refresh demo data</button><button class="btn ghost" data-action="print">Print current section</button><button class="btn danger" data-action="reset-demo">Destructive reset to demo</button></div>
  </header>
  <nav role="tablist" aria-label="Workbench sections"></nav>
  <section class="page" id="content" role="tabpanel"></section>
  <dialog id="editor" aria-labelledby="editor-title"><div class="dialog-head"><h2 id="editor-title">Edit</h2><button class="btn ghost small" data-action="close-editor" aria-label="Close editor">Close</button></div><div class="dialog-body" id="editor-body"></div></dialog>`;
document.body.append(app);

function h(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}
function list(value) {
  return (value || []).map(h).join(" · ") || "No evidence reference";
}
function clamp(value, min, max) {
  let number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}
function money(value, currency = "USD") {
  if (value === null || value === undefined) return "Missing";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Number(value).toLocaleString()} ${h(currency)}`;
  }
}
function pct(value) {
  return value === null || value === undefined ? "n/a" : `${Number(value).toFixed(1)}%`;
}
function options(choices, selected) {
  return choices
    .map(
      (value) =>
        `<option value="${h(value)}" ${value === selected ? "selected" : ""}>${h(value.replaceAll("-", " "))}</option>`,
    )
    .join("");
}
function status(value, extra = "") {
  return `<span class="status ${h(value)} ${h(extra)}">${h(value.replaceAll("-", " "))}</span>`;
}
function toast(message) {
  let node = document.createElement("div");
  node.className = "toast";
  node.role = "status";
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 4500);
}
function heading(title, copy, action = "") {
  return `<div class="page-head"><div><h2>${h(title)}</h2><p>${h(copy)}</p></div>${action}</div>`;
}
function values(form) {
  let output = Object.fromEntries(new FormData(form));
  for (let key of [
    "actual",
    "budget",
    "forecast",
    "noticeDays",
    "annualValue",
    "amount",
    "confidence",
  ])
    if (output[key] !== "" && key in output) output[key] = Number(output[key]);
  return output;
}

function render() {
  document.querySelector("#trust-label").innerHTML =
    `<strong>Draft / derived - not certified</strong><span>${state.readiness.answered}/${state.readiness.total} setup answers · ${state.metrics.openAnomalies} open anomalies</span>`;
  document.querySelector("nav").innerHTML = TABS.map(
    (tab) =>
      `<button id="tab-${tab}" role="tab" data-tab="${tab}" aria-selected="${tab === activeTab}" tabindex="${tab === activeTab ? 0 : -1}" aria-controls="content">${h(tab)}</button>`,
  ).join("");
  document.querySelector("#content").setAttribute("aria-labelledby", `tab-${activeTab}`);
  ({
    overview: renderOverview,
    setup: renderSetup,
    variances: renderVariances,
    contracts: renderContracts,
    forecasts: renderForecasts,
    anomalies: renderAnomalies,
    evidence: renderEvidence,
    imports: renderImports,
    briefing: renderBriefing,
  })[activeTab]();
}

function renderOverview() {
  let m = state.metrics;
  document.querySelector("#content").innerHTML =
    `${heading("Review overview", "A draft package of normalized records and deterministic exceptions. Certification requires human reconciliation and completed setup.")}
    <div class="metrics">${[
      [m.financeRows, "Finance rows"],
      [m.materialVariances, "Material lines"],
      [m.contracts, "Contract findings"],
      [m.forecasts, "Forecast records"],
      [m.openAnomalies, "Open anomalies"],
      [`${m.setupPercent}%`, "Setup complete"],
    ]
      .map(([v, l]) => `<div class="metric"><b>${h(v)}</b><span>${h(l)}</span></div>`)
      .join("")}</div>
    <div class="grid"><article class="card"><h3>Certification blockers</h3>${state.readiness.blockers.length ? `<ul class="blockers">${state.readiness.blockers.map((item) => `<li>${h(item)}</li>`).join("")}</ul>` : `<p>No automated blockers remain. A designated reviewer must still reconcile and certify the package.</p>`}</article>
    <article class="card"><h3>Progressive CFO discovery</h3><p>Use the workbench while configuration is incomplete. Capture answers, missing artifacts, and ownership as review questions arise.</p><div class="bar" aria-label="Setup ${m.setupPercent}% complete"><span style="width:${clamp(m.setupPercent, 0, 100)}%"></span></div><p><button class="btn small" data-tab="setup">Continue setup</button></p></article>
    <article class="card wide"><h3>Optional source boundaries</h3><p>Presence is reported without reading. Google reads happen only from explicit Preview, Import, or Capture actions. Skip persists a privacy decision until re-enabled.</p><div class="source-list">${state.sources.map((source) => `<div class="source"><div><strong>${h(source.label)}</strong> · ${h(source.purpose)}</div>${status(source.status)}<p>${h(source.instruction)}</p><button class="btn small light" data-source="${h(source.key)}" data-skipped="${source.status !== "skipped"}">${source.status === "skipped" ? "Re-enable" : "Skip source"}</button></div>`).join("")}</div></article></div>`;
}

function renderSetup() {
  document.querySelector("#content").innerHTML =
    `${heading("CFO setup & discovery", "Unknowns stay visible as controlled questions with an answer, owner, evidence, and readiness status.")}
    <div class="note">Materiality defaults to an absolute threshold of ${money(state.thresholds.absolute)} or ${state.thresholds.percentage}% and low-confidence threshold of ${Math.round(state.thresholds.confidence * 100)}%. Edit the Materiality question to change them.</div>
    <div class="setup-list">${state.setupItems.map((item) => `<article class="setup-item"><div><h3>${h(item.label)}</h3><p>${h(item.question)}</p><div class="answer">${h(item.answer || "No answer captured.")}</div><p class="evidence">Evidence: ${list(item.evidenceRefs)}${item.owner ? ` · Owner: ${h(item.owner)}` : ""}</p></div><div>${status(item.status)}<p><button class="btn small" data-edit="setup" data-id="${h(item.id)}">Edit answer</button></p></div></article>`).join("")}</div>`;
}

function renderVariances() {
  let rows = state.financeRows;
  document.querySelector("#content").innerHTML =
    `${heading("Monthly variance review", "Actual versus approved budget and latest forecast. Amounts and percentages are derived, not certified.", `<button class="btn" data-edit="finance">Add finance row</button>`)}
    <div class="table-wrap"><table class="variance-table"><thead><tr><th>Period / entity</th><th>Account</th><th>Actual</th><th>Budget</th><th>Δ budget</th><th>Forecast</th><th>Δ forecast</th><th>Owner / source</th><th>Actions</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${h(row.period || "No period")}</strong><br>${h(row.entity)}</td><td><strong>${h(row.account)}</strong><br><span class="evidence">${h(row.category)}</span></td><td class="num">${money(row.actual, row.currency)}</td><td class="num">${money(row.budget, row.currency)}</td><td class="num ${row.budgetVariance.amount < 0 ? "negative" : "positive"}">${money(row.budgetVariance.amount, row.currency)}<br>${pct(row.budgetVariance.percent)} ${row.budgetMaterial ? status("high") : ""}</td><td class="num">${money(row.forecast, row.currency)}</td><td class="num ${row.forecastVariance.amount < 0 ? "negative" : "positive"}">${money(row.forecastVariance.amount, row.currency)}<br>${pct(row.forecastVariance.percent)} ${row.forecastMaterial ? status("medium") : ""}</td><td>${h(row.owner || "Unassigned")}<br><span class="evidence">${h(row.source)} · ${list(row.sourceRefs)}</span></td><td><button class="btn small light" data-edit="finance" data-id="${h(row.id)}">Edit</button> <button class="btn small danger" data-delete="finance" data-id="${h(row.id)}">Delete</button></td></tr>`).join("")}</tbody></table>${rows.length ? "" : `<div class="empty">No finance rows yet.</div>`}</div>`;
}

function renderContracts() {
  document.querySelector("#content").innerHTML =
    `${heading("Contract term intelligence", "Manual findings with confidence and exact evidence references. No document extraction is performed.", `<button class="btn" data-edit="contract">Add finding</button>`)}<div class="record-grid">${state.contracts.map((record) => `<article class="record"><div>${status(record.status)} ${record.confidence < state.thresholds.confidence ? status("medium") : ""}</div><h3>${h(record.vendor)}</h3><p>${h(record.agreement)}</p><dl><dt>Term</dt><dd>${h(record.term || "Not captured")}</dd><dt>Dates</dt><dd>${h(record.startDate || "?")} to ${h(record.endDate || "?")}</dd><dt>Renewal</dt><dd>${h(record.renewalDate || "Not captured")} · ${h(record.noticeDays ?? "?")} days notice</dd><dt>Annual value</dt><dd>${money(record.annualValue, record.currency)}</dd><dt>Finding</dt><dd>${h(record.finding || "No finding")}</dd><dt>Confidence</dt><dd>${Math.round(record.confidence * 100)}%</dd><dt>Evidence</dt><dd class="evidence">${list(record.evidenceRefs)}</dd></dl><div class="actions"><button class="btn small light" data-edit="contract" data-id="${h(record.id)}">Edit</button><button class="btn small danger" data-delete="contract" data-id="${h(record.id)}">Delete</button></div></article>`).join("") || `<div class="empty">No contract findings yet.</div>`}</div>`;
}

function renderForecasts() {
  document.querySelector("#content").innerHTML =
    `${heading("Forecast assumptions", "A review ledger plus deterministic historical-average baselines. Baselines are reproducible heuristics, not ML.", `<button class="btn" data-edit="forecast">Add forecast</button>`)}<div class="card wide"><h3>Generate deterministic baseline</h3><p>For each entity/account/currency, average the latest N canonical historical periods before the target. Approved forecasts are never overwritten.</p><form id="baseline-form"><label>Target period<input name="targetPeriod" required placeholder="2026-09 or 2026-Q4"></label><label>Lookback periods<input name="lookbackPeriods" type="number" min="1" max="12" value="3" required></label><div class="form-actions"><button class="btn">Generate draft baselines</button></div></form></div><div class="record-grid">${state.forecasts.map((record) => `<article class="record"><div>${status(record.status)} ${record.confidence < state.thresholds.confidence ? status("medium") : ""}</div><h3>${h(record.lineItem)}</h3><p>${h(record.entity)} · ${h(record.period)} · ${h(record.scenario)}</p><dl><dt>Forecast</dt><dd>${money(record.amount, record.currency)}</dd><dt>Assumption</dt><dd>${h(record.assumption || "No assumption")}</dd><dt>Owner</dt><dd>${h(record.owner || "Unassigned")}</dd><dt>Source</dt><dd>${h(record.source)}</dd><dt>Confidence</dt><dd>${Math.round(record.confidence * 100)}%</dd><dt>Evidence</dt><dd class="evidence">${list(record.evidenceRefs)}</dd></dl><div class="actions"><button class="btn small light" data-edit="forecast" data-id="${h(record.id)}">Edit</button><button class="btn small danger" data-delete="forecast" data-id="${h(record.id)}">Delete</button></div></article>`).join("") || `<div class="empty">No forecast records yet.</div>`}</div>`;
}

function renderAnomalies() {
  document.querySelector("#content").innerHTML =
    `${heading("Deterministic anomaly triage", "Candidates are rule-based and reproducible. Disposition them with an owner, note, and evidence; no ML is used.")}<div class="card wide">${state.anomalies.map((item) => `<article class="anomaly"><div>${status(item.severity)}<p class="evidence">${h(item.kind)}</p></div><div><h3>${h(item.title)}</h3><p>${h(item.detail)}</p><p class="evidence">Evidence: ${list(item.evidenceRefs)}</p></div><form data-anomaly="${h(item.id)}"><label>Status<select name="status">${options(DISPOSITIONS, item.disposition.status)}</select></label><label>Owner<input name="owner" value="${h(item.disposition.owner)}"></label><label class="wide">Disposition note<textarea name="note">${h(item.disposition.note)}</textarea></label><label class="wide">Evidence refs<input name="evidenceRefs" value="${h((item.disposition.evidenceRefs || []).join("; "))}"></label><div class="form-actions"><button class="btn small">Save disposition</button></div></form></article>`).join("") || `<div class="empty">No anomaly candidates under current thresholds.</div>`}</div>`;
}

function datasetOptions(selected = "finance") {
  return options(["finance", "contracts", "forecasts", "evidence"], selected);
}
function totals(batch) {
  return (
    (batch.controlTotals || [])
      .map(
        (total) =>
          `${h(total.currency)}: ${Object.entries(total)
            .filter(([key]) => key !== "currency")
            .map(([key, value]) => `${h(key)} ${h(value)}`)
            .join(" · ")}`,
      )
      .join("<br>") || "No numeric control totals"
  );
}
function renderEvidence() {
  let sheet = state.sources.find((source) => source.key === "GOOGLE_SHEET"),
    doc = state.sources.find((source) => source.key === "GOOGLE_DOC"),
    gmail = state.sources.find((source) => source.key === "GMAIL_SEARCH");
  let actions = `<button class="btn" data-edit="evidence">Add evidence</button>${doc?.status === "connected-not-read" ? `<button class="btn light" data-action="capture-doc">Read connected Doc excerpt</button>` : ""}${gmail?.status === "connected-not-read" ? `<button class="btn light" data-action="capture-gmail">Read up to 20 scoped thread snippets</button>` : ""}`;
  document.querySelector("#content").innerHTML =
    `${heading("Evidence register", "Bounded provenance records. Doc capture stores metadata plus an excerpt; Gmail capture stores thread metadata/snippets only. Neither creates page-level citations or interpretations.", actions)}${doc?.status === "connected-not-read" || gmail?.status === "connected-not-read" || sheet?.status === "connected-not-read" ? `<div class="note"><strong>Explicit read warning:</strong> Capture and Sheet actions read the currently connected scoped source only after you click. No message bodies, external writes, or automatic reads occur.</div>` : ""}<div class="record-grid">${state.evidenceItems.map((item) => `<article class="record"><div>${status(item.sourceType)}</div><h3>${h(item.title)}</h3><p>${h(item.summary || "No summary")}</p><dl><dt>Reference</dt><dd class="evidence">${h(item.reference || "Not captured")}</dd><dt>Source key</dt><dd>${h(item.sourceKey || "Not captured")}</dd><dt>Owner</dt><dd>${h(item.owner || "Unassigned")}</dd><dt>Confidence</dt><dd>${Math.round(item.confidence * 100)}%</dd><dt>Tags</dt><dd>${list(item.tags)}</dd></dl><div class="actions"><button class="btn small light" data-edit="evidence" data-id="${h(item.id)}">Edit</button><button class="btn small danger" data-delete="evidence" data-id="${h(item.id)}">Delete</button></div></article>`).join("") || `<div class="empty">No evidence items yet.</div>`}</div>`;
}
function renderImports() {
  let preview = sheetPreview
    ? `<div class="card wide"><h3>Sheet preview: ${h(sheetPreview.spreadsheetTitle)} · ${h(sheetPreview.canonicalRange)}</h3><p>${h(sheetPreview.rowCount)} mapped row(s); showing up to 10. Mapping: ${(sheetPreview.mapping || []).map((item) => `${h(item.header)} → ${h(item.field)}`).join(" · ")}</p><p>${(sheetPreview.warnings || []).map(h).join(" · ") || "No mapping warnings"}</p><pre class="evidence">${h(JSON.stringify(sheetPreview.records, null, 2))}</pre><p>${totals(sheetPreview)}</p></div>`
    : "";
  document.querySelector("#content").innerHTML =
    `${heading("Imports & reconciliation review", "Pasted and explicit bounded Google Sheet imports share normalization, mappings, lineage, control totals, and review batches. Reconciled means reviewed here, never system-certified.")}<div class="import-layout"><aside><div class="note"><strong>Trust boundary</strong><br>Imports are working data. Common finance headings, amount strings, and periods are normalized deterministically. Mixed currencies remain separate.</div><p>JSON accepts an array or <code>{"records": [...]}</code>. CSV/Sheet aliases include fiscal/posting period, subsidiary/legal entity/business unit, GL account/line item, actual amount, approved budget, latest estimate, currency code, owner, notes, and source/evidence refs.</p></aside><form id="import-form"><label>Dataset<select name="dataset">${datasetOptions()}</select></label><label>Format<select name="format"><option value="csv">CSV</option><option value="json">JSON</option></select></label><label class="wide">Paste import data<textarea name="value" required placeholder="Fiscal Period,Legal Entity,GL Account,Actual Amount,Approved Budget,Currency Code"></textarea></label><div class="form-actions"><button class="btn">Import selected dataset</button></div></form></div><div class="card wide"><h3>Explicit Google Sheet range</h3><form id="sheet-form"><label>Dataset<select name="dataset">${datasetOptions()}</select></label><label>Value mode<select name="valueMode">${options(["formatted", "raw", "formula"], "formatted")}</select></label><label class="wide">Bounded A1 range<input name="range" required placeholder="'Budget 2026'!A1:H201"></label><div class="form-actions"><button class="btn light" name="intent" value="preview">Preview explicit read</button><button class="btn" name="intent" value="import">Import explicit read</button></div></form></div>${preview}<div class="card wide"><h3>Latest import batches</h3>${state.importBatches.map((batch) => `<article class="anomaly"><div>${status(batch.status)}<p>${h(batch.dataset)}</p></div><div><h3>${h(batch.sourceName || batch.sourceType)}</h3><p class="evidence">${h(batch.sourceRef)}</p><p>${h(batch.acceptedCount)} accepted / ${h(batch.rowCount)} rows · ${h(batch.truncatedCount)} truncated</p><p>${totals(batch)}</p><p>${(batch.warnings || []).map(h).join(" · ") || "No warnings"}</p></div><form data-batch="${h(batch.id)}"><label>Status<select name="status">${options(["draft", "needs-review", "blocked", "reconciled"], batch.status)}</select></label><label>Reviewer<input name="reviewer" value="${h(batch.reviewer)}"></label><label class="wide">Review note<textarea name="note">${h(batch.note)}</textarea></label><label class="wide">Evidence refs<input name="evidenceRefs" value="${h((batch.evidenceRefs || []).join("; "))}"></label><div class="form-actions"><button class="btn small">Save batch review</button></div></form></article>`).join("") || `<div class="empty">No import batches yet.</div>`}</div>`;
}
function renderBriefing() {
  let briefing = state.briefing;
  document.querySelector("#content").innerHTML =
    `${heading("CFO prep briefing", "Facts and deterministic derivatives from this workbench only. No certification or invented narrative.", `<button class="btn" data-action="copy-briefing">Copy Markdown</button><button class="btn light" data-action="print">Print briefing</button>`)}<div class="note"><strong>${h(briefing.label)}</strong><br>Generated ${h(briefing.generatedAt)}. A reconciled import batch means reviewed in this workbench only.</div><div class="grid"><article class="card"><h3>Top material variances</h3>${briefing.topMaterialVariances.map((item) => `<p><strong>${h(item.entity)} / ${h(item.account)}</strong><br>${h(item.period)} · ${h(item.currency)} · budget ${money(item.budgetVariance.amount, item.currency)} · forecast ${money(item.forecastVariance.amount, item.currency)}</p>`).join("") || `<p>None under current thresholds.</p>`}</article><article class="card"><h3>Contract watchlist</h3>${briefing.contractWatchlist.map((item) => `<p><strong>${h(item.vendor)}</strong><br>${h(item.agreement)} · renewal ${h(item.renewalDate || "not captured")} · ${h(item.status)}</p>`).join("") || `<p>No open contracts.</p>`}</article><article class="card"><h3>Forecast risks</h3>${briefing.forecastRisks.map((item) => `<p><strong>${h(item.entity)} / ${h(item.lineItem)}</strong><br>${h(item.period)} · ${h(item.status)} · confidence ${h(item.confidence)}</p>`).join("") || `<p>No derived risks.</p>`}</article><article class="card"><h3>Open questions</h3>${briefing.openQuestions.map((item) => `<p>${status(item.status)} ${h(item.question)}</p>`).join("") || `<p>No setup questions remain open.</p>`}</article><article class="card wide"><h3>Preparation tasks</h3><ul class="blockers">${briefing.prepTasks.map((item) => `<li><strong>${h(item.severity)} · ${h(item.workflow)} · ${h(item.title)}</strong><br>${h(item.detail)}</li>`).join("")}</ul></article><article class="card wide"><h3>Evidence references</h3><p class="evidence">${list(briefing.evidenceRefs)}</p></article></div>`;
}

function input(name, label, value = "", type = "text", wide = false) {
  let constraints =
    type === "number" && name === "confidence"
      ? ' min="0" max="1" step="0.01"'
      : type === "number" && name === "noticeDays"
        ? ' min="0" max="3650" step="1"'
        : "";
  return `<label class="${wide ? "wide" : ""}">${h(label)}<input name="${h(name)}" type="${h(type)}" value="${h(value ?? "")}"${constraints}></label>`;
}
function area(name, label, value = "") {
  return `<label class="wide">${h(label)}<textarea name="${h(name)}">${h(value ?? "")}</textarea></label>`;
}
function select(name, label, choices, value) {
  return `<label>${h(label)}<select name="${h(name)}">${options(choices, value)}</select></label>`;
}
function refs(record, field = "sourceRefs") {
  return input(
    field,
    "Evidence / source refs (semicolon-separated)",
    (record[field] || []).join("; "),
    "text",
    true,
  );
}

function openEditor(kind, id) {
  editing = { kind, id };
  let record, title, fields;
  if (kind === "finance") {
    record = state.financeRows.find((item) => item.id === id) || {};
    title = id ? "Edit finance row" : "Add finance row";
    fields = `${input("id", "", record.id, "hidden")}${input("period", "Period", record.period, "text")}${input("entity", "Entity", record.entity)}${input("account", "Account / line item", record.account, "text", true)}${input("category", "Category", record.category)}${input("currency", "Currency", record.currency || "USD")}${input("actual", "Actual", record.actual, "number")}${input("budget", "Budget", record.budget, "number")}${input("forecast", "Forecast", record.forecast, "number")}${input("owner", "Owner", record.owner)}${input("source", "Source", record.source || "manual")}${area("notes", "Review note", record.notes)}${refs(record)}`;
  }
  if (kind === "contract") {
    record = state.contracts.find((item) => item.id === id) || {};
    title = id ? "Edit contract finding" : "Add contract finding";
    fields = `${input("id", "", record.id, "hidden")}${input("vendor", "Vendor", record.vendor)}${input("agreement", "Agreement", record.agreement, "text", true)}${input("term", "Term", record.term)}${input("startDate", "Start date", record.startDate, "date")}${input("endDate", "End date", record.endDate, "date")}${input("renewalDate", "Renewal date", record.renewalDate, "date")}${input("noticeDays", "Notice days", record.noticeDays, "number")}${input("annualValue", "Annual value", record.annualValue, "number")}${input("currency", "Currency", record.currency || "USD")}${input("owner", "Owner", record.owner)}${select("status", "Review status", REVIEW_STATUSES, record.status || "draft")}${input("confidence", "Confidence (0 to 1)", record.confidence ?? 0.5, "number")}${input("source", "Source", record.source || "manual")}${area("finding", "Finding", record.finding)}${refs(record, "evidenceRefs")}`;
  }
  if (kind === "forecast") {
    record = state.forecasts.find((item) => item.id === id) || {};
    title = id ? "Edit forecast" : "Add forecast";
    fields = `${input("id", "", record.id, "hidden")}${input("period", "Period", record.period)}${input("entity", "Entity", record.entity)}${input("lineItem", "Line item", record.lineItem, "text", true)}${input("amount", "Forecast amount", record.amount, "number")}${input("currency", "Currency", record.currency || "USD")}${input("scenario", "Scenario", record.scenario || "Latest estimate")}${input("owner", "Owner", record.owner)}${select("status", "Review status", REVIEW_STATUSES, record.status || "draft")}${input("confidence", "Confidence (0 to 1)", record.confidence ?? 0.5, "number")}${input("source", "Source", record.source || "manual")}${area("assumption", "Assumption", record.assumption)}${refs(record, "evidenceRefs")}`;
  }
  if (kind === "evidence") {
    record = state.evidenceItems.find((item) => item.id === id) || {};
    title = id ? "Edit evidence" : "Add evidence";
    fields = `${input("id", "", record.id, "hidden")}${input("title", "Title", record.title, "text", true)}${select("sourceType", "Source type", ["manual", "import", "google-sheet", "google-doc", "gmail", "demo"], record.sourceType || "manual")}${input("sourceKey", "Source key", record.sourceKey)}${input("reference", "Reference", record.reference, "text", true)}${input("owner", "Owner", record.owner)}${input("confidence", "Confidence (0 to 1)", record.confidence ?? 0.5, "number")}${input("tags", "Tags (semicolon-separated)", (record.tags || []).join("; "), "text", true)}${area("summary", "Bounded summary", record.summary)}`;
  }
  if (kind === "setup") {
    record = state.setupItems.find((item) => item.id === id);
    title = record.label;
    let material =
      record.id === "materiality"
        ? `${input("absolute", "Absolute threshold", state.thresholds.absolute, "number")}${input("percentage", "Percentage threshold", state.thresholds.percentage, "number")}${input("confidence", "Low-confidence threshold (0 to 1)", state.thresholds.confidence, "number")}${input("spikePercentage", "Actual spike threshold %", state.thresholds.spikePercentage, "number")}`
        : "";
    fields = `${select("status", "Status", SETUP_STATUSES, record.status)}${input("owner", "Owner", record.owner)}${area("answer", record.question, record.answer)}${refs(record, "evidenceRefs")}${material}`;
  }
  document.querySelector("#editor-title").textContent = title;
  document.querySelector("#editor-body").innerHTML =
    `<form id="editor-form">${fields}<div class="form-actions"><button class="btn">Save</button><button type="button" class="btn light" data-action="close-editor">Cancel</button></div></form>`;
  document.querySelector("#editor").showModal();
}

async function saveEditor(form) {
  let data = values(form);
  try {
    if (editing.kind === "finance") state = await gadget.saveFinanceRow(data);
    if (editing.kind === "contract") state = await gadget.saveContractFinding(data);
    if (editing.kind === "forecast") state = await gadget.saveForecastRecord(data);
    if (editing.kind === "evidence") state = await gadget.saveEvidenceItem(data);
    if (editing.kind === "setup") {
      let thresholds = {
        absolute: Number(data.absolute),
        percentage: Number(data.percentage),
        confidence: Number(data.confidence),
        spikePercentage: Number(data.spikePercentage),
      };
      for (let key of Object.keys(thresholds))
        if (!Number.isFinite(thresholds[key])) delete thresholds[key];
      state = await gadget.updateSetupItem(editing.id, { ...data, thresholds });
    }
    document.querySelector("#editor").close();
    render();
    toast("Changes saved to the working review file.");
  } catch (error) {
    toast(error?.message || "Could not save changes.");
  }
}

document.addEventListener("click", async (event) => {
  let target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.tab) {
    activeTab = target.dataset.tab;
    render();
    return;
  }
  if (target.dataset.edit) {
    openEditor(target.dataset.edit, target.dataset.id);
    return;
  }
  if (target.dataset.action === "close-editor") {
    document.querySelector("#editor").close();
    return;
  }
  if (target.dataset.action === "print") {
    window.print();
    return;
  }
  if (target.dataset.action === "copy-briefing") {
    try {
      await navigator.clipboard.writeText(state.briefingMarkdown);
      toast("Briefing Markdown copied.");
    } catch (error) {
      toast(error?.message || "Could not copy briefing Markdown.");
    }
    return;
  }
  if (target.dataset.action === "capture-doc") {
    try {
      let result = await gadget.captureGoogleDocEvidence();
      state = result.state;
      render();
      toast("Captured one bounded Google Doc evidence excerpt.");
    } catch (error) {
      toast(error?.message || "Google Doc capture failed.");
    }
    return;
  }
  if (target.dataset.action === "capture-gmail") {
    try {
      let result = await gadget.captureGmailEvidence();
      state = result.state;
      render();
      toast(`Captured ${result.captured} Gmail thread metadata record(s).`);
    } catch (error) {
      toast(error?.message || "Gmail capture failed.");
    }
    return;
  }
  if (target.dataset.action === "refresh-demo") {
    state = await gadget.refreshDemoData();
    render();
    toast("Demo data refreshed. Manual and imported records were preserved.");
    return;
  }
  if (target.dataset.action === "reset-demo") {
    if (!resetArmed) {
      resetArmed = true;
      target.textContent = "Click again: erase records and reset setup";
      setTimeout(() => {
        resetArmed = false;
        if (target.isConnected) target.textContent = "Destructive reset to demo";
      }, 5000);
      return;
    }
    state = await gadget.destructiveResetToDemo();
    resetArmed = false;
    render();
    toast("Destructive reset complete. All prior records and setup answers were removed.");
    return;
  }
  if (target.dataset.source) {
    state = await gadget.setSourceSkipped(target.dataset.source, target.dataset.skipped === "true");
    render();
    toast("Optional source preference updated. No source was read.");
    return;
  }
  if (target.dataset.delete) {
    let key = `${target.dataset.delete}:${target.dataset.id}`;
    if (!deleteArmed || deleteArmed.key !== key || deleteArmed.expiresAt < Date.now()) {
      if (deleteArmed?.button?.isConnected)
        deleteArmed.button.textContent = deleteArmed.originalText;
      let armed = {
        key,
        button: target,
        originalText: target.textContent,
        expiresAt: Date.now() + 5000,
      };
      deleteArmed = armed;
      target.textContent = "Click again within 5 seconds to delete";
      setTimeout(() => {
        if (deleteArmed !== armed) return;
        if (target.isConnected) target.textContent = armed.originalText;
        deleteArmed = null;
      }, 5000);
      return;
    }
    let methods = {
      finance: "deleteFinanceRow",
      contract: "deleteContractFinding",
      forecast: "deleteForecastRecord",
      evidence: "deleteEvidenceItem",
    };
    deleteArmed = null;
    state = await gadget[methods[target.dataset.delete]](target.dataset.id);
    render();
    toast("Record deleted from the working file.");
  }
});

document.addEventListener("keydown", (event) => {
  let target = event.target.closest('[role="tab"]');
  if (!target || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  let index = TABS.indexOf(target.dataset.tab);
  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = TABS.length - 1;
  else index = (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
  activeTab = TABS[index];
  render();
  document.querySelector(`#tab-${activeTab}`).focus();
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "editor-form") return saveEditor(event.target);
  if (event.target.id === "import-form") {
    let data = values(event.target);
    try {
      let result = await gadget.importDataset(data.dataset, data.value, data.format);
      state = result.state;
      render();
      toast(
        `Imported ${result.imported} record(s).${result.truncated ? " Additional rows exceeded the safety limit." : ""}`,
      );
    } catch (error) {
      toast(error?.message || "Import failed.");
    }
    return;
  }
  if (event.target.id === "sheet-form") {
    let data = values(event.target);
    let intent = event.submitter?.value || "preview";
    try {
      if (intent === "preview") {
        sheetPreview = await gadget.previewGoogleSheetRange(data);
        render();
        toast("Sheet preview read completed; nothing was persisted.");
      } else {
        let result = await gadget.importGoogleSheetRange(data);
        state = result.state;
        sheetPreview = null;
        render();
        toast(`Imported ${result.imported} Sheet record(s).`);
      }
    } catch (error) {
      toast(error?.message || "Google Sheet read failed.");
    }
    return;
  }
  if (event.target.id === "baseline-form") {
    let data = values(event.target);
    try {
      let result = await gadget.generateForecastBaselines(data);
      state = result.state;
      render();
      toast(`Generated ${result.generated} baseline(s); skipped ${result.skipped}.`);
    } catch (error) {
      toast(error?.message || "Baseline generation failed.");
    }
    return;
  }
  if (event.target.dataset.batch) {
    try {
      state = await gadget.updateImportBatchReview(
        event.target.dataset.batch,
        values(event.target),
      );
      render();
      toast("Import batch review saved. Trust remains not certified.");
    } catch (error) {
      toast(error?.message || "Batch review could not be saved.");
    }
    return;
  }
  if (event.target.dataset.anomaly) {
    try {
      state = await gadget.updateAnomalyDisposition(
        event.target.dataset.anomaly,
        values(event.target),
      );
      render();
      toast("Anomaly disposition saved.");
    } catch (error) {
      toast(error?.message || "Disposition could not be saved.");
    }
  }
});

state = await gadget.getState();
render();
