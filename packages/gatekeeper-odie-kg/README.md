# ODIE MCP gatekeeper

First-party, per-user OAuth connector for Agentic's ODIE MCP `/api/mcp/odie` resource. The package
and path remain `packages/gatekeeper-odie-kg` for compatibility, and connected accounts still
contribute an owner-only ambient `TOTANGO_KG` binding to every workspace. The human-facing brand is
**ODIE MCP**.

The hosted connector supports only the EU endpoint:
`https://api-agents.unison.totango.com/api/mcp/odie`. Any other configured endpoint fails closed.

This connector is deliberately narrower than the public ODIE MCP service. The public endpoint
advertises 42 tools. The Workshop ambient connector must request only read scopes and expose exactly
36 read-only tools: 12 `odie-kg-*` tools, 6 customer context tools, `odie-skills-list`,
`odie-export-status`, `odie-export-download`, and 15 `leviosa_public_*` readers.

The connector must exclude the six side-effecting public tools: `odie-skill-run`,
`odie-skill-create-draft`, `odie-skill-publish`, `odie-export-request`, `run_odie_skill`, and
`generate_brief`. Tool classification is connector-owned and all exposed tools are reads regardless
of upstream MCP annotations.

OAuth uses browser PKCE per employee. Identity and organization binding are derived by Agentic from
the user's OAuth principal. Never replace this with a shared deployment token: doing so would collapse
tenant isolation.

Existing accounts connected under the previous display name must reconnect once to authorize the
expanded read-only scope set. The required-connection health check enforces this migration.

This source is separate from JARVIS's Graphify repository graph. Graphify is for engineering code,
topology, bugs, and implementation questions; ODIE MCP is primary for customer, account, CSM,
product-usage, and internal business questions.

See `../../docs/odie-mcp.md` for endpoints, scopes, compatible-client setup, the public 42-tool
catalog, safe usage guidance, and troubleshooting.
