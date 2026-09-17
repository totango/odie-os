import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { RequestBuildPanel } from '../community-requests/RequestBuildPanel'

export const Route = createFileRoute('/requests/$requestId_/runs/$runId')({
  component: RequestBuildRoute,
})

function RequestBuildRoute() {
  const { requestId, runId } = Route.useParams()
  const navigate = useNavigate()
  const close = () => navigate({
    to: '/requests/$requestId',
    params: { requestId },
    replace: true,
  })

  return <Dialog.Root open onOpenChange={open => { if (!open) void close() }}>
    <Dialog
      size="lg"
      className="!fixed !inset-y-0 !left-auto !right-0 !top-0 !z-[1010] flex !h-dvh !max-h-dvh !w-full !max-w-none !translate-x-0 !translate-y-0 flex-col overflow-hidden !rounded-none border-l border-kumo-line bg-kumo-base p-0 shadow-2xl md:!inset-y-3 md:!right-3 md:!top-3 md:!h-[calc(100dvh-1.5rem)] md:!max-h-[calc(100dvh-1.5rem)] md:!w-[min(760px,calc(100vw-304px))] md:!rounded-2xl md:border"
    >
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-kumo-line px-4 sm:px-6">
        <div>
          <Dialog.Title className="text-base font-semibold text-kumo-strong">Request build</Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle">Review this restricted build without leaving the Feature Requests board.</Dialog.Description>
        </div>
        <Dialog.Close render={props => <button {...props} type="button" aria-label="Close request build" className="flex h-9 w-9 items-center justify-center rounded-lg text-kumo-subtle transition hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring"><X size={18} /></button>} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
        <RequestBuildPanel requestId={requestId} runId={runId} />
      </div>
    </Dialog>
  </Dialog.Root>
}
