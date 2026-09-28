import { createFileRoute } from '@tanstack/react-router'
import RequestsPage from '../community-requests/RequestsPage'

export const Route = createFileRoute('/requests')({
  component: RequestsRoute,
})

function RequestsRoute() {
  return <RequestsPage />
}
