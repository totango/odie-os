export const CREATE_JIRA_ISSUE_PROMPT = [
  'Create a Jira issue.',
  'First gather the project, issue type, priority, summary, description, reproduction steps, expected behavior, actual behavior, acceptance criteria, and customer context.',
  'Ask follow-up questions for any missing required fields before drafting.',
  'Show me the final draft for approval before taking any write action.',
  'Then use only the approval-backed TEAM_PI.createJiraIssue action exposed by Team PI Work Items.',
  'Do not request or connect a generic Atlassian MCP server, and do not invent or call any other Jira API.',
  'If TEAM_PI.createJiraIssue is unavailable, explain that the Team PI connection or create action is missing and retain the draft in chat so I can copy or reconnect Team PI.',
].join(' ');
