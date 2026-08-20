import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { normalizeGatekeeperAppRouteState } from '../SandboxedGatekeeperApp'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

/**
 * Generic host for any gatekeeper-served management app (AccountDescription.providesUi). The set of
 * apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
 * gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
 *
 * The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
 * nesting inside the /gatekeepers connectors page's component.
 */
export const Route = createFileRoute('/gatekeepers_/$appId')({
  component: GatekeeperApp,
  validateSearch: (search: Record<string, unknown>): { state?: string } => {
    const state = normalizeGatekeeperAppRouteState(search.state)
    return state === undefined || state === '' ? {} : { state }
  },
})

function GatekeeperApp() {
  const { appId } = Route.useParams()
  const { state } = Route.useSearch()
  const navigate = useNavigate()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  const setRouteState = useCallback((value: string) => {
    void navigate({
      to: '/gatekeepers/$appId',
      params: { appId },
      search: value ? { state: value } : {},
      replace: true,
    })
  }, [appId, navigate])
  return <GatekeeperAppPage appId={appId} routeState={state} setRouteState={setRouteState} />
}
