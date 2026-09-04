# Jira Gatekeeper

Dedicated Jira Cloud gatekeeper for Work Items-compatible agents. It exposes capability-scoped
sessions for a Jira site, project, or issue; uses Atlassian OAuth 2.0 (3LO) through
`api.atlassian.com`; stores rotating refresh tokens in a `UserAccount` Durable Object; and routes
reads through observation authorization and writes through the approval queue.

No production OAuth client secret is committed. Set `CLIENT_ID`, `CLIENT_SECRET`, and `BASE_URL` in
the deployment environment.
