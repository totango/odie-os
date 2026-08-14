import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  DEFAULT_DEPLOYMENT_HUB_ID,
  type DeploymentHubId,
} from '@gadgets/workshop-shared/api'

const STORAGE_KEY = 'odie:selected-hub'

export const HUB_DETAILS: Record<DeploymentHubId, {
  label: string
  heading: string
  description: string
}> = {
  ops: {
    label: 'Ops',
    heading: 'What do you need to know or do?',
    description: 'Investigate incidents, work across the codebase, or turn internal context into action.',
  },
  revenue: {
    label: 'Revenue',
    heading: 'What revenue work should we advance?',
    description: 'Research accounts, prepare customer conversations, and move opportunities forward.',
  },
  support: {
    label: 'Support',
    heading: 'What customer issue should we resolve?',
    description: 'Bring together account context, support history, and engineering signals.',
  },
}

function resolveSelectedHub(
  preferred: string | null,
  enabledHubs: DeploymentHubId[],
): DeploymentHubId {
  if (enabledHubs.includes(preferred as DeploymentHubId)) return preferred as DeploymentHubId
  if (enabledHubs.includes(DEFAULT_DEPLOYMENT_HUB_ID)) return DEFAULT_DEPLOYMENT_HUB_ID
  return enabledHubs[0] ?? DEFAULT_DEPLOYMENT_HUB_ID
}

type HubContextValue = {
  hub: DeploymentHubId
  enabledHubs: DeploymentHubId[]
  selectHub: (hub: DeploymentHubId) => void
}

const HubContext = createContext<HubContextValue>({
  hub: DEFAULT_DEPLOYMENT_HUB_ID,
  enabledHubs: [DEFAULT_DEPLOYMENT_HUB_ID],
  selectHub: () => {},
})

export function HubProvider({
  enabledHubs,
  children,
}: {
  enabledHubs: DeploymentHubId[]
  children: ReactNode
}) {
  const [hub, setHub] = useState<DeploymentHubId>(() => {
    try {
      return resolveSelectedHub(localStorage.getItem(STORAGE_KEY), enabledHubs)
    } catch {
      return resolveSelectedHub(null, enabledHubs)
    }
  })

  useEffect(() => {
    const resolved = resolveSelectedHub(hub, enabledHubs)
    if (resolved !== hub) setHub(resolved)
    try { localStorage.setItem(STORAGE_KEY, resolved) } catch {}
  }, [enabledHubs, hub])

  const selectHub = (next: DeploymentHubId) => {
    if (!enabledHubs.includes(next)) return
    setHub(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
  }

  return (
    <HubContext.Provider value={{ hub, enabledHubs, selectHub }}>
      {children}
    </HubContext.Provider>
  )
}

export function useHub(): HubContextValue {
  return useContext(HubContext)
}
