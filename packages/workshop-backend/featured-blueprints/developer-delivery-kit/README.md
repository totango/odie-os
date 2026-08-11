# Developer Delivery Kit

A source-backed starter gadget for delivery leads and engineering teams. It centers the native GitHub gatekeeper but has no required bindings. The app is useful disconnected through realistic demo data, manual create/edit flows, and JSON import.

Optional connectors are detected defensively by exact binding name: `GITHUB_REPO`, `GITHUB_ISSUE`, `GITHUB_PULL_REQUEST`, `GMAIL_INBOX`, `GMAIL_SEARCH`, `GMAIL_LABEL`, `LINEAR_WORKSPACE`, `LINEAR_TEAM`, `LINEAR_ISSUE`, `TEAM_PI`, and `JARVIS`. Jira has no native package assumed here; route Jira through Team PI or a vetted MCP connector. Missing or skipped connectors no-op and display onboarding guidance telling users to use the host **Connections** tab.

The only live reads this persistent gadget performs are documented exact-binding calls: `GITHUB_REPO.getMetadata()`, `GITHUB_REPO.listPullRequests()`, `GITHUB_REPO.listIssues()`, and `TEAM_PI.listConnections()`. Issue/PR-level GitHub bindings show as connected but do not imply repository-wide queue access. JARVIS is detected for agent-routed operational context but is not invoked directly by this gadget. The server never fabricates live connector data.

Durable state is stored in the gadget Durable Object under `delivery-kit:v1`. Initial demo data is returned for an empty instance without writing over user state; only the explicit **Reset demo** action replaces stored data. Imported items and text fields are bounded server-side. The UI is a self-contained DOM/CSS workbench with repo health, PR review queue, release readiness, linked risks, manual fallback, demo reset, and print-safe responsive layout.
