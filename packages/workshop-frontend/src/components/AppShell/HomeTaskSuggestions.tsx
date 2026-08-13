import {
  Bug,
  GitBranch,
  Headset,
  Ticket,
  type Icon,
} from '@phosphor-icons/react'

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
const SUGGESTIONS: TaskSuggestion[] = [
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
    id: 'jira-from-zendesk',
    label: 'Create Jira from Zendesk',
    description: 'Turn support context into an actionable engineering ticket',
    icon: Ticket,
    prompt:
      'Create a Jira ticket from a Zendesk conversation. Summarize the customer problem, expected vs actual behavior, reproduction details, affected account or plan if available, and acceptance criteria.',
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
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint"
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
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  return (
    <section aria-label="Example tasks" className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        Get started
      </h3>
      <ul className="grid gap-0.5 sm:grid-cols-2 sm:gap-x-2">
        {SUGGESTIONS.map((suggestion) => (
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
