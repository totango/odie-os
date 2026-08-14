# Totango Knowledge Graph

The hosted Odie instance integrates Agentic's tenant-facing Odie MCP as a first-party connector:

```text
Odie user
  -> per-user OAuth at Agentic /api/mcp/odie
  -> Agentic derives organization/admin identity
  -> signed actor assertion to Zords
  -> tenant-bound customer and internal knowledge graph
```

This is not the repository graph. The two sources have intentionally separate jobs:

- **Totango Knowledge Graph (`TOTANGO_KG`)** is primary for customer, account, CSM,
  product-usage, and internal business questions.
- **JARVIS Graphify repo graph** is primary for code topology, implementation, bug, and repository
  engineering questions. The Totango GitHub source verifies exact current code.

## Security model

- Every user authorizes their own Totango identity once. The connected account then contributes an
  owner-only ambient singleton to all of that user's workspaces.
- Agentic derives tenant identity from the OAuth principal. Odie never accepts a tenant or
  organization ID from an agent call.
- OAuth requests only `openid profile email mcp:odie:kg:read`.
- The gatekeeper hard-allows the twelve `odie-kg-*` read tools and excludes exports and skills.
- Tool classification is owned by the gatekeeper and remains read-only regardless of upstream MCP
  annotations.
- Observers are refused. A shared deployment token is forbidden because it would collapse tenant
  isolation.
- Disabling `odie_kg` in the deployment Gatekeepers panel hides both new connections and existing
  ambient singleton capabilities without deleting account credentials.

## Production endpoints

- MCP: `https://api-agents.unison.totango.com/api/mcp/odie`
- Connector callback: `https://odie-os.odie-os.workers.dev/gatekeeper/odie-kg/oauth`

The MCP endpoint requires Agentic and Zords to share `ODIE_KG_ACTOR_ASSERTION_SECRET`, and Zords must
have completed its centralized tenant-sync migration before KG access is enabled.

## Verification

Public MCP metadata can be checked without credentials:

```bash
curl --fail --silent --show-error \
  https://api-agents.unison.totango.com/api/mcp/odie/info
```

Connector checks:

```bash
pnpm --filter @gadgets/mcp-shared test
pnpm --filter @gadgets/gatekeeper-odie-kg types:check
pnpm --filter @gadgets/gatekeeper-odie-kg test
pnpm --filter @gadgets/gatekeeper-odie-kg build
```

After deployment, connect **Totango Knowledge Graph** once from Connections. Start a new workspace,
confirm `TOTANGO_KG` appears as an always-available binding, and ask one account question plus one
repository question. The account question must use KG first; the repository question must use
Graphify first.
