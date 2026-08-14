# Totango Knowledge Graph gatekeeper

First-party, per-user OAuth connector for Agentic's `/api/mcp/odie` resource. After connection, the
account contributes an owner-only ambient `TOTANGO_KG` binding to every workspace. It exposes only
the twelve `odie-kg-*` read tools for customer, account, CSM, product-usage, and internal business
knowledge. Export and skill tools are deliberately excluded.

This source is separate from JARVIS's Graphify repository graph. Graphify is for engineering code,
topology, bugs, and implementation questions; Totango KG is primary for customer/CSM questions.

The connector requests only `openid profile email mcp:odie:kg:read`. Identity and organization are
derived by Agentic from the user's OAuth principal and signed to Zords. Never replace this with a
shared deployment token: doing so would collapse tenant isolation.
