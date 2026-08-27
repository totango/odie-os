# ODIE MCP

ODIE MCP is Agentic's `/api/mcp/odie` MCP resource for Odie customer, knowledge-graph,
skill, export, and Leviosa public-reader access. This repository uses that public MCP resource in
two different ways:

1. **Public MCP service**: compatible MCP clients can connect directly to the public endpoint. It
   advertises all 54 tools listed in [ODIE MCP tool catalog](#odie-mcp-tool-catalog-54-tools).
2. **Workshop ambient connector**: this repository's `packages/gatekeeper-odie-kg` package connects
   each Workshop user through browser OAuth and exposes a fixed first-party catalog to agents. The
   package name and paths remain `gatekeeper-odie-kg`; the ambient binding name remains `TOTANGO_KG`;
   the human-facing brand is **ODIE MCP**.

The Workshop connector explicitly requests every currently supported scope and exposes the exact
54-tool catalog. Its connector-owned policy classifies 42 observations and 12 auto-approvable actions;
unknown future tools remain excluded.

## Endpoint

ODIE MCP currently supports only the EU endpoint:

`https://api-agents.unison.totango.com/api/mcp/odie`

Do not configure the US endpoint yet. The one current US customer does not need ODIE MCP, so the
hosted connector fails closed if any endpoint other than the EU URL is configured.

Public metadata can be checked without credentials:

```bash
curl --fail --silent --show-error \
  https://api-agents.unison.totango.com/api/mcp/odie/info
```

## OAuth and organization binding

ODIE MCP uses browser OAuth with PKCE. Each employee authorizes their own account in the browser.
Agentic derives the employee identity and organization binding from the OAuth principal; agents and
tools do not supply a tenant or organization ID. This per-employee binding is part of the safety
model: do not replace it with a shared deployment token, because that would collapse tenant isolation.

During connection:

1. The MCP client opens an authorization page.
2. Sign in with normal Unison credentials.
3. Select the correct organization if prompted.
4. Review and approve the requested permissions.
5. Return to the MCP client after authorization completes.

The connection is bound to the selected organization and the employee's current membership. Never
manually create, paste, or share an access token. Each employee must authorize their own connection.

## OAuth scopes

Scopes explicitly requested by this repository's Workshop connector:

- `mcp:odie:kg:read`
- `mcp:odie:exports:read`
- `mcp:odie:exports:write`
- `mcp:odie:skills:read`
- `mcp:odie:skills:run`
- `mcp:odie:skills:write`
- `mcp:odie:customers:read`
- `mcp:odie:lenses:read`
- `mcp:accounts:read`
- `mcp:odie:actions:run`
- `mcp:odie:briefs:generate`
- `mcp:odie:public-api:read`
- `mcp:odie:interviews:read`
- `mcp:odie:interviews:write`
- `mcp:odie:interviews:publish`

## Workshop ambient connector contract

The in-product Odie connector is the least-privilege form used by this repository:

- Package and path compatibility: `packages/gatekeeper-odie-kg` remains the package.
- Binding compatibility: connected accounts still appear to agents as the ambient `TOTANGO_KG`
  binding.
- Human branding: the connector should be presented as **ODIE MCP**.
- Authentication: browser OAuth with PKCE, one connected account per employee.
- Authorization: request the explicit 15-scope set above. Do not dynamically adopt future
  `scopes_supported` entries. The authorization server does not support OpenID Connect identity
  scopes on this resource.
- Tool surface: expose exactly 54 hardcoded tools: 42 observations and 12 actions.
- Tool classification is connector-owned and does not trust upstream annotations.
- Actions are auto-approvable because the connector is pinned to Totango's fixed EU endpoint and
  exact tool names. Unknown future tools are excluded.

Accounts connected before this scope revision must reconnect once. The required-connection health
gate requests reauthorization rather than exposing a partially authorized singleton.

This source is separate from JARVIS Graphify. Use ODIE MCP for customer, account, CSM,
product-usage, and internal business questions. Use Graphify for repository topology,
implementation, bug, and engineering questions.

## Compatible-client setup

All examples use the only currently supported endpoint, the EU endpoint.

### Claude Code

```bash
claude mcp add --transport http odie \
  https://api-agents.unison.totango.com/api/mcp/odie
```

Then:

1. Start Claude Code with `claude`.
2. Run `/mcp`.
3. Select `odie`.
4. Choose the authentication option.
5. Complete sign-in and organization selection in the browser.
6. Return to Claude Code and run `/mcp` again to verify the connection.

Inspect or remove the saved registration with:

```bash
claude mcp get odie
claude mcp remove odie
```

Claude Code 2.1.233 displayed `Needs authentication` immediately after registration in production
testing. This means registration succeeded but OAuth is incomplete. If authentication does not open
or remains stuck, update Claude Code, remove and re-add the server, then authenticate through `/mcp`.

### Claude Desktop and Claude Web

For an individual custom connector:

1. Open Claude settings, then Connectors.
2. Choose **Add custom connector**.
3. Name it `Odie`.
4. Enter the endpoint:

```text
https://api-agents.unison.totango.com/api/mcp/odie
```

5. Select **Connect** or **Authenticate**.
6. Complete Unison sign-in and select the correct organization.
7. Enable Odie for the conversation where it should be used.

For Team or Enterprise workspaces, an Owner or Primary Owner may need to add or approve the connector
first. Each employee still completes OAuth individually. Claude web and Desktop execute connectors
from Anthropic's cloud, so use the public HTTPS endpoint, never localhost or an internal Kubernetes
address.

### Cursor

Create or update `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "odie": {
      "url": "https://api-agents.unison.totango.com/api/mcp/odie"
    }
  }
}
```

Then open Cursor settings, open MCP or Tools, enable `odie`, and complete browser OAuth. Confirm the
tools appear before asking the agent to use them. Organization-managed installations may require an
administrator to allow the server.

### Codex CLI

Current Codex documentation configures remote Streamable HTTP servers in `~/.codex/config.toml`:

```toml
[mcp_servers.odie]
url = "https://api-agents.unison.totango.com/api/mcp/odie"
auth = "oauth"
default_tools_approval_mode = "writes"
```

Then run:

```bash
codex mcp login odie
```

Use `codex mcp list` to confirm the server is registered. Confirm the installed Codex version supports
remote Streamable HTTP and OAuth.

### Other compatible MCP clients

The client must support MCP Streamable HTTP, OAuth protected-resource discovery, dynamic client
registration, authorization code flow, PKCE using S256, refresh tokens, and browser redirects.
Configure the EU MCP URL as the server URL. A compliant client receives an HTTP 401 challenge,
follows the advertised `resource_metadata` URL, discovers the authorization server, registers itself,
and begins PKCE authorization.

The OAuth resource value must remain the exact ODIE MCP endpoint. Clients must not substitute the API
origin or the Unison MCP endpoint.

## ODIE MCP tool catalog: 54 tools

The public MCP endpoint and the fixed `TOTANGO_KG` ambient connector expose the tools below.

### Knowledge graph read tools: 12

- `odie-kg-status`
- `odie-kg-domains`
- `odie-kg-accounts`
- `odie-kg-account-root`
- `odie-kg-node`
- `odie-kg-children`
- `odie-kg-expand`
- `odie-kg-search`
- `odie-kg-paths`
- `odie-kg-communities`
- `odie-kg-document`
- `odie-kg-query`

### Customer context read tools: 6

- `get_customer_overview`
- `get_customer_property`
- `search_customer`
- `get_customer_interaction`
- `get_customer_prediction`
- `get_segment`

### Custom skills: 4

- `odie-skills-list`
- `odie-skill-run`
- `odie-skill-create-draft`
- `odie-skill-publish`

### Exports: 3

- `odie-export-request`
- `odie-export-status`
- `odie-export-download`

### Actions and briefs: 2

- `run_odie_skill`
- `generate_brief`

### Leviosa public readers: 15

- `leviosa_public_list_property_definitions`
- `leviosa_public_list_accounts`
- `leviosa_public_get_account`
- `leviosa_public_list_workflow_emails`
- `leviosa_public_get_workflow_email`
- `leviosa_public_list_account_health_snapshots`
- `leviosa_public_list_notes`
- `leviosa_public_get_note`
- `leviosa_public_list_workflows`
- `leviosa_public_get_workflow`
- `leviosa_public_list_workflow_email_templates`
- `leviosa_public_list_workflow_runs`
- `leviosa_public_list_work_items`
- `leviosa_public_get_work_item`
- `leviosa_public_list_email_suppressions`

### Interviews: 9

- `odie-interviews-open`
- `odie-interview-account-search`
- `odie-interview-resume`
- `odie-interview-start`
- `odie-interview-start-topic`
- `odie-interview-restart-topic`
- `odie-interview-submit`
- `odie-interview-draft`
- `odie-interview-approve`

### Interactive views: 3

- `show_lens`
- `show_account`
- `show_account_risk`

The tools a client can invoke depend on granted scopes and organization permissions. The Workshop
connector requests all current scopes, but still excludes any future tool name until reviewed and
added to its fixed allowlist.

## Safe usage guidance

- The Workshop `TOTANGO_KG` connector auto-approves its 12 hardcoded first-party actions. Treat the
  binding as authority to create, publish, request, run, and generate data in ODIE MCP.
- When connecting directly to the public MCP endpoint, grant only the scopes needed for the task.
- Keep searches bounded to the accounts and domains needed for the task.
- Prefer structured ODIE account facts from account, property, dashboard, prediction, and public
  account tools before interactions, notes, documents, or meeting titles.
- Treat interactions, notes, documents, and meeting titles as non-canonical for account roles,
  names, identity, and gender. Use them only as weak context and verify with structured sources.
- Report ambiguity, missing facts, and conflicts explicitly. Do not infer role, name, identity, or
  gender from weak evidence.
- Treat skill-running, draft creation, publishing, export requests, action-running, and brief
  generation as side-effecting operations.
- Direct public clients should ask before invoking tools that create, publish, request, run, or
  generate something unless their own policy explicitly permits automatic execution.
- Do not paste access tokens, refresh tokens, OAuth codes, customer secrets, or credentials into
  prompts, logs, tickets, or documentation.
- Disconnect and reauthorize after selecting the wrong organization.
- Treat generated briefs and skill output as drafts requiring human review.

Example prompts:

```text
Using only Odie read-only tools, check the Knowledge Graph status, list the
available domains, and search for information about Acme. Cite the graph nodes
or documents supporting each conclusion.
```

```text
Use Odie to find the Acme account and summarize its overview, recent
interactions, and relevant predictions. Do not run skills or create artifacts.
```

```text
Prepare the inputs for an account brief about Acme. Show me the proposed
parameters and wait for confirmation before calling generate_brief.
```

## Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Needs authentication | OAuth is incomplete | Open the client's MCP management UI and complete browser OAuth. |
| Wrong customer data or organization | The wrong organization was selected | Disconnect ODIE MCP, reconnect, and select the correct organization. |
| Missing-scope or 403 response | The connection lacks a required scope | Reauthorize and approve the permission required by that tool. |
| Admin-required response | The operation requires organization-admin permission | Ask an organization administrator to perform or approve it. |
| Tools do not appear | Wrong URL or unsupported transport | Confirm the EU URL and Streamable HTTP support, then restart the client. |
| OAuth repeatedly loops | Stale client or registration | Update the client, remove the saved connection, and authorize again. |
| Unknown tools appear in Workshop | Connector policy is wrong | The `TOTANGO_KG` connector must expose exactly the reviewed 54-tool allowlist. |
| `leviosa_public_list_property_definitions` fails | Known upstream issue | Track [AI-3580](https://catalystsoftware.atlassian.net/browse/AI-3580) and use verified KG/customer tools meanwhile. |
| Agent answers repository questions from ODIE MCP | Wrong source selection | Use Graphify for repository engineering/topology questions; use ODIE MCP for customer/account/CSM/product-usage/internal-business questions. |

## Repository verification

Connector checks:

```bash
pnpm --filter @gadgets/gatekeeper-odie-kg types:check
pnpm --filter @gadgets/gatekeeper-odie-kg test
pnpm --filter @gadgets/gatekeeper-odie-kg build
```

After deployment, connect **ODIE MCP** once from Connections. Start a new workspace, confirm
`TOTANGO_KG` appears as an always-available binding, and ask one account question plus one repository
question. The account question should use ODIE MCP first; the repository question should use Graphify
first.

The Knowledge Graph read path is verified end-to-end in EU production. The 15 public-reader tools are
advertised, but `leviosa_public_list_property_definitions` currently fails against its upstream
service. Treat the complete public-reader category as preview until AI-3580 is resolved.
