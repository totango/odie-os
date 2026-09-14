import { createFileRoute } from '@tanstack/react-router'
import RequestDetailPage from '../community-requests/RequestDetailPage'

export const Route = createFileRoute('/requests_/$requestId')({
  validateSearch: (search: Record<string, unknown>): { moderate?: boolean } => ({ moderate: search.moderate === true || undefined }),
  component: RequestRoute,
})

function RequestRoute() {
  const { requestId } = Route.useParams()
  const { moderate } = Route.useSearch()
  return <RequestDetailPage key={`${requestId}:${moderate}`} requestId={requestId} moderate={moderate} />
}
