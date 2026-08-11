# Incident Investigation Board

Source-backed starter for running an incident investigation in a gadget. It is intentionally useful without any required bindings: users can work in demo mode, create/edit records manually, and import a JSON array of timeline/evidence/action/risk/decision records.

Optional sources are detected defensively from exact binding names and never auto-granted. If users want live context, they should open the host **Connections** tab and wire resources such as `GITHUB_REPO`, `GITHUB_ISSUE`, `GITHUB_PULL_REQUEST`, `GMAIL_INBOX`, `GMAIL_SEARCH`, `GMAIL_LABEL`, `LINEAR_WORKSPACE`, `LINEAR_TEAM`, `LINEAR_ISSUE`, `TEAM_PI`, or `JARVIS`. There is no native Jira or Zendesk package assumed here; route those through Team PI or a vetted MCP connector and capture the resulting findings manually.

The only live reads this persistent gadget performs are documented exact-binding calls: `GITHUB_REPO.getMetadata()`, `GITHUB_REPO.listPullRequests()`, `GITHUB_REPO.listIssues()`, and `TEAM_PI.listConnections()`. Issue/PR-level GitHub bindings show as connected but do not imply repository-wide list access. JARVIS is detected for agent-routed workflows but is not invoked directly by this gadget.

The server stores all state in Durable Object storage under `incident-board:v1`. Initial demo data is returned for an empty instance without writing over user state; only the explicit **Reset demo** action replaces stored data. Imported records and text fields are bounded server-side. The client is a self-contained DOM/CSS UI with responsive enterprise workbench layout and print-safe styles.
