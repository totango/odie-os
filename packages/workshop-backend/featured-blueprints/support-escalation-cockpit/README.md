# Support Escalation Cockpit

Source-backed starter gadget for support leaders and incident-adjacent teams. It runs without any required bindings: users can load realistic demo data, create/edit escalations manually, or import JSON/CSV records.

Optional connectors are intentionally non-authoritative until a user/admin wires them in the host **Connections** tab. The server detects these defensive binding names when present and otherwise no-ops safely:

- `ZENDESK`
- `GMAIL`
- `TEAM_PI`
- `JARVIS`
- `JIRA` or `LINEAR`

The app never fabricates live connector data. Demo data is clearly labeled and only installed by the user via **Load demo data** / **Reset demo**. Live sync methods return an unavailable/empty result unless an optional binding exposes a compatible read method.

## Files

- `client.js` builds the responsive DOM/CSS UI.
- `server.js` exports the `Gadget` Durable Object, persists records in durable storage, and exposes RPC methods used by the client.
- `blueprint.json` is the source sidecar (`starter.support-escalation-cockpit`, revision 1) with no required bindings.

## Import formats

JSON import accepts an array of records or `{ "records": [...] }`. CSV import expects headers such as `title,customer,severity,status,owner,source,deadline,summary,tags`.
