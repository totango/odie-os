# Finance Operations Workbench

An offline-first CFO and FP&A preparation surface for bounded working data, evidence, import review,
variance analysis, contracts, and deterministic forecasts. It is not an accounting system, a
reconciliation engine, or a certified source of truth. The trust label is always **Draft / derived -
not certified**, including when an import batch is marked `reconciled`.

## Workflows

1. **Setup:** nine controlled questions retain fiscal calendar, entity, currency, materiality,
   authoritative-source, package, scope, approval, and historical-readiness unknowns.
2. **Variance review:** actual versus budget/forecast calculations remain deterministic and
   currency-specific. Materiality, missing baselines, and historical spikes create review candidates.
3. **Contract watch:** bounded manual/imported findings retain dates, values, confidence, owner, and
   evidence references. The workbench does not perform legal interpretation.
4. **Forecast review:** manual/imported forecasts coexist with deterministic historical-average
   baselines. Baseline generation updates only its deterministic derived record, never a matching
   manual/imported draft or in-review forecast, and skips a dimension with any approved forecast.
5. **Evidence register:** at most 300 normalized evidence items retain title, source type/key,
   reference, bounded summary, owner, confidence, tags, and timestamps. Demo evidence is useful but
   synthetic. User values are normalized server-side and escaped before client rendering.
6. **Import review:** the latest 50 import summaries retain source, dataset, counts, truncation,
   per-currency control totals, warnings, review status, reviewer, note, and evidence references.
7. **Briefing:** derived metrics, material variances, contract watch items, forecast risks, open
   setup questions, prep tasks, and evidence references are rendered and available as safe clipboard
   Markdown. No narrative claim is invented.

Prep tasks are derived on each `getState()` and are not persisted. They cover incomplete/blocked
setup, unavailable NetSuite, open anomalies, imports needing review, and records without evidence.

## Bounded state and lifecycle

`server.js` stores one versioned Durable Object record at `finance-operations-workbench:v1` (the key
is retained so revision 1 workspaces migrate in place). State normalization upgrades it to version 2.
Finance rows, contracts, forecasts, and evidence are each capped at 300; imports accept at most 200
records and 256 KiB; import history retains 50 summaries and never raw files. Strings, numbers,
enums, references, tags, review metadata, and persisted collections are bounded on every read/write.

Demo refresh replaces known demo identities only when capacity permits and preserves manual,
imported, and derived records. Imported use of a reserved demo ID receives a non-demo identity.
Destructive reset deliberately removes working records, setup, dispositions, batches, and source
choices before reinstalling demo records and evidence.

## CSV, JSON, and mapping

Pasted JSON accepts an array or `{ "records": [...] }`. CSV uses the first nonempty row as headers,
supports quoted fields, and rejects an unterminated quoted field before state is read or written.
Malformed JSON/CSV creates no records and no batch. Duplicate stable IDs use the last normalized
record and are reported separately from safety/capacity truncation. Control totals cover only
accepted records. Imports include deterministic row lineage; Sheet identities also include spreadsheet and
range lineage so rerunning the same source range upserts instead of appending copies.

Common headings are mapped deterministically, including:

- fiscal/posting period;
- subsidiary, legal entity, and business unit;
- GL account and line item;
- actual/actual amount, approved budget, forecast/latest estimate;
- currency/currency code, owner, notes, source refs, and evidence refs;
- contract title/name, supplier, annual contract value, renewal date, and notice days;
- forecast assumptions and review status;
- evidence title, source type/key/reference, description/summary, and tags.

Finance amounts accept numeric values, grouping commas, common currency symbols, parenthesized
negatives, and `k`/`K` or `m`/`M` suffixes. Blank values remain `null`; percentage strings are never
silently treated as amounts. Periods such as `2026/07`, `Jul 2026`, and `Q3 2026` normalize to
`2026-07` and `2026-Q3`. Unknown labels are retained verbatim and recorded as batch warnings. The
workbench never infers fiscal-calendar meaning from a period label.

Control totals sum the dataset's numeric finance fields by currency: actual/budget/forecast,
contract annual value, or forecast amount. Currencies are never converted or combined. `reconciled`
means a reviewer completed this workbench's import review; it does not assert NetSuite, bank,
subledger, or system-of-record reconciliation and never changes the global trust label.

## Explicit Google Sheet reads

`getState()` and page load inspect binding presence only and make zero source calls. A user must
explicitly invoke Preview or Import with a rectangular A1 range. Whole rows, whole columns, named or
unbounded ranges are rejected locally. Ranges are limited to a header plus 200 data rows, 50 columns,
and 10,000 cells. Value mode is explicitly `formatted`, `raw`, or `formula`.

Preview calls `getSpreadsheet()` and `readRange()` only after validation, treats the first nonempty
row as headers, hard-caps every returned row to the requested range width before mapping, applies the same mapper/import normalizers, returns at most 10 mapped records plus
canonical range, spreadsheet ID/title, mappings, warnings, and control totals, and persists nothing.
Import repeats that exact bounded read/mapping path, imports at most 200 rows, creates an import batch,
and adds a precise reference containing spreadsheet ID, title, canonical range, and source row.
There is no Sheet polling, automatic sync, or writeback.

## Explicit evidence capture

- **Google Doc:** `captureGoogleDocEvidence()` calls `getMetadata()` and `getContent()` only after an
  explicit click. It stores one evidence item with title, modified/reference information, and at most
  1,500 characters of content as a captured excerpt. It does not claim page-level citations,
  completeness, interpretation, or legal/accounting meaning.
- **Scoped Gmail:** `captureGmailEvidence()` uses only `listThreads()` on the already connected
  `GMAIL_SEARCH` scope. It consumes at most 20 entries, stores thread ID/subject/snippet metadata,
  never reads messages or bodies, never performs a broader search, and never sends mail. The cursor
  and every returned thread capability are disposed in `finally`/bounded cleanup paths.

The Evidence UI shows explicit-read warnings and capture buttons only while the corresponding source
is `connected-not-read`. Missing bindings produce a clear error. Skipped sources are checked before
the capability is touched, so explicit actions make zero calls until the source is re-enabled.

## Deterministic forecast baseline

`generateForecastBaselines({targetPeriod, lookbackPeriods})` requires canonical `YYYY-MM` or
`YYYY-Qn` and an integer lookback from 1 through 12. It groups historical finance rows by exact
entity, account, and currency; selects the latest N canonical periods before the target with a
non-null actual; and writes a draft `derived-baseline` forecast equal to their simple arithmetic
average. Its assumption lists the exact method and contributing periods. Confidence is a bounded,
explicitly heuristic function of available history count only. Source refs are the union of the
contributing rows. It is reproducible, performs no ML, updates only its exact `derived-baseline:*`
identity, and skips a dimension when any matching forecast is approved.

## Deterministic calculations

- Variance amount is `actual - baseline` independently for budget and forecast.
- Variance percent is `variance / abs(baseline) * 100`; zero/missing baselines have no percentage.
- Materiality is reached when the configured absolute or percentage threshold is reached.
- Historical spikes use the latest earlier canonical period with matching entity, account, currency,
  and period grain. Unknown period text cannot create a misleading comparison.
- Low-confidence or unreferenced contract/forecast records and missing finance baselines remain
  explicit candidates for human disposition.

## Source states and remaining CFO blockers

Presence-only source states are `connected-not-read`, `missing`, `skipped`, and `unavailable`.
Skipping is a persisted privacy decision, not presentation state. `NETSUITE_ROUTE` remains
`unavailable` even if a placeholder binding exists because no certified integration is implemented.

The precise blockers beyond this pre-CFO increment are:

- no authoritative NetSuite GL/subledger/budget/forecast connector, extraction contract, or immutable
  system lineage;
- no entity/chart-of-accounts/fiscal-calendar master-data mapping approved by Finance;
- no opening/closing balance, journal, intercompany, elimination, FX, bank, or subledger tie-out;
- no automated control evidence, segregation-of-duties enforcement, approval workflow, close lock,
  audit trail export, or designated certifier signature;
- no contract-page extraction/citation verification and no email-body review;
- no external writes, Sheet writeback, journal posting, payment action, scheduling, or ML forecast;
- no policy deciding which import-batch reviewer/status constitutes an organization-approved control.

Until those controls and authoritative systems are implemented and independently validated, every
briefing, batch, variance, anomaly, forecast, and evidence item remains working material labeled
**Draft / derived - not certified**.
