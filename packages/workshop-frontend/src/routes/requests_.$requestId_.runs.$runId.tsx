import { createFileRoute, Link } from '@tanstack/react-router'
import { RequestBuildPanel } from '../community-requests/RequestBuildPanel'

export const Route = createFileRoute('/requests_/$requestId_/runs/$runId')({
  component: RequestBuildRoute,
})

function RequestBuildRoute() {
  const { requestId, runId } = Route.useParams()
  return <main className="mx-auto w-full max-w-3xl space-y-6 p-4 text-kumo-default sm:p-8">
    <Link to="/requests/$requestId" params={{ requestId }} className="text-kumo-brand underline">Request</Link>
    <h1 className="text-2xl font-semibold">Request build</h1>
    <RequestBuildPanel requestId={requestId} runId={runId} />
  </main>
}
