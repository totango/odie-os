# Jira Delivery Risk Radar

Source-backed starter gadget for engineering managers, TPMs, and release owners. It has no required bindings and works fully disconnected with manual risk records, JSON/CSV import, and user-loaded demo data.

Optional connector bindings are detected defensively and never treated as authority unless the host workspace owner wires them in the **Connections** tab:

- `JIRA` or `LINEAR`
- `GITHUB`
- `GMAIL`
- `JIRA_SITE`
- `JARVIS`

Live sync is safe by default: missing bindings are reported as unavailable, unknown connector APIs import nothing, and demo records are clearly marked as `demo`. The app never fabricates live source data.

## Files

- `client.js` builds a responsive, accessible delivery-risk workbench UI.
- `server.js` exports the `Gadget` Durable Object and persists all records in durable storage.
- `blueprint.json` is the source sidecar (`starter.jira-delivery-risk`, revision 1) with no required bindings.

## Import formats

JSON import accepts an array of risks or `{ "records": [...] }`. CSV import expects headers such as `title,program,release,status,probability,impact,owner,dueDate,summary,mitigation,tags`.
