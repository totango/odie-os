import { createFileRoute } from '@tanstack/react-router'
import RequestsPage from '../community-requests/RequestsPage'

export const Route = createFileRoute('/requests')({
  validateSearch: (search: Record<string, unknown>): { moderate?: boolean } => ({ moderate: search.moderate === true || undefined }),
  component: RequestsRoute,
})

function RequestsRoute() {
  const { moderate } = Route.useSearch()
  return <RequestsPage moderate={moderate} />
}
