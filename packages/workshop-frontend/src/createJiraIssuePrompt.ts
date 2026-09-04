export const CREATE_JIRA_ISSUE_PROMPT = [
  'Create a Jira issue.',
  'First gather the project, issue type, priority, summary, description, reproduction steps, expected behavior, actual behavior, acceptance criteria, and customer context.',
  'Ask follow-up questions for any missing required fields before drafting.',
  'Show me the final draft for approval before taking any write action.',
  'Then use only the approval-backed jira_create_issue tool exposed by the native JIRA_SITE or JIRA_PROJECT binding.',
  'After creation, use jira_read_issue and the approval-backed jira_add_comment, jira_update_issue, or jira_transition_issue tools for any requested follow-up management.',
  'Present the returned provider URL as an Open work item link; Odie opens recognized Jira links in its Work Items panel by default.',
  'Do not request or connect a generic Atlassian MCP server, and do not invent or call any other Jira API.',
  'If jira_create_issue is unavailable or reports an authentication, connection, or permission failure, retain the draft and call requestConnection only for the native Jira site or project resource so I can connect or update Jira access.',
].join(' ');
