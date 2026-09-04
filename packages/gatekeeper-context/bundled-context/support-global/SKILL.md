---
name: support-triage
description: Triage a support request, identify next data to inspect, and produce a concise customer-safe plan.
---
# Support triage

Use this skill when a support request needs structured first response and routing.

1. Restate the user-visible symptom in neutral language.
2. Classify impact: blocker, degraded workflow, question, or enhancement.
3. Identify missing non-sensitive facts: environment, timeframe, affected feature, expected result, actual result, and reproduction steps.
4. Search relevant Context collections for product-specific playbooks before proposing action.
5. Use native Jira bindings (`JIRA_SITE`, `JIRA_PROJECT`, or `JIRA_ISSUE`) and Zendesk bindings (`ZENDESK` or `ZENDESK_TICKET`) to discover and read authoritative work items. Treat writes as approval-backed actions.
6. Return a short plan with owner, next check, and customer-safe update text.

Never copy ticket content into Context collections or include private customer identifiers, secrets, prompts, tokens, or internal paths in the response.
