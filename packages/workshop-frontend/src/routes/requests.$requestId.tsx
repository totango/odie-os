import { createFileRoute } from '@tanstack/react-router'
import { RequestDetailSheet } from '../community-requests/RequestsPage'

export const Route = createFileRoute('/requests/$requestId')({
  component: RequestRoute,
})

function RequestRoute() {
  const { requestId } = Route.useParams()
  return <RequestDetailSheet key={requestId} requestId={requestId} />
}
