# Native Finance Operations / FP&A Product Plan

Status: Parked for a net-new discovery and implementation task.

## Objective

Build a native finance workspace that can replace the highest-value Aleph workflows without
trying to reproduce the full product initially. NetSuite remains the accounting system of record;
the workspace owns governed analysis, planning versions, scenarios, reporting, citations, and
advisory ML.

## Product Thesis

- Connect NetSuite, Google Drive, email, and finance workbooks.
- Answer finance questions with source-record, document-page, and spreadsheet-cell citations.
- Calculate metrics and variances deterministically; use the LLM for retrieval, explanation, and
  workflow orchestration.
- Support budgets, forecasts, assumptions, and scenario versions in a governed planning store.
- Add forecasting and anomaly models only after the finance data model is reliable.
- Require human approval before external writes, email sends, or changes to approved plans.

## First Product Wedge

Deliver a Finance Answers and Variance Assistant for three workflows:

1. Contract intelligence: find payment, renewal, termination, pricing, and commitment terms with
   page-level citations.
2. Monthly reporting: reconcile NetSuite actuals against an approved budget or forecast and draft
   supported variance commentary.
3. Forecast and anomaly review: identify likely budget misses and material unusual activity with
   confidence ranges and source drill-down.

Initial non-goals:

- Full Aleph feature parity.
- A general-purpose BI or spreadsheet product.
- Broad connector coverage.
- Autonomous accounting decisions or NetSuite writes.
- Complex collaborative budgeting, allocations, or headcount planning.

## System Boundaries

| Component | Responsibility |
| --- | --- |
| NetSuite | Ledger and accounting system of record |
| Finance domain service | Certified metrics, dimensions, periods, and permissions |
| Planning service | Budgets, forecasts, scenarios, assumptions, overrides, and locks |
| Reporting service | Variances, recurring reports, commentary, and citations |
| Odie agent | Retrieval, tool orchestration, explanation, and report drafting |
| Spreadsheet client | Finance-native input and presentation, not authoritative storage |
| ML service | Advisory forecasts, anomalies, collections risk, and model explanations |
| Approval/audit layer | Reviews, write authorization, lineage, and immutable history |

Agents and sandboxed code must receive narrow finance capabilities rather than raw database or
NetSuite credentials.

## Candidate Open-Source Stack

There is no complete open-source Aleph replacement. Use components for commodity infrastructure
and build the FP&A domain kernel.

| Layer | Candidate |
| --- | --- |
| Planning and audit storage | PostgreSQL |
| Analytical snapshots and feature preparation | DuckDB |
| NetSuite ingestion | Meltano plus a maintained tap, custom SuiteTalk/SuiteQL, or Airbyte if its ELv2 license is acceptable |
| Transformations | dbt Core |
| Semantic query infrastructure | Wren, Cube, or MetricFlow behind authoritative finance metric definitions |
| Web planning grid | Univer (Apache 2.0) |
| Excel integration | Office.js add-in, deferred until the web workflow is validated |
| Reporting | Narrow native report blocks; optionally Evidence, Lightdash, or Superset for prototypes |
| Forecasting | StatsForecast |
| Tabular AutoML | AutoGluon |
| Model registry | MLflow or a smaller native registry |

Custom work is required for NetSuite mappings, certified finance metrics, scenario/version
semantics, formulas and allocations, permissions, citations, approvals, and writeback safety.

## Minimal Domain Model

- Organization, legal entity, account, fiscal period.
- Dimensions and hierarchical members such as department, product, customer, vendor, and location.
- Immutable actual facts with NetSuite record and import-batch lineage.
- Budget, forecast, and scenario versions with draft, submitted, approved, locked, and archived
  states.
- Plan facts, assumptions, driver formulas, manual overrides, and allocation results.
- Certified metrics and reusable report definitions.
- Citations, approval requests, writeback proposals, and append-only audit events.

## Safe Agent Capabilities

Read operations:

- Describe the certified finance model.
- Query a metric by period, version, and dimensions.
- Calculate and explain a variance.
- Retrieve source citations.
- Compare scenarios or forecast versions.
- Search contracts and supporting evidence.

Approval-controlled operations:

- Create a scenario.
- Update an assumption or draft plan.
- Submit or approve a version.
- Propose spreadsheet or NetSuite writeback.

## Delivery Phases

### Phase 0: Discovery (2-3 weeks)

- Observe the Aleph trial and current monthly reporting process.
- Collect the ten most common finance questions.
- Inventory NetSuite objects, dimensions, workbooks, and authoritative Drive folders.
- Select one real monthly report as the acceptance test.
- Define certified metrics, permissions, materiality, and reconciliation requirements.

### Phase 1: Actuals and Reporting (6-8 weeks)

- Read-only NetSuite synchronization.
- Normalized actuals and dimension mappings.
- Reconciliation and freshness checks.
- Certified P&L metrics and read-only agent tools.
- Actual-versus-budget reporting, drill-down, citations, and audit events.

### Phase 2: Budgets and Scenarios (8-10 weeks)

- Excel budget import.
- Budget and forecast versions.
- Basic planning grid, assumptions, overrides, branch/copy, compare, and lock.
- Deterministic rollups, variances, currency conversion, and simple driver formulas.

### Phase 3: Recurring Reporting (6-8 weeks)

- Saved monthly report packages and refresh workflows.
- Commentary review and source evidence.
- Department-scoped access and stakeholder sharing.
- Excel/PDF/slide exports.

### Phase 4: Native ML (6-10 weeks)

- Seasonal-naive and statistical forecast baselines.
- Rolling historical backtests, prediction intervals, and model registry.
- Material anomaly ranking and finance-user feedback.
- LLM explanations grounded in model outputs and source records.

### Phase 5: Excel and Writeback

- Office.js add-in for certified pulls, planning updates, and citation drill-down.
- Dry-run diffs, approvals, idempotent execution, and reconciliation for any external writeback.

A useful actuals/variance MVP is approximately 3-4 months with a focused team. Planning,
spreadsheet integration, governed ML, and safe writeback make this an 8-12 month product effort.
Broad Aleph parity would be a separate 18-36 month product-line decision.

## CFO Discovery Questions

1. What are the three most time-consuming monthly finance workflows?
2. What questions do executives and budget owners repeatedly ask finance?
3. Which Aleph features or workflows appear most valuable during the trial?
4. Where do the authoritative budget and forecast currently live?
5. Which NetSuite records and dimensions are required first?
6. Which recurring report should be the first acceptance test?
7. Can finance provide sanitized examples of its report package and forecast workbook?
8. Which parts of forecasting and reporting are most manual today?
9. What must an Excel integration pull, calculate, explain, or submit?
10. Which predictive capability matters most: revenue, expense, cash, collections, anomalies, or
    scenarios?
11. How much usable historical data is available?
12. Which actions must remain read-only or require controller/CFO approval?
13. Who may see company-wide data versus department-scoped data?
14. What citations and calculation details are required to trust an answer?
15. What measurable result would make the first release successful?

Requested artifacts:

- One representative monthly reporting package.
- Its associated budget or forecast workbook.
- The ten most common finance questions.
- One difficult reconciliation or variance investigation.
- Notes from the Aleph trial on valuable and unnecessary functionality.

## Decision Gates

- Build native connectors only when a few sources cover most target workflows; buy connector
  breadth otherwise.
- Build the Excel add-in only if spreadsheet-native operation is a demonstrated adoption blocker.
- Build advanced planning only after users repeatedly save and compare forecasts in the native
  workspace.
- Add ML only after at least one deterministic baseline and historical backtest exist.
- Consider broad Aleph parity only after the initial finance workspace demonstrates retention,
  trusted usage, and meaningful time savings.

## Resume Prompt

Use this document as the starting context for a net-new task. Begin with Phase 0: interview the CFO,
inventory the current monthly reporting workflow and NetSuite data requirements, inspect existing
connectors that can be reused, and produce a validated MVP specification before writing code.
