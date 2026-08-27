# ODIE MCP gatekeeper

First-party, per-user OAuth connector for Agentic's ODIE MCP `/api/mcp/odie` resource. The package
and path remain `packages/gatekeeper-odie-kg` for compatibility, and connected accounts still
contribute an owner-only ambient `TOTANGO_KG` binding to every workspace. The human-facing brand is
**ODIE MCP**.

The hosted connector supports only the EU endpoint:
`https://api-agents.unison.totango.com/api/mcp/odie`. Any other configured endpoint fails closed.

The Workshop ambient connector explicitly requests all 15 ODIE MCP scopes and exposes the exact
54-tool first-party catalog. Its connector-owned policy classifies 42 tools as observations and 12
as actions. Every action is auto-approvable because this connector is pinned to Totango's fixed EU
endpoint and hard-allows tool names; unknown future tools remain excluded regardless of upstream MCP
annotations.

OAuth uses browser PKCE per employee. Identity and organization binding are derived by Agentic from
the user's OAuth principal. Never replace this with a shared deployment token: doing so would collapse
tenant isolation.

Existing accounts must reconnect after each scope revision. The required-connection health check
enforces this migration.

This source is separate from JARVIS's Graphify repository graph. Graphify is for engineering code,
topology, bugs, and implementation questions; ODIE MCP is primary for customer, account, CSM,
product-usage, and internal business questions.

See `../../docs/odie-mcp.md` for endpoints, scopes, compatible-client setup, the 54-tool
catalog, safe usage guidance, and troubleshooting.
