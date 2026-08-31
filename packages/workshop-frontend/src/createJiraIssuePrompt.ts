export const CREATE_JIRA_ISSUE_PROMPT = [
  'Create a Jira issue.',
  'First gather the project, issue type, priority, summary, description, reproduction steps, expected behavior, actual behavior, acceptance criteria, and customer context.',
  'Ask follow-up questions for any missing required fields before drafting.',
  'Show me the final draft for approval before taking any write action.',
  'Then use only the approval-backed TEAM_PI.createJiraIssue action exposed by Team PI Work Items.',
  'Do not request or connect a generic Atlassian MCP server, and do not invent or call any other Jira API.',
  'If TEAM_PI.createJiraIssue is unavailable or reports an authentication, connection, or permission failure, retain the draft and call requestConnection only for the Team PI account resource team-pi://account so I can reconnect or update Team PI access.',
].join(' ');
