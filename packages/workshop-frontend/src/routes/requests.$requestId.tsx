import { createFileRoute } from '@tanstack/react-router'
import { RequestDetailSheet } from '../community-requests/RequestsPage'

export const Route = createFileRoute('/requests/$requestId')({
  validateSearch: (search: Record<string, unknown>): { moderate?: boolean } => ({ moderate: search.moderate === true || undefined }),
  component: RequestRoute,
})

function RequestRoute() {
  const { requestId } = Route.useParams()
  const { moderate } = Route.useSearch()
  return <RequestDetailSheet key={`${requestId}:${moderate}`} requestId={requestId} moderate={!!moderate} />
}
