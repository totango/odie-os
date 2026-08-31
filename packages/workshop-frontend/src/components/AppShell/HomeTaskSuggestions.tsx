import {
  Bug,
  GitBranch,
  Headset,
  Ticket,
  type Icon,
} from '@phosphor-icons/react'
import type { DeploymentHubId } from '@gadgets/workshop-shared/api'
import { CREATE_JIRA_ISSUE_PROMPT } from '../../createJiraIssuePrompt'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

// Formats are advertised by example rather than by a row of "Start with Docs" buttons, so the
// first move isn't "pick a file type". The formats themselves are in the composer's `+` menu.
const OPS_SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'ask-codebase',
    label: 'Ask about the codebase',
    description: 'Understand architecture, flows, or a tricky module',
    icon: GitBranch,
    prompt:
      'Help me understand this codebase. Start by explaining the main architecture, important packages, and where I should look for a feature or behavior I describe next.',
  },
  {
    id: 'investigate-bug',
    label: 'Investigate a bug',
    description: 'Trace likely causes and propose a safe fix plan',
    icon: Bug,
    prompt:
      'Investigate a bug in the codebase. Ask me for the symptom or error, then trace likely causes, identify the files involved, and propose a small safe fix plan before changing anything.',
  },
  {
    id: 'create-jira-issue',
    label: 'Create Jira issue',
    description: 'Draft, review, and create an engineering ticket',
    icon: Ticket,
    prompt: CREATE_JIRA_ISSUE_PROMPT,
  },
  {
    id: 'customer-impact',
    label: 'Summarize customer impact',
    description: 'Distill incidents, tickets, or notes into impact and next steps',
    icon: Headset,
    prompt:
      'Summarize customer impact from the material I provide. Pull out affected customers, severity, timeline, current status, open risks, and the clearest next actions.',
  },
]

const REVENUE_SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'account-brief',
    label: 'Build an account brief',
    description: 'Combine internal account context into a concise view',
    icon: Headset,
    prompt: 'Build an account brief using the available internal knowledge and account tools. Cover current goals, product usage, risks, recent engagement, open opportunities, and recommended next steps.',
  },
  {
    id: 'meeting-prep',
    label: 'Prepare for a customer call',
    description: 'Surface priorities, history, risks, and talking points',
    icon: Ticket,
    prompt: 'Prepare me for an upcoming customer call. Use internal account sources first and summarize the relationship, current priorities, recent activity, risks, open items, and suggested talking points.',
  },
  {
    id: 'growth-opportunities',
    label: 'Find growth opportunities',
    description: 'Identify expansion signals and concrete follow-ups',
    icon: GitBranch,
    prompt: 'Analyze the account information available internally and identify credible growth or expansion opportunities. Explain each signal, evidence, risk, and recommended follow-up.',
  },
  {
    id: 'customer-follow-up',
    label: 'Draft a customer follow-up',
    description: 'Turn context and commitments into a clear message',
    icon: Bug,
    prompt: 'Draft a concise customer follow-up based on the internal account context I provide or identify. Include decisions, commitments, owners, dates, and a clear next step.',
  },
]

const SUPPORT_SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'investigate-account-issue',
    label: 'Investigate an account issue',
    description: 'Join account, support, incident, and product context',
    icon: Bug,
    prompt: 'Investigate a customer account issue. Use internal account and knowledge tools first, then correlate support history, incidents, integrations, and relevant code paths. Summarize evidence and next actions.',
  },
  {
    id: 'support-answer',
    label: 'Answer a support question',
    description: 'Ground a response in internal product knowledge',
    icon: Headset,
    prompt: 'Answer a customer support question using internal knowledge sources first. Distinguish confirmed facts from assumptions and provide a concise customer-ready response plus internal follow-up notes.',
  },
  {
    id: 'create-jira-issue',
    label: 'Create Jira issue',
    description: 'Draft, review, and create an engineering ticket',
    icon: Ticket,
    prompt: CREATE_JIRA_ISSUE_PROMPT,
  },
  {
    id: 'customer-impact',
    label: 'Summarize customer impact',
    description: 'Distill incidents and tickets into impact and next steps',
    icon: GitBranch,
    prompt: 'Summarize customer impact from internal account, incident, and support sources. Pull out affected customers, severity, timeline, current status, open risks, and the clearest next actions.',
  },
]

const SUGGESTIONS: Record<DeploymentHubId, TaskSuggestion[]> = {
  ops: OPS_SUGGESTIONS,
  revenue: REVENUE_SUGGESTIONS,
  support: SUPPORT_SUGGESTIONS,
  finance: [],
}

// One row, shared by every suggestion so the list reads as one kind of offer.
function SuggestionRow({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle transition-colors group-hover:text-kumo-default">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {label}
          </span>
          <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {description}
          </span>
        </span>
      </button>
    </li>
  )
}

export default function HomeTaskSuggestions({
  hub,
  onPick,
}: {
  hub: DeploymentHubId
  onPick: (prompt: string) => void
}) {
  return (
    <section aria-label="Example tasks" className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        Get started
      </h3>
      <ul className="grid gap-0.5 sm:grid-cols-2 sm:gap-x-2">
        {SUGGESTIONS[hub].map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            icon={<suggestion.icon size={16} />}
            label={suggestion.label}
            description={suggestion.description}
            onClick={() => onPick(suggestion.prompt)}
          />
        ))}
      </ul>
    </section>
  )
}
