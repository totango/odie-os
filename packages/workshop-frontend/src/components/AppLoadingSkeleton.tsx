import { SkeletonLine } from '@cloudflare/kumo'

/** App-shell-shaped loading placeholder for page-level authentication and data gates. */
export function AppLoadingSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-full bg-kumo-base" role="status" aria-busy="true" aria-label={label}>
      <aside className="hidden w-[72px] shrink-0 border-r border-kumo-line bg-kumo-elevated p-4 sm:flex sm:flex-col sm:items-center sm:gap-5">
        <div className="h-10 w-10 animate-pulse rounded-xl bg-kumo-fill" />
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-8 w-8 animate-pulse rounded-lg bg-kumo-fill" />
        ))}
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex h-16 items-center justify-between border-b border-kumo-line px-5 sm:px-8">
          <SkeletonLine minWidth={112} maxWidth={160} blockHeight={18} />
          <div className="h-8 w-8 animate-pulse rounded-full bg-kumo-fill" />
        </header>
        <main className="mx-auto w-full max-w-6xl space-y-6 px-5 py-8 sm:px-8 sm:py-12">
          <div className="space-y-3">
            <SkeletonLine minWidth={190} maxWidth={280} blockHeight={30} />
            <SkeletonLine minWidth={280} maxWidth={520} blockHeight={14} />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <section key={index} className="space-y-4 rounded-2xl border border-kumo-line p-5">
                <div className="h-10 w-10 animate-pulse rounded-xl bg-kumo-fill" />
                <SkeletonLine minWidth={110} maxWidth={180} blockHeight={18} />
                <SkeletonLine minWidth={160} maxWidth={260} blockHeight={12} />
                <SkeletonLine minWidth={130} maxWidth={220} blockHeight={12} />
              </section>
            ))}
          </div>
          <section className="space-y-4 rounded-2xl border border-kumo-line p-5">
            <SkeletonLine minWidth={150} maxWidth={240} blockHeight={20} />
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex items-center gap-4 border-t border-kumo-line pt-4 first:border-0 first:pt-0">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-kumo-fill" />
                <div className="min-w-0 flex-1 space-y-2">
                  <SkeletonLine minWidth={120} maxWidth={240} blockHeight={13} />
                  <SkeletonLine minWidth={200} maxWidth={420} blockHeight={11} />
                </div>
              </div>
            ))}
          </section>
          <span className="sr-only">{label}</span>
        </main>
      </div>
    </div>
  )
}
