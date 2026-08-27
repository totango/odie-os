export const CREATE_JIRA_ISSUE_PROMPT = [
  'Create a Jira issue.',
  'First gather the project, issue type, priority, summary, description, reproduction steps, expected behavior, actual behavior, acceptance criteria, and customer context.',
  'Ask follow-up questions for any missing required fields before drafting.',
  'Show me the final draft for approval before taking any write action.',
  'Then use only an explicit approval-backed Jira create action. Do not pretend a repository-backed Team PI create endpoint exists, and do not invent or call any other API.',
  'If an approval-backed Jira create action is unavailable, explain that the Jira connection or create action is missing and retain the draft in chat so I can copy or reconnect.',
].join(' ');
