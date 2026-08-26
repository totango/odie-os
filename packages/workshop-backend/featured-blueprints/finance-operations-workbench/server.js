import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY = "finance-operations-workbench:v1";
const MAX_RECORDS = 300;
const MAX_IMPORT_RECORDS = 200;
const MAX_IMPORT_BATCHES = 50;
const MAX_INPUT_TEXT = 256 * 1024;
const MAX_TEXT = 1200;
const SETUP_STATUSES = ["unanswered", "answered", "needs-artifact", "blocked"];
const REVIEW_STATUSES = ["draft", "in-review", "approved", "resolved"];
const BATCH_STATUSES = ["draft", "needs-review", "blocked", "reconciled"];
const DISPOSITIONS = ["open", "investigating", "explained", "accepted", "resolved"];
const EVIDENCE_SOURCES = ["manual", "import", "google-sheet", "google-doc", "gmail", "demo"];
const DATASETS = ["finance", "contracts", "forecasts", "evidence"];

const SOURCE_DEFINITIONS = [
  {
    key: "GOOGLE_SHEET",
    label: "Google Sheet",
    purpose: "Explicit bounded preview/import of an approved workbook range.",
  },
  {
    key: "GOOGLE_DOC",
    label: "Google Doc",
    purpose: "Explicit bounded capture of document metadata and an excerpt.",
  },
  {
    key: "GMAIL_SEARCH",
    label: "Scoped Gmail",
    purpose: "Explicit metadata/snippet capture from the connected search scope.",
  },
  {
    key: "NETSUITE_ROUTE",
    label: "NetSuite route",
    purpose: "Placeholder only. No certified NetSuite reconciliation exists.",
  },
  {
    key: "SCHEDULER",
    label: "Scheduler",
    purpose: "Optional future review reminders and recurring refresh orchestration.",
  },
];

const SETUP_DEFINITIONS = [
  {
    id: "fiscal-calendar",
    label: "Fiscal calendar",
    question:
      "What fiscal year, period calendar, close cadence, and current review period govern this package?",
  },
  {
    id: "entities",
    label: "Entities",
    question: "Which legal entities, business units, and eliminations are in scope?",
  },
  {
    id: "currency",
    label: "Local and reporting currency",
    question:
      "What are each entity's local currency, reporting currency, and approved FX-rate basis?",
  },
  {
    id: "materiality",
    label: "Materiality",
    question: "What absolute and percentage thresholds require explanation or approval?",
  },
  {
    id: "budget-source",
    label: "Authoritative budget source",
    question: "Which artifact and version is the approved budget or latest forecast baseline?",
  },
  {
    id: "report-package",
    label: "Report package",
    question: "Who receives the package, what sections are required, and when is it due?",
  },
  {
    id: "source-boundaries",
    label: "Source boundaries",
    question: "Which systems and document scopes may be used, and what must remain excluded?",
  },
  {
    id: "approvals",
    label: "Approvals",
    question: "Who prepares, reviews, and certifies each workflow and material exception?",
  },
  {
    id: "historical-readiness",
    label: "Historical-data readiness",
    question:
      "How many reconciled periods are available for comparisons, and where are known gaps documented?",
  },
];

const DEMO_FINANCE_ROWS = [
  {
    id: "demo-fin-1",
    period: "2026-07",
    entity: "North America",
    account: "Subscription revenue",
    category: "Revenue",
    actual: 1284000,
    budget: 1210000,
    forecast: 1245000,
    currency: "USD",
    owner: "FP&A",
    notes: "Expansion revenue exceeded the approved plan.",
    source: "demo",
    sourceRefs: ["demo:evidence:ledger-july", "demo:evidence:budget-v1"],
  },
  {
    id: "demo-fin-2",
    period: "2026-07",
    entity: "North America",
    account: "Cloud infrastructure",
    category: "Cost of revenue",
    actual: 318000,
    budget: 250000,
    forecast: 270000,
    currency: "USD",
    owner: "Finance Ops",
    notes: "Usage and egress increased after enterprise migrations.",
    source: "demo",
    sourceRefs: ["demo:evidence:ledger-july"],
  },
  {
    id: "demo-fin-3",
    period: "2026-06",
    entity: "North America",
    account: "Cloud infrastructure",
    category: "Cost of revenue",
    actual: 204000,
    budget: 242000,
    forecast: 245000,
    currency: "USD",
    owner: "Finance Ops",
    notes: "Prior-period comparison for deterministic spike review.",
    source: "demo",
    sourceRefs: ["demo:evidence:ledger-june"],
  },
  {
    id: "demo-fin-4",
    period: "2026-07",
    entity: "EMEA",
    account: "Professional services",
    category: "Revenue",
    actual: 186000,
    budget: null,
    forecast: 225000,
    currency: "EUR",
    owner: "Regional Finance",
    notes: "Approved budget artifact has not been attached.",
    source: "demo",
    sourceRefs: ["demo:evidence:ledger-july"],
  },
  {
    id: "demo-fin-5",
    period: "2026-07",
    entity: "Corporate",
    account: "Legal and compliance",
    category: "Operating expense",
    actual: 142000,
    budget: 90000,
    forecast: null,
    currency: "USD",
    owner: "Controller",
    notes: "Forecast baseline is missing for this line.",
    source: "demo",
    sourceRefs: ["demo:evidence:ledger-july"],
  },
];
const DEMO_CONTRACTS = [
  {
    id: "demo-contract-1",
    vendor: "Example Cloud Co",
    agreement: "Infrastructure master services agreement",
    term: "36 months",
    startDate: "2025-01-01",
    endDate: "2027-12-31",
    renewalDate: "2027-12-31",
    noticeDays: 90,
    annualValue: 960000,
    currency: "USD",
    owner: "Procurement",
    finding:
      "Usage commitment resets annually; renewal notice must be sent 90 days before term end.",
    status: "in-review",
    confidence: 0.92,
    source: "demo",
    evidenceRefs: ["demo:evidence:cloud-msa"],
  },
  {
    id: "demo-contract-2",
    vendor: "Sample Data Services",
    agreement: "Data enrichment order form",
    term: "12 months",
    startDate: "2026-02-01",
    endDate: "2027-01-31",
    renewalDate: "2027-02-01",
    noticeDays: 30,
    annualValue: 180000,
    currency: "USD",
    owner: "Business Operations",
    finding:
      "Auto-renewal wording was manually summarized; original signed order form is still needed.",
    status: "draft",
    confidence: 0.42,
    source: "demo",
    evidenceRefs: ["demo:evidence:procurement-email"],
  },
];
const DEMO_FORECASTS = [
  {
    id: "demo-forecast-1",
    period: "2026-08",
    entity: "North America",
    lineItem: "Subscription revenue",
    amount: 1325000,
    currency: "USD",
    scenario: "Latest estimate",
    assumption: "Net retention remains at 108% and two signed expansions begin mid-month.",
    owner: "Revenue FP&A",
    status: "in-review",
    confidence: 0.84,
    source: "demo",
    evidenceRefs: ["demo:evidence:pipeline-august"],
  },
  {
    id: "demo-forecast-2",
    period: "2026-08",
    entity: "Corporate",
    lineItem: "Cloud infrastructure",
    amount: 335000,
    currency: "USD",
    scenario: "Latest estimate",
    assumption: "July run-rate persists; no committed optimization plan is evidenced.",
    owner: "Finance Ops",
    status: "draft",
    confidence: 0.48,
    source: "demo",
    evidenceRefs: ["demo:evidence:ledger-july"],
  },
  {
    id: "demo-forecast-3",
    period: "2026-Q3",
    entity: "EMEA",
    lineItem: "Professional services",
    amount: 610000,
    currency: "EUR",
    scenario: "Management case",
    assumption: "Three implementations shift from Q4 into September, subject to staffing approval.",
    owner: "Regional Finance",
    status: "draft",
    confidence: 0.58,
    source: "demo",
    evidenceRefs: ["demo:evidence:staffing-plan"],
  },
];
const DEMO_EVIDENCE = [
  {
    id: "demo:evidence:ledger-july",
    title: "July demo ledger extract",
    sourceType: "demo",
    sourceKey: "demo-ledger-2026-07",
    reference: "demo:ledger:2026-07",
    summary: "Synthetic July actuals used only to demonstrate variance review.",
    owner: "Finance Ops",
    confidence: 1,
    tags: ["actuals", "demo"],
  },
  {
    id: "demo:evidence:ledger-june",
    title: "June demo ledger extract",
    sourceType: "demo",
    sourceKey: "demo-ledger-2026-06",
    reference: "demo:ledger:2026-06",
    summary: "Synthetic prior-period actuals used only for deterministic comparisons.",
    owner: "Finance Ops",
    confidence: 1,
    tags: ["actuals", "demo"],
  },
  {
    id: "demo:evidence:budget-v1",
    title: "Approved budget demo v1",
    sourceType: "demo",
    sourceKey: "demo-budget-v1",
    reference: "demo:budget:v1",
    summary: "Synthetic approved-plan values for the starter.",
    owner: "FP&A",
    confidence: 1,
    tags: ["budget", "demo"],
  },
  {
    id: "demo:evidence:cloud-msa",
    title: "Example Cloud Co MSA summary",
    sourceType: "demo",
    sourceKey: "demo-cloud-msa",
    reference: "demo:contract:cloud-msa",
    summary:
      "Synthetic contract reference; not a page-level citation or extracted legal conclusion.",
    owner: "Procurement",
    confidence: 0.9,
    tags: ["contract", "demo"],
  },
  {
    id: "demo:evidence:procurement-email",
    title: "Procurement summary thread",
    sourceType: "demo",
    sourceKey: "demo-procurement-email",
    reference: "demo:gmail:procurement",
    summary: "Synthetic email metadata/summary reference.",
    owner: "Business Operations",
    confidence: 0.5,
    tags: ["contract", "demo"],
  },
  {
    id: "demo:evidence:pipeline-august",
    title: "August pipeline snapshot",
    sourceType: "demo",
    sourceKey: "demo-pipeline-august",
    reference: "demo:pipeline:2026-08",
    summary: "Synthetic pipeline support for a demo forecast.",
    owner: "Revenue FP&A",
    confidence: 0.8,
    tags: ["forecast", "demo"],
  },
  {
    id: "demo:evidence:staffing-plan",
    title: "EMEA staffing plan summary",
    sourceType: "demo",
    sourceKey: "demo-staffing-plan",
    reference: "demo:staffing:emea",
    summary: "Synthetic staffing assumption reference.",
    owner: "Regional Finance",
    confidence: 0.6,
    tags: ["forecast", "demo"],
  },
];
const DEMO_IDS = new Set(
  [...DEMO_FINANCE_ROWS, ...DEMO_CONTRACTS, ...DEMO_FORECASTS, ...DEMO_EVIDENCE].map(
    (record) => record.id,
  ),
);

const COMMON_ALIASES = {
  fiscal_period: "period",
  posting_period: "period",
  fiscal_posting_period: "period",
  legal_entity: "entity",
  subsidiary: "entity",
  business_unit: "entity",
  gl_account: "account",
  account_name: "account",
  line_item: "lineItem",
  actual_amount: "actual",
  approved_budget: "budget",
  budget_amount: "budget",
  latest_estimate: "forecast",
  forecast_amount: "forecast",
  currency_code: "currency",
  record_owner: "owner",
  note: "notes",
  comments: "notes",
  source_ref: "sourceRefs",
  source_refs: "sourceRefs",
  evidence_ref: "evidenceRefs",
  evidence_refs: "evidenceRefs",
};
const DATASET_ALIASES = {
  finance: { amount: "actual", gl_line_item: "account", forecast_latest_estimate: "forecast" },
  contracts: {
    contract_title: "agreement",
    contract_name: "agreement",
    supplier: "vendor",
    annual_contract_value: "annualValue",
    contract_value: "annualValue",
    renewal_date: "renewalDate",
    notice_days: "noticeDays",
    review_status: "status",
  },
  forecasts: {
    account: "lineItem",
    gl_account: "lineItem",
    actual_amount: "amount",
    forecast: "amount",
    latest_estimate: "amount",
    forecast_latest_estimate: "amount",
    assumptions: "assumption",
    review_status: "status",
  },
  evidence: {
    name: "title",
    evidence_title: "title",
    source_type: "sourceType",
    source_key: "sourceKey",
    source_reference: "reference",
    source_ref: "reference",
    source_refs: "reference",
    evidence_ref: "reference",
    evidence_refs: "reference",
    description: "summary",
    tags_labels: "tags",
  },
};

function nowIso() {
  return new Date().toISOString();
}
function text(value, limit = MAX_TEXT) {
  return String(value ?? "")
    .slice(0, limit)
    .trim();
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function enumValue(value, allowed, fallback) {
  let candidate = text(value, 40).toLowerCase();
  return allowed.includes(candidate) ? candidate : fallback;
}
function numberValue(value, fallback = null, min = -1e15, max = 1e15) {
  if (value === "" || value === null || value === undefined) return fallback;
  let parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function amountValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? Math.max(-1e15, Math.min(1e15, value)) : null;
  let input = text(value, 80);
  if (!input || input.includes("%")) return null;
  let negative = /^\(.*\)$/u.test(input);
  if (negative) input = input.slice(1, -1).trim();
  let suffix = /([kKmM])$/u.exec(input);
  let multiplier = suffix?.[1].toLowerCase() === "k" ? 1e3 : suffix ? 1e6 : 1;
  if (suffix) input = input.slice(0, -1).trim();
  input = input.replace(/[$€£¥₹,\s]/gu, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(input)) return null;
  let parsed = Number(input) * multiplier * (negative ? -1 : 1);
  return Number.isFinite(parsed) ? Math.max(-1e15, Math.min(1e15, parsed)) : null;
}
function references(value, limit = 12) {
  let values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[;,\n]/u)
      : value == null
        ? []
        : [value];
  return [...new Set(values.map((item) => text(item, 240)).filter(Boolean))].slice(0, limit);
}
function tags(value) {
  return references(value, 12).map((item) => text(item, 60));
}
function dateText(value) {
  return text(value, 40);
}
function validTimestamp(value) {
  let timestamp = dateText(value);
  if (!timestamp) return "";
  let parsed = new Date(timestamp);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === timestamp ? timestamp : "";
}
function idValue(value) {
  return text(value, 100) || crypto.randomUUID();
}
function preserveCreated(input, existing, fallback) {
  return (
    validTimestamp(existing?.createdAt) ||
    validTimestamp(input.createdAt) ||
    validTimestamp(fallback) ||
    nowIso()
  );
}
function preserveUpdated(input, existing, fallback) {
  return (
    validTimestamp(input.updatedAt) ||
    validTimestamp(existing?.updatedAt) ||
    validTimestamp(fallback) ||
    nowIso()
  );
}
function isDemo(record) {
  return DEMO_IDS.has(record.id);
}
function stableHash(value) {
  let hash = 2166136261;
  for (let char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function normalizeHeader(value) {
  return text(value, 160)
    .replace(/^\uFEFF/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_|_$/gu, "");
}
function camelHeader(value) {
  return normalizeHeader(value).replace(/_([a-z0-9])/gu, (_, char) => char.toUpperCase());
}
function canonicalPeriod(value, warnings) {
  let original = text(value, 40);
  if (!original) return "";
  let monthly = /^(\d{4})[-/](0?[1-9]|1[0-2])$/u.exec(original);
  if (monthly) return `${monthly[1]}-${String(Number(monthly[2])).padStart(2, "0")}`;
  let named =
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})$/iu.exec(
      original,
    );
  if (named) {
    let month =
      ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
        named[1].slice(0, 3).toLowerCase(),
      ) + 1;
    return `${named[2]}-${String(month).padStart(2, "0")}`;
  }
  let quarter =
    /^Q([1-4])\s+(\d{4})$/iu.exec(original) || /^(\d{4})[-/]?Q([1-4])$/iu.exec(original);
  if (quarter)
    return quarter[0].toUpperCase().startsWith("Q")
      ? `${quarter[2]}-Q${quarter[1]}`
      : `${quarter[1]}-Q${quarter[2]}`;
  warnings?.push(`Unrecognized period retained as entered: ${original}`);
  return original;
}
function periodOrder(value) {
  let monthly = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(value);
  if (monthly) return { grain: "month", value: Number(monthly[1]) * 12 + Number(monthly[2]) - 1 };
  let quarterly = /^(\d{4})-Q([1-4])$/u.exec(value);
  return quarterly
    ? { grain: "quarter", value: Number(quarterly[1]) * 4 + Number(quarterly[2]) - 1 }
    : null;
}

function normalizeFinanceRow(input, existing, warnings, timestampFallback) {
  input = object(input);
  let createdAt = preserveCreated(input, existing, timestampFallback);
  return {
    id: idValue(input.id),
    period: canonicalPeriod(input.period, warnings),
    entity: text(input.entity, 120) || "Unspecified entity",
    account: text(input.account || input.lineItem, 160) || "Unspecified account",
    category: text(input.category, 100),
    actual: amountValue(input.actual),
    budget: amountValue(input.budget),
    forecast: amountValue(input.forecast),
    currency: text(input.currency, 12).toUpperCase() || "USD",
    owner: text(input.owner, 100),
    notes: text(input.notes),
    source: text(input.source, 80) || "manual",
    sourceRefs: references(input.sourceRefs || input.evidenceRefs || input.sourceRef),
    createdAt,
    updatedAt: preserveUpdated(input, existing, createdAt),
  };
}
function normalizeContract(input, existing, _warnings, timestampFallback) {
  input = object(input);
  let createdAt = preserveCreated(input, existing, timestampFallback);
  return {
    id: idValue(input.id),
    vendor: text(input.vendor, 140) || "Unspecified vendor",
    agreement: text(input.agreement || input.title, 180) || "Untitled agreement",
    term: text(input.term, 100),
    startDate: dateText(input.startDate),
    endDate: dateText(input.endDate),
    renewalDate: dateText(input.renewalDate),
    noticeDays: numberValue(input.noticeDays, null, 0, 3650),
    annualValue: amountValue(input.annualValue),
    currency: text(input.currency, 12).toUpperCase() || "USD",
    owner: text(input.owner, 100),
    finding: text(input.finding || input.notes),
    status: enumValue(input.status, REVIEW_STATUSES, "draft"),
    confidence: numberValue(input.confidence, 0.5, 0, 1),
    source: text(input.source, 80) || "manual",
    evidenceRefs: references(input.evidenceRefs || input.sourceRefs || input.evidence),
    createdAt,
    updatedAt: preserveUpdated(input, existing, createdAt),
  };
}
function normalizeForecast(input, existing, warnings, timestampFallback) {
  input = object(input);
  let createdAt = preserveCreated(input, existing, timestampFallback);
  return {
    id: idValue(input.id),
    period: canonicalPeriod(input.period, warnings),
    entity: text(input.entity, 120) || "Unspecified entity",
    lineItem: text(input.lineItem || input.account, 160) || "Unspecified line",
    amount: amountValue(input.amount),
    currency: text(input.currency, 12).toUpperCase() || "USD",
    scenario: text(input.scenario, 100) || "Latest estimate",
    assumption: text(input.assumption || input.notes),
    owner: text(input.owner, 100),
    status: enumValue(input.status, REVIEW_STATUSES, "draft"),
    confidence: numberValue(input.confidence, 0.5, 0, 1),
    source: text(input.source, 80) || "manual",
    evidenceRefs: references(input.evidenceRefs || input.sourceRefs || input.evidence),
    createdAt,
    updatedAt: preserveUpdated(input, existing, createdAt),
  };
}
function normalizeEvidence(input, existing, _warnings, timestampFallback) {
  input = object(input);
  let createdAt = preserveCreated(input, existing, timestampFallback);
  return {
    id: idValue(input.id),
    title: text(input.title || input.name, 180) || "Untitled evidence",
    sourceType: enumValue(input.sourceType || input.source, EVIDENCE_SOURCES, "manual"),
    sourceKey: text(input.sourceKey, 180),
    reference: text(input.reference || input.sourceRef || input.evidenceRef, 300),
    summary: text(input.summary || input.description, 1500),
    owner: text(input.owner, 100),
    confidence: numberValue(input.confidence, 0.5, 0, 1),
    tags: tags(input.tags || input.labels),
    createdAt,
    updatedAt: preserveUpdated(input, existing, createdAt),
  };
}
function normalizeSetup(input, definition) {
  input = object(input);
  return {
    ...definition,
    status: enumValue(input.status, SETUP_STATUSES, "unanswered"),
    answer: text(input.answer),
    evidenceRefs: references(input.evidenceRefs || input.evidence),
    owner: text(input.owner, 100),
    updatedAt: dateText(input.updatedAt) || nowIso(),
  };
}
function normalizeDisposition(input) {
  input = object(input);
  return {
    status: enumValue(input.status, DISPOSITIONS, "open"),
    owner: text(input.owner, 100),
    note: text(input.note),
    evidenceRefs: references(input.evidenceRefs || input.evidence),
    updatedAt: dateText(input.updatedAt) || nowIso(),
  };
}
function normalizeThresholds(input) {
  input = object(input);
  return {
    absolute: numberValue(input.absolute, 50000, 0, 1e15),
    percentage: numberValue(input.percentage, 10, 0, 1000),
    confidence: numberValue(input.confidence, 0.6, 0, 1),
    spikePercentage: numberValue(input.spikePercentage, 25, 0, 1000),
  };
}
function normalizeBatch(input) {
  input = object(input);
  return {
    id: idValue(input.id),
    sourceType: enumValue(input.sourceType, ["import", "google-sheet"], "import"),
    sourceName: text(input.sourceName, 180),
    sourceRef: text(input.sourceRef, 500),
    dataset: enumValue(input.dataset, DATASETS, "finance"),
    rowCount: numberValue(input.rowCount, 0, 0, MAX_RECORDS * 10),
    acceptedCount: numberValue(input.acceptedCount, 0, 0, MAX_RECORDS),
    duplicateCount: numberValue(input.duplicateCount, 0, 0, MAX_RECORDS * 10),
    truncatedCount: numberValue(input.truncatedCount, 0, 0, MAX_RECORDS * 10),
    controlTotals: Array.isArray(input.controlTotals)
      ? input.controlTotals.slice(0, 20).map((total) => ({
          currency: text(total?.currency, 12).toUpperCase(),
          ...Object.fromEntries(
            Object.entries(object(total))
              .filter(([key]) => key !== "currency")
              .slice(0, 8)
              .map(([key, value]) => [text(key, 40), numberValue(value, 0)]),
          ),
        }))
      : [],
    warnings: references(input.warnings, 20),
    status: enumValue(input.status, BATCH_STATUSES, "needs-review"),
    reviewer: text(input.reviewer, 100),
    note: text(input.note),
    evidenceRefs: references(input.evidenceRefs),
    createdAt: dateText(input.createdAt) || nowIso(),
    updatedAt: dateText(input.updatedAt) || nowIso(),
  };
}
function normalizeState(raw) {
  raw = object(raw);
  let timestampFallback = validTimestamp(raw.initializedAt) || validTimestamp(raw.updatedAt) || nowIso();
  let setupById = new Map(
    (Array.isArray(raw.setupItems) ? raw.setupItems : []).map((item) => [text(item?.id, 80), item]),
  );
  let dispositions = {};
  for (let [key, value] of Object.entries(object(raw.anomalyDispositions)).slice(
    0,
    MAX_RECORDS * 4,
  ))
    dispositions[text(key, 180)] = normalizeDisposition(value);
  let skippedSources = {};
  for (let source of SOURCE_DEFINITIONS)
    if (object(raw.skippedSources)[source.key] === true) skippedSources[source.key] = true;
  return {
    version: 2,
    financeRows: (Array.isArray(raw.financeRows) ? raw.financeRows : [])
      .slice(0, MAX_RECORDS)
      .map((row) => normalizeFinanceRow(row, undefined, undefined, timestampFallback)),
    contracts: (Array.isArray(raw.contracts) ? raw.contracts : [])
      .slice(0, MAX_RECORDS)
      .map((row) => normalizeContract(row, undefined, undefined, timestampFallback)),
    forecasts: (Array.isArray(raw.forecasts) ? raw.forecasts : [])
      .slice(0, MAX_RECORDS)
      .map((row) => normalizeForecast(row, undefined, undefined, timestampFallback)),
    evidenceItems: (Array.isArray(raw.evidenceItems) ? raw.evidenceItems : [])
      .slice(0, MAX_RECORDS)
      .map((row) => normalizeEvidence(row, undefined, undefined, timestampFallback)),
    importBatches: (Array.isArray(raw.importBatches) ? raw.importBatches : [])
      .slice(0, MAX_IMPORT_BATCHES)
      .map(normalizeBatch),
    setupItems: SETUP_DEFINITIONS.map((definition) =>
      normalizeSetup(setupById.get(definition.id), definition),
    ),
    thresholds: normalizeThresholds(raw.thresholds),
    anomalyDispositions: dispositions,
    skippedSources,
    initializedAt: validTimestamp(raw.initializedAt) || timestampFallback,
    updatedAt: validTimestamp(raw.updatedAt) || timestampFallback,
  };
}

function parseCsv(value) {
  let rows = [],
    row = [],
    field = "",
    quoted = false;
  for (let index = 0; index < value.length; index++) {
    let char = value[index];
    if (quoted) {
      if (char === '"' && value[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  row.push(field);
  rows.push(row);
  let filtered = rows.filter((cells) => cells.some((cell) => text(cell)));
  let [headers = [], ...body] = filtered;
  if (!headers.length) throw new Error("CSV must contain a header row.");
  return {
    headers,
    rows: body.map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
    ),
  };
}
function mapObject(dataset, input) {
  let output = {};
  let mapping = [];
  for (let [header, value] of Object.entries(object(input))) {
    let normalized = normalizeHeader(header);
    let field =
      DATASET_ALIASES[dataset][normalized] || COMMON_ALIASES[normalized] || camelHeader(header);
    output[field] = value;
    mapping.push({ header: text(header, 160), field });
  }
  return { output, mapping };
}
function prepareRecords(dataset, incoming, context) {
  let warnings = [];
  let mappings = new Map();
  let importedAt = nowIso();
  let normalize = {
    finance: normalizeFinanceRow,
    contracts: normalizeContract,
    forecasts: normalizeForecast,
    evidence: normalizeEvidence,
  }[dataset];
  let limitedIncoming = incoming.slice(0, MAX_IMPORT_RECORDS);
  let normalizedRecords = limitedIncoming.map((item, index) => {
    let mapped = mapObject(dataset, item);
    for (let entry of mapped.mapping) mappings.set(`${entry.header}\n${entry.field}`, entry);
    let raw = {
      ...mapped.output,
      source: context.sourceType === "google-sheet" ? "google-sheet" : "import",
      updatedAt: importedAt,
    };
    let rowNumber = context.rowNumbers?.[index] ?? index + 2;
    let sourceRef =
      context.sourceType === "google-sheet"
        ? `google-sheet:${context.spreadsheetId}:${context.spreadsheetTitle}:${context.canonicalRange}:row:${rowNumber}`
        : `import:${dataset}:row:${rowNumber}`;
    if (dataset === "evidence") {
      raw.sourceType = context.sourceType;
      raw.sourceKey ||=
        context.sourceType === "google-sheet"
          ? `${context.spreadsheetId}:${rowNumber}`
          : `import:${stableHash(JSON.stringify(mapped.output))}`;
      raw.reference ||= sourceRef;
    } else
      raw[dataset === "finance" ? "sourceRefs" : "evidenceRefs"] = [
        ...references(raw.sourceRefs || raw.evidenceRefs),
        sourceRef,
      ];
    if (context.sourceType === "google-sheet")
      raw.id = `google-sheet:${dataset}:${stableHash(`${context.spreadsheetId}\n${context.canonicalRange}\n${rowNumber}`)}`;
    else {
      if (DEMO_IDS.has(text(raw.id, 100))) delete raw.id;
      raw.id ||= `import:${dataset}:${stableHash(`${sourceRef}\n${JSON.stringify(mapped.output)}`)}`;
    }
    return normalize(raw, undefined, warnings);
  });
  let records = [...new Map(normalizedRecords.map((record) => [record.id, record])).values()];
  let duplicateCount = normalizedRecords.length - records.length;
  let limitTruncatedCount = incoming.length - limitedIncoming.length;
  return {
    records,
    duplicateCount,
    limitTruncatedCount,
    warnings: [
      ...new Set([
        ...warnings,
        ...(duplicateCount
          ? [`${duplicateCount} duplicate record ID(s) were collapsed; the last row was retained.`]
          : []),
      ]),
    ].slice(0, 20),
    mapping: [...mappings.values()],
  };
}
function controlTotals(dataset, records) {
  let fields = {
    finance: ["actual", "budget", "forecast"],
    contracts: ["annualValue"],
    forecasts: ["amount"],
    evidence: [],
  }[dataset];
  let totals = new Map();
  for (let record of records) {
    let currency = text(record.currency, 12).toUpperCase() || "N/A";
    let total = totals.get(currency) || { currency };
    for (let field of fields)
      if (record[field] !== null) total[field] = (total[field] || 0) + record[field];
    totals.set(currency, total);
  }
  return [...totals.values()].toSorted((a, b) => a.currency.localeCompare(b.currency));
}
function mergeRecords(state, collection, records, normalize) {
  let acceptedRecords = [];
  for (let record of records) {
    let index = state[collection].findIndex((item) => item.id === record.id);
    if (index >= 0) {
      state[collection][index] = normalize(record, state[collection][index]);
      acceptedRecords.push(state[collection][index]);
    } else if (state[collection].length < MAX_RECORDS) {
      state[collection].unshift(record);
      acceptedRecords.push(record);
    }
  }
  state[collection] = state[collection].slice(0, MAX_RECORDS);
  return { accepted: acceptedRecords.length, acceptedRecords };
}
function mergeDemo(current, demo, normalize) {
  let userRecords = current.filter((item) => !isDemo(item)).slice(0, MAX_RECORDS);
  let updatedAt = nowIso();
  return [
    ...demo
      .slice(0, MAX_RECORDS - userRecords.length)
      .map((item) => normalize({ ...item, updatedAt })),
    ...userRecords,
  ];
}
function variance(actual, baseline) {
  if (actual === null || baseline === null) return { amount: null, percent: null };
  let amount = actual - baseline;
  return { amount, percent: baseline === 0 ? null : (amount / Math.abs(baseline)) * 100 };
}
function material(result, thresholds) {
  return (
    result.amount !== null &&
    (Math.abs(result.amount) >= thresholds.absolute ||
      (result.percent !== null && Math.abs(result.percent) >= thresholds.percentage))
  );
}
function derivedFinance(rows, thresholds) {
  return rows.map((row) => ({
    ...row,
    budgetVariance: variance(row.actual, row.budget),
    forecastVariance: variance(row.actual, row.forecast),
    budgetMaterial: material(variance(row.actual, row.budget), thresholds),
    forecastMaterial: material(variance(row.actual, row.forecast), thresholds),
  }));
}
function candidate(id, kind, severity, title, detail, recordType, recordId, refs) {
  return {
    id,
    kind,
    severity,
    title,
    detail,
    recordType,
    recordId,
    evidenceRefs: references(refs),
  };
}
function deriveAnomalies(state, rows) {
  let items = [];
  for (let row of rows) {
    if (row.actual !== null && row.budget === null)
      items.push(
        candidate(
          `finance:${row.id}:missing-budget`,
          "missing-baseline",
          "high",
          "Missing budget",
          `${row.entity} / ${row.account} has actuals but no budget.`,
          "finance",
          row.id,
          row.sourceRefs,
        ),
      );
    if (row.actual !== null && row.forecast === null)
      items.push(
        candidate(
          `finance:${row.id}:missing-forecast`,
          "missing-baseline",
          "high",
          "Missing forecast",
          `${row.entity} / ${row.account} has actuals but no forecast.`,
          "finance",
          row.id,
          row.sourceRefs,
        ),
      );
    if (row.budgetMaterial)
      items.push(
        candidate(
          `finance:${row.id}:budget-material`,
          "material-variance",
          "high",
          "Material actual vs budget variance",
          `${row.entity} / ${row.account}: ${row.budgetVariance.amount.toFixed(2)} (${row.budgetVariance.percent === null ? "n/a" : row.budgetVariance.percent.toFixed(1) + "%"}).`,
          "finance",
          row.id,
          row.sourceRefs,
        ),
      );
    if (row.forecastMaterial)
      items.push(
        candidate(
          `finance:${row.id}:forecast-material`,
          "material-variance",
          "medium",
          "Material actual vs forecast variance",
          `${row.entity} / ${row.account}: ${row.forecastVariance.amount.toFixed(2)} (${row.forecastVariance.percent === null ? "n/a" : row.forecastVariance.percent.toFixed(1) + "%"}).`,
          "finance",
          row.id,
          row.sourceRefs,
        ),
      );
    let current = periodOrder(row.period);
    let prior = current
      ? rows
          .filter((other) => {
            let order = periodOrder(other.period);
            return (
              other.id !== row.id &&
              other.entity === row.entity &&
              other.account === row.account &&
              other.currency === row.currency &&
              other.actual !== null &&
              order?.grain === current.grain &&
              order.value < current.value
            );
          })
          .toSorted((a, b) => periodOrder(b.period).value - periodOrder(a.period).value)[0]
      : null;
    if (prior && row.actual !== null && prior.actual !== 0) {
      let change = ((row.actual - prior.actual) / Math.abs(prior.actual)) * 100;
      if (Math.abs(change) >= state.thresholds.spikePercentage)
        items.push(
          candidate(
            `finance:${row.id}:actual-spike`,
            "actual-spike-large-miss",
            "high",
            "Actual spike / large miss",
            `${row.account} changed ${change.toFixed(1)}% from ${prior.period}.`,
            "finance",
            row.id,
            [...row.sourceRefs, ...prior.sourceRefs],
          ),
        );
    }
  }
  for (let contract of state.contracts)
    if (contract.confidence < state.thresholds.confidence || !contract.evidenceRefs.length)
      items.push(
        candidate(
          `contract:${contract.id}:low-confidence`,
          "low-confidence-evidence",
          "medium",
          "Contract evidence needs review",
          `${contract.vendor} / ${contract.agreement} has ${(contract.confidence * 100).toFixed(0)}% confidence or missing evidence.`,
          "contract",
          contract.id,
          contract.evidenceRefs,
        ),
      );
  for (let forecast of state.forecasts)
    if (forecast.confidence < state.thresholds.confidence || !forecast.evidenceRefs.length)
      items.push(
        candidate(
          `forecast:${forecast.id}:low-confidence`,
          "low-confidence-evidence",
          "medium",
          "Forecast assumption needs evidence",
          `${forecast.entity} / ${forecast.lineItem} has ${(forecast.confidence * 100).toFixed(0)}% confidence or missing evidence.`,
          "forecast",
          forecast.id,
          forecast.evidenceRefs,
        ),
      );
  return items.slice(0, MAX_RECORDS * 4).map((item) => ({
    ...item,
    disposition: state.anomalyDispositions[item.id] || normalizeDisposition({}),
  }));
}
function derivePrepTasks(state, anomalies) {
  let tasks = [];
  for (let item of state.setupItems)
    if (item.status !== "answered")
      tasks.push({
        id: `setup:${item.id}`,
        workflow: "setup",
        severity: item.status === "blocked" ? "high" : "medium",
        title: item.label,
        detail: `${item.status}: ${item.question}`,
      });
  tasks.push({
    id: "source:netsuite",
    workflow: "sources",
    severity: "high",
    title: "NetSuite reconciliation unavailable",
    detail: "No certified NetSuite/system reconciliation route is implemented.",
  });
  for (let item of anomalies)
    if (!["explained", "accepted", "resolved"].includes(item.disposition.status))
      tasks.push({
        id: `anomaly:${item.id}`,
        workflow: "anomalies",
        severity: item.severity,
        title: item.title,
        detail: item.detail,
      });
  for (let batch of state.importBatches)
    if (batch.status !== "reconciled")
      tasks.push({
        id: `import:${batch.id}`,
        workflow: "imports",
        severity: batch.status === "blocked" ? "high" : "medium",
        title: `Review ${batch.sourceName || batch.dataset} import`,
        detail: `${batch.acceptedCount} accepted of ${batch.rowCount}; status ${batch.status}.`,
      });
  let missing =
    state.financeRows.filter((row) => !row.sourceRefs.length).length +
    state.contracts.filter((row) => !row.evidenceRefs.length).length +
    state.forecasts.filter((row) => !row.evidenceRefs.length).length;
  if (missing)
    tasks.push({
      id: "evidence:missing-records",
      workflow: "evidence",
      severity: "medium",
      title: "Records missing evidence",
      detail: `${missing} finance, contract, or forecast record(s) have no evidence reference.`,
    });
  return tasks.slice(0, 100);
}
function deriveBriefing(state, financeRows, anomalies, prepTasks, metrics) {
  let material = financeRows
    .filter((row) => row.budgetMaterial || row.forecastMaterial)
    .map((row) => ({
      id: row.id,
      period: row.period,
      entity: row.entity,
      account: row.account,
      currency: row.currency,
      budgetVariance: row.budgetVariance,
      forecastVariance: row.forecastVariance,
      evidenceRefs: row.sourceRefs,
    }))
    .toSorted(
      (a, b) =>
        Math.max(Math.abs(b.budgetVariance.amount || 0), Math.abs(b.forecastVariance.amount || 0)) -
        Math.max(Math.abs(a.budgetVariance.amount || 0), Math.abs(a.forecastVariance.amount || 0)),
    )
    .slice(0, 10);
  let contracts = state.contracts
    .filter((item) => item.status !== "resolved")
    .toSorted((a, b) => (a.renewalDate || "9999").localeCompare(b.renewalDate || "9999"))
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      vendor: item.vendor,
      agreement: item.agreement,
      renewalDate: item.renewalDate,
      annualValue: item.annualValue,
      currency: item.currency,
      status: item.status,
      evidenceRefs: item.evidenceRefs,
    }));
  let forecastRisks = state.forecasts
    .filter((item) => item.status !== "approved" || item.confidence < state.thresholds.confidence)
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      period: item.period,
      entity: item.entity,
      lineItem: item.lineItem,
      status: item.status,
      confidence: item.confidence,
      evidenceRefs: item.evidenceRefs,
    }));
  let openQuestions = state.setupItems
    .filter((item) => item.status !== "answered")
    .map((item) => ({ id: item.id, question: item.question, status: item.status }));
  let evidenceRefs = references(
    [
      ...material.flatMap((item) => item.evidenceRefs),
      ...contracts.flatMap((item) => item.evidenceRefs),
      ...forecastRisks.flatMap((item) => item.evidenceRefs),
    ],
    30,
  );
  let briefing = {
    label: "Draft / derived - not certified",
    generatedAt: nowIso(),
    metrics,
    topMaterialVariances: material,
    contractWatchlist: contracts,
    forecastRisks,
    openQuestions,
    prepTasks: prepTasks.slice(0, 30),
    evidenceRefs,
  };
  let lines = [
    `# Finance Operations Briefing`,
    ``,
    `**Draft / derived - not certified**`,
    ``,
    `Generated: ${briefing.generatedAt}`,
    ``,
    `## Metrics`,
    `- Finance rows: ${metrics.financeRows}`,
    `- Material variances: ${metrics.materialVariances}`,
    `- Open anomalies: ${metrics.openAnomalies}`,
    `- Import batches needing review: ${metrics.importBatchesNeedingReview}`,
    ``,
    `## Top material variances`,
    ...material.map(
      (item) =>
        `- ${item.period} | ${item.entity} | ${item.account} | ${item.currency} | budget variance ${item.budgetVariance.amount ?? "n/a"} | forecast variance ${item.forecastVariance.amount ?? "n/a"}`,
    ),
    ``,
    `## Contract watchlist`,
    ...contracts.map(
      (item) =>
        `- ${item.vendor} | ${item.agreement} | renewal ${item.renewalDate || "not captured"} | ${item.status}`,
    ),
    ``,
    `## Forecast risks`,
    ...forecastRisks.map(
      (item) =>
        `- ${item.period} | ${item.entity} | ${item.lineItem} | ${item.status} | confidence ${item.confidence}`,
    ),
    ``,
    `## Open questions`,
    ...openQuestions.map((item) => `- ${item.status}: ${item.question}`),
    ``,
    `## Prep tasks`,
    ...prepTasks
      .slice(0, 30)
      .map((item) => `- ${item.severity} | ${item.workflow} | ${item.title}: ${item.detail}`),
    ``,
    `## Evidence references`,
    ...evidenceRefs.map((ref) => `- ${ref}`),
  ];
  return { ...briefing, briefingMarkdown: lines.join("\n") };
}
function boundedA1(value) {
  let range = text(value, 160);
  let match =
    /^(?:(?:'[^'](?:[^']|'')*'|[A-Za-z0-9_. -]+)!)?\$?([A-Z]{1,3})\$?([1-9]\d{0,5}):\$?([A-Z]{1,3})\$?([1-9]\d{0,5})$/u.exec(
      range,
    );
  if (!match)
    throw new Error(
      "Enter a bounded A1 range such as 'Budget'!A1:H201; whole rows/columns are not allowed.",
    );
  let column = (letters) =>
    [...letters].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
  let startRow = Number(match[2]);
  let rows = Number(match[4]) - startRow + 1;
  let columns = column(match[3]) - column(match[1]) + 1;
  if (rows < 2 || rows > 201 || columns < 1 || columns > 50 || rows * columns > 10000)
    throw new Error(
      "Sheet range must include a header and at most 200 data rows, 50 columns, and 10,000 cells.",
    );
  return { range, startRow, rows, columns };
}
function sheetRows(values, startRow, columnCount) {
  values = values.map((row) => (Array.isArray(row) ? row.slice(0, columnCount) : row));
  let headerIndex = values.findIndex((row) => Array.isArray(row) && row.some((cell) => text(cell)));
  if (headerIndex < 0) throw new Error("The selected Sheet range has no nonempty header row.");
  let headers = values[headerIndex].map((cell) => text(cell, 160));
  if (!headers.some(Boolean)) throw new Error("The selected Sheet range has no usable headers.");
  let rows = values
    .slice(headerIndex + 1)
    .filter((row) => Array.isArray(row) && row.some((cell) => text(cell)))
    .map((cells) =>
      Object.fromEntries(
        headers.map((header, index) => [header || `column_${index + 1}`, cells[index] ?? ""]),
      ),
    );
  let rowNumbers = values
    .slice(headerIndex + 1)
    .map((row, index) => ({ row, number: startRow + headerIndex + index + 1 }))
    .filter(({ row }) => Array.isArray(row) && row.some((cell) => text(cell)))
    .map(({ number }) => number);
  return { rows, rowNumbers };
}

export class Gadget extends DurableObject {
  async #read() {
    let stored = await this.ctx.storage.get(STORAGE_KEY);
    if (stored) return normalizeState(stored);
    let initial = normalizeState({
      financeRows: DEMO_FINANCE_ROWS,
      contracts: DEMO_CONTRACTS,
      forecasts: DEMO_FORECASTS,
      evidenceItems: DEMO_EVIDENCE,
      initializedAt: nowIso(),
    });
    await this.ctx.storage.put(STORAGE_KEY, initial);
    return initial;
  }
  async #write(state) {
    state = normalizeState({ ...state, updatedAt: nowIso() });
    await this.ctx.storage.put(STORAGE_KEY, state);
    return state;
  }
  #source(state, key) {
    if (state.skippedSources[key])
      throw new Error(`${key} is skipped. Re-enable it before an explicit read.`);
    let bound = this.env?.[key];
    if (!bound)
      throw new Error(`${key} is not connected. Wire the scoped source in Connections first.`);
    return bound;
  }
  #sources(state) {
    return SOURCE_DEFINITIONS.map((source) => {
      let bound = !!this.env?.[source.key];
      if (state.skippedSources[source.key])
        return {
          ...source,
          status: "skipped",
          bound,
          instruction: "Skipped for this workspace. Explicit reads are blocked until re-enabled.",
        };
      if (source.key === "NETSUITE_ROUTE")
        return {
          ...source,
          status: "unavailable",
          bound,
          instruction: "No certified NetSuite sync or system reconciliation exists.",
        };
      return {
        ...source,
        status: bound ? "connected-not-read" : "missing",
        bound,
        instruction: bound
          ? "Binding detected by presence only. Use an explicit read action to capture bounded data."
          : `Optional. Wire ${source.key} in Connections if approved.`,
      };
    });
  }
  async getState() {
    let state = await this.#read();
    let financeRows = derivedFinance(state.financeRows, state.thresholds);
    let anomalies = deriveAnomalies(state, financeRows);
    let answered = state.setupItems.filter((item) => item.status === "answered").length;
    let blocked = state.setupItems.filter(
      (item) => item.status === "blocked" || item.status === "needs-artifact",
    ).length;
    let openAnomalies = anomalies.filter(
      (item) => !["explained", "accepted", "resolved"].includes(item.disposition.status),
    ).length;
    let prepTasks = derivePrepTasks(state, anomalies);
    let readiness = {
      answered,
      total: state.setupItems.length,
      blocked,
      complete: false,
      label: "Draft / derived - not certified",
      blockers: prepTasks.map((task) => task.title).slice(0, 30),
    };
    let metrics = {
      financeRows: financeRows.length,
      materialVariances: financeRows.filter((row) => row.budgetMaterial || row.forecastMaterial)
        .length,
      contracts: state.contracts.length,
      forecasts: state.forecasts.length,
      evidenceItems: state.evidenceItems.length,
      importBatches: state.importBatches.length,
      importBatchesNeedingReview: state.importBatches.filter(
        (batch) => batch.status !== "reconciled",
      ).length,
      anomalyCandidates: anomalies.length,
      openAnomalies,
      setupPercent: Math.round((answered / state.setupItems.length) * 100),
    };
    let briefing = deriveBriefing(state, financeRows, anomalies, prepTasks, metrics);
    return {
      ...state,
      financeRows,
      anomalies,
      readiness,
      metrics,
      prepTasks,
      briefing,
      briefingMarkdown: briefing.briefingMarkdown,
      sources: this.#sources(state),
    };
  }
  async #save(collection, input, normalize) {
    let state = await this.#read();
    let existing = state[collection].find((item) => item.id === text(input?.id, 100));
    let record = normalize({ ...object(input), updatedAt: nowIso() }, existing);
    let index = state[collection].findIndex((item) => item.id === record.id);
    if (index >= 0) state[collection][index] = record;
    else state[collection].unshift(record);
    state[collection] = state[collection].slice(0, MAX_RECORDS);
    await this.#write(state);
    return this.getState();
  }
  async #delete(collection, id) {
    let state = await this.#read();
    state[collection] = state[collection].filter((item) => item.id !== text(id, 100));
    await this.#write(state);
    return this.getState();
  }
  async saveFinanceRow(input) {
    return this.#save("financeRows", input, normalizeFinanceRow);
  }
  async deleteFinanceRow(id) {
    return this.#delete("financeRows", id);
  }
  async saveContractFinding(input) {
    return this.#save("contracts", input, normalizeContract);
  }
  async deleteContractFinding(id) {
    return this.#delete("contracts", id);
  }
  async saveForecastRecord(input) {
    return this.#save("forecasts", input, normalizeForecast);
  }
  async deleteForecastRecord(id) {
    return this.#delete("forecasts", id);
  }
  async saveEvidenceItem(input) {
    return this.#save("evidenceItems", input, normalizeEvidence);
  }
  async deleteEvidenceItem(id) {
    return this.#delete("evidenceItems", id);
  }
  async updateSetupItem(id, input) {
    let state = await this.#read();
    let index = state.setupItems.findIndex((item) => item.id === text(id, 80));
    if (index < 0) throw new Error("Unknown setup item.");
    state.setupItems[index] = normalizeSetup(input, SETUP_DEFINITIONS[index]);
    if (state.setupItems[index].id === "materiality")
      state.thresholds = normalizeThresholds({ ...state.thresholds, ...object(input).thresholds });
    await this.#write(state);
    return this.getState();
  }
  async updateAnomalyDisposition(id, input) {
    let state = await this.#read();
    let key = text(id, 180);
    let validIds = new Set(
      deriveAnomalies(state, derivedFinance(state.financeRows, state.thresholds)).map(
        (item) => item.id,
      ),
    );
    if (!validIds.has(key)) throw new Error("Unknown anomaly candidate.");
    state.anomalyDispositions[key] = normalizeDisposition(input);
    await this.#write(state);
    return this.getState();
  }
  async setSourceSkipped(key, skipped) {
    let state = await this.#read();
    if (!SOURCE_DEFINITIONS.some((source) => source.key === key))
      throw new Error("Unknown optional source.");
    if (skipped === true) state.skippedSources[key] = true;
    else delete state.skippedSources[key];
    await this.#write(state);
    return this.getState();
  }
  async #commitImport(state, dataset, prepared, batchInput) {
    let config = {
      finance: ["financeRows", normalizeFinanceRow],
      contracts: ["contracts", normalizeContract],
      forecasts: ["forecasts", normalizeForecast],
      evidence: ["evidenceItems", normalizeEvidence],
    }[dataset];
    let merged = mergeRecords(state, config[0], prepared.records, config[1]);
    let capacityTruncatedCount = prepared.records.length - merged.accepted;
    let truncatedCount = prepared.limitTruncatedCount + capacityTruncatedCount;
    let batch = normalizeBatch({
      ...batchInput,
      dataset,
      rowCount: batchInput.rowCount,
      acceptedCount: merged.accepted,
      duplicateCount: prepared.duplicateCount,
      truncatedCount,
      controlTotals: controlTotals(dataset, merged.acceptedRecords),
      warnings: [
        ...prepared.warnings,
        ...(prepared.limitTruncatedCount
          ? ["Rows beyond the 200-record import limit were not imported."]
          : []),
        ...(capacityTruncatedCount
          ? [
              `${capacityTruncatedCount} record(s) were not imported because the dataset is at capacity.`,
            ]
          : []),
      ],
      status: "needs-review",
    });
    state.importBatches.unshift(batch);
    state.importBatches = state.importBatches.slice(0, MAX_IMPORT_BATCHES);
    await this.#write(state);
    return {
      state: await this.getState(),
      imported: merged.accepted,
      truncated: truncatedCount > 0,
      batch,
    };
  }
  async importDataset(dataset, value, format = "json") {
    if (!DATASETS.includes(dataset))
      throw new Error("Choose finance, contracts, forecasts, or evidence.");
    value = String(value ?? "");
    if (value.length > MAX_INPUT_TEXT) throw new Error("Import text must be 256 KiB or smaller.");
    let parsed;
    let incoming;
    if (format === "csv") {
      parsed = parseCsv(value);
      incoming = parsed.rows;
    } else {
      parsed = JSON.parse(value);
      incoming = Array.isArray(parsed) ? parsed : parsed?.records;
    }
    if (!Array.isArray(incoming))
      throw new Error("Import must be an array or an object with a records array.");
    let prepared = prepareRecords(dataset, incoming, { sourceType: "import" });
    let state = await this.#read();
    return this.#commitImport(state, dataset, prepared, {
      sourceType: "import",
      sourceName: `Pasted ${format.toUpperCase()}`,
      sourceRef: `pasted:${format}`,
      rowCount: incoming.length,
    });
  }
  async updateImportBatchReview(id, input) {
    let state = await this.#read();
    let index = state.importBatches.findIndex((batch) => batch.id === text(id, 100));
    if (index < 0) throw new Error("Unknown import batch.");
    let current = state.importBatches[index];
    state.importBatches[index] = normalizeBatch({
      ...current,
      status: object(input).status,
      reviewer: object(input).reviewer,
      note: object(input).note,
      evidenceRefs: object(input).evidenceRefs,
      updatedAt: nowIso(),
    });
    await this.#write(state);
    return this.getState();
  }
  async #readSheet(input) {
    input = object(input);
    let dataset = enumValue(input.dataset, DATASETS, "");
    if (!dataset) throw new Error("Choose finance, contracts, forecasts, or evidence.");
    let boundedRange = boundedA1(input.range);
    let range = boundedRange.range;
    let valueMode = enumValue(input.valueMode, ["formatted", "raw", "formula"], "formatted");
    let state = await this.#read();
    let sheet = this.#source(state, "GOOGLE_SHEET");
    let [spreadsheet, result] = await Promise.all([
      sheet.getSpreadsheet(),
      sheet.readRange(range, { valueMode }),
    ]);
    let canonicalRange = range;
    let extracted = sheetRows(
      Array.isArray(result?.values) ? result.values.slice(0, boundedRange.rows) : [],
      boundedRange.startRow,
      boundedRange.columns,
    );
    let prepared = prepareRecords(dataset, extracted.rows, {
      sourceType: "google-sheet",
      spreadsheetId: text(spreadsheet?.id, 180),
      spreadsheetTitle: text(spreadsheet?.title, 180),
      canonicalRange,
      rowNumbers: extracted.rowNumbers,
    });
    return {
      dataset,
      valueMode,
      spreadsheetId: text(spreadsheet?.id, 180),
      spreadsheetTitle: text(spreadsheet?.title, 180),
      canonicalRange,
      rowCount: extracted.rows.length,
      prepared,
    };
  }
  async previewGoogleSheetRange(input) {
    let result = await this.#readSheet(input);
    return {
      dataset: result.dataset,
      valueMode: result.valueMode,
      spreadsheetId: result.spreadsheetId,
      spreadsheetTitle: result.spreadsheetTitle,
      canonicalRange: result.canonicalRange,
      rowCount: result.rowCount,
      records: result.prepared.records.slice(0, 10),
      mapping: result.prepared.mapping,
      warnings: result.prepared.warnings,
      controlTotals: controlTotals(result.dataset, result.prepared.records),
    };
  }
  async importGoogleSheetRange(input) {
    let result = await this.#readSheet(input);
    let state = await this.#read();
    return this.#commitImport(state, result.dataset, result.prepared, {
      sourceType: "google-sheet",
      sourceName: result.spreadsheetTitle,
      sourceRef: `google-sheet:${result.spreadsheetId}:${result.spreadsheetTitle}:${result.canonicalRange}`,
      rowCount: result.rowCount,
    });
  }
  async captureGoogleDocEvidence() {
    let state = await this.#read();
    let doc = this.#source(state, "GOOGLE_DOC");
    let [metadata, content] = await Promise.all([doc.getMetadata(), doc.getContent()]);
    let modified =
      metadata?.lastModified instanceof Date
        ? metadata.lastModified.toISOString()
        : dateText(metadata?.lastModified);
    let reference = `google-doc:${text(metadata?.title, 180)}:modified:${modified || "unknown"}`;
    let item = normalizeEvidence({
      id: `google-doc:${stableHash(reference)}`,
      title: metadata?.title || "Google Doc",
      sourceType: "google-doc",
      sourceKey: reference,
      reference,
      summary: text(content, 1500),
      confidence: 0.5,
      tags: ["google-doc", "captured-excerpt"],
      updatedAt: nowIso(),
    });
    mergeRecords(state, "evidenceItems", [item], normalizeEvidence);
    await this.#write(state);
    return { state: await this.getState(), captured: 1, evidence: item };
  }
  async captureGmailEvidence() {
    let state = await this.#read();
    let gmail = this.#source(state, "GMAIL_SEARCH");
    let cursor;
    let entries = [];
    try {
      cursor = await gmail.listThreads();
      while (entries.length < 20) {
        let page = await cursor.next();
        if (!Array.isArray(page) || !page.length) break;
        let remaining = 20 - entries.length;
        entries.push(...page.slice(0, remaining));
        for (let entry of page.slice(remaining)) entry?.thread?.[Symbol.dispose]?.();
      }
    } finally {
      cursor?.[Symbol.dispose]?.();
      for (let entry of entries) entry?.thread?.[Symbol.dispose]?.();
    }
    let updatedAt = nowIso();
    let items = entries.map((entry) => {
      let info = object(entry?.info);
      return normalizeEvidence({
        id: `gmail:${text(info.id, 160) || stableHash(JSON.stringify(info))}`,
        title: info.subject || "Gmail thread",
        sourceType: "gmail",
        sourceKey: info.id,
        reference: `gmail-thread:${text(info.id, 180)}`,
        summary: info.snippet,
        confidence: 0.5,
        tags: ["gmail", "metadata-only"],
        updatedAt,
      });
    });
    let { accepted } = mergeRecords(state, "evidenceItems", items, normalizeEvidence);
    await this.#write(state);
    return { state: await this.getState(), captured: accepted };
  }
  async generateForecastBaselines(input) {
    input = object(input);
    let warnings = [];
    let targetPeriod = canonicalPeriod(input.targetPeriod, warnings);
    if (!periodOrder(targetPeriod) || warnings.length)
      throw new Error("Target period must be canonical YYYY-MM or YYYY-Qn.");
    let lookbackPeriods = numberValue(input.lookbackPeriods, null, 1, 12);
    if (!Number.isInteger(lookbackPeriods))
      throw new Error("Lookback periods must be an integer from 1 to 12.");
    let targetOrder = periodOrder(targetPeriod);
    let state = await this.#read();
    let groups = new Map();
    for (let row of state.financeRows) {
      let order = periodOrder(row.period);
      if (
        !order ||
        order.grain !== targetOrder.grain ||
        order.value >= targetOrder.value ||
        row.actual === null
      )
        continue;
      let key = `${row.entity}\n${row.account}\n${row.currency}`;
      let group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    let generated = 0,
      skipped = 0;
    for (let rows of groups.values()) {
      let history = rows
        .toSorted((a, b) => periodOrder(b.period).value - periodOrder(a.period).value)
        .slice(0, lookbackPeriods);
      if (!history.length) {
        skipped++;
        continue;
      }
      let sample = history[0];
      let id = `derived-baseline:${stableHash(`${targetPeriod}\n${sample.entity}\n${sample.account}\n${sample.currency}`)}`;
      let matching = state.forecasts.filter(
        (item) =>
          item.period === targetPeriod &&
          item.entity === sample.entity &&
          item.lineItem === sample.account &&
          item.currency === sample.currency,
      );
      if (matching.some((item) => item.status === "approved")) {
        skipped++;
        continue;
      }
      let existing = state.forecasts.find((item) => item.id === id);
      let amount = history.reduce((sum, row) => sum + row.actual, 0) / history.length;
      let record = normalizeForecast(
        {
          id,
          period: targetPeriod,
          entity: sample.entity,
          lineItem: sample.account,
          amount,
          currency: sample.currency,
          scenario: "Deterministic baseline",
          assumption: `Simple average of ${history.length} latest canonical historical period(s) before ${targetPeriod}: ${history.map((row) => row.period).join(", ")}.`,
          owner: existing?.owner || "",
          status: "draft",
          confidence: Math.min(0.9, (history.length / lookbackPeriods) * 0.8),
          source: "derived-baseline",
          evidenceRefs: history.flatMap((row) => row.sourceRefs),
          updatedAt: nowIso(),
        },
        existing,
      );
      let index = state.forecasts.findIndex((item) => item.id === record.id);
      if (index >= 0) state.forecasts[index] = record;
      else state.forecasts.unshift(record);
      generated++;
    }
    state.forecasts = state.forecasts.slice(0, MAX_RECORDS);
    await this.#write(state);
    return { state: await this.getState(), generated, skipped };
  }
  async refreshDemoData() {
    let state = await this.#read();
    state.financeRows = mergeDemo(state.financeRows, DEMO_FINANCE_ROWS, normalizeFinanceRow);
    state.contracts = mergeDemo(state.contracts, DEMO_CONTRACTS, normalizeContract);
    state.forecasts = mergeDemo(state.forecasts, DEMO_FORECASTS, normalizeForecast);
    state.evidenceItems = mergeDemo(state.evidenceItems, DEMO_EVIDENCE, normalizeEvidence);
    await this.#write(state);
    return this.getState();
  }
  async destructiveResetToDemo() {
    let state = normalizeState({
      financeRows: DEMO_FINANCE_ROWS,
      contracts: DEMO_CONTRACTS,
      forecasts: DEMO_FORECASTS,
      evidenceItems: DEMO_EVIDENCE,
      importBatches: [],
      setupItems: [],
      anomalyDispositions: {},
      skippedSources: {},
      initializedAt: nowIso(),
    });
    await this.#write(state);
    return this.getState();
  }
}
