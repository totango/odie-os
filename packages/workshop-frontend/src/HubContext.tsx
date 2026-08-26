import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DEFAULT_DEPLOYMENT_HUB_ID,
  type ConfigurableDeploymentHubId,
  type DeploymentHubId,
  type FinanceHubStatus,
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
  finance: {
    label: 'Finance',
    heading: 'Finance Operations Workbench',
    description: 'Review bounded finance working data, evidence, variances, contracts, and forecasts.',
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
  financeStatus: FinanceHubStatus | null
}

const HubContext = createContext<HubContextValue>({
  hub: DEFAULT_DEPLOYMENT_HUB_ID,
  enabledHubs: [DEFAULT_DEPLOYMENT_HUB_ID],
  selectHub: () => {},
  financeStatus: null,
})

export function HubProvider({
  enabledHubs,
  financeStatus,
  children,
}: {
  enabledHubs: ConfigurableDeploymentHubId[]
  financeStatus?: FinanceHubStatus | null
  children: ReactNode
}) {
  const financeStatusLoading = financeStatus === null
  const selectableHubs: DeploymentHubId[] = financeStatus?.authorized
    ? [...enabledHubs, 'finance']
    : enabledHubs
  const storedPreference = (() => {
    try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
  })()
  const pendingFinancePreference = useRef(
    financeStatusLoading && storedPreference === 'finance' ? 'finance' : null,
  )
  const [hub, setHub] = useState<DeploymentHubId>(() => {
    return resolveSelectedHub(storedPreference, selectableHubs)
  })

  useEffect(() => {
    if (financeStatusLoading && pendingFinancePreference.current) return
    const resolved = resolveSelectedHub(pendingFinancePreference.current ?? hub, selectableHubs)
    pendingFinancePreference.current = null
    if (resolved !== hub) setHub(resolved)
    try { localStorage.setItem(STORAGE_KEY, resolved) } catch {}
  }, [financeStatusLoading, selectableHubs, hub])

  const selectHub = (next: DeploymentHubId) => {
    if (!selectableHubs.includes(next)) return
    setHub(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
  }

  return (
    <HubContext.Provider value={{ hub, enabledHubs: selectableHubs, selectHub, financeStatus: financeStatus ?? null }}>
      {children}
    </HubContext.Provider>
  )
}

export function useHub(): HubContextValue {
  return useContext(HubContext)
}
