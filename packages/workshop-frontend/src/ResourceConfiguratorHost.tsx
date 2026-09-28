import { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import { Activity, useState } from 'react'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

/** Renders the resource configurator slot inside the gatekeeper modal. */
export default function ResourceConfiguratorHost({
  frame,
  frameKey,
  loading,
  error,
  disabled,
  onCollectResourceUrlChange,
  onSelectionReadyChange,
  topOffset = 0,
  initialResourceUrl,
  resourceUrlPattern,
  resourceIdentity,
  frameIdentity,
  authorityAvailable = true,
  isAuthorityCurrent,
}: {
  frame: ResourceConfiguratorFrame | null
  frameKey: number | null
  loading: boolean
  error: string | null
  disabled: boolean
  onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
  onSelectionReadyChange?: (ready: boolean | null) => void
  topOffset?: number
  initialResourceUrl?: string
  resourceUrlPattern?: string
  /** Desired verified owner, exact account ID and resource scope. Changes on authority switches. */
  resourceIdentity?: string
  /** Identity verified at acquisition, not inferred from the current selection. */
  frameIdentity?: string
  /** Caller fence: the acquired frame belongs to the current verified API and selection. */
  authorityAvailable?: boolean
  /** Invocation-time fence, including acquisition cleanup and Activity suspension. */
  isAuthorityCurrent?: () => boolean
}) {
  const ready = authorityAvailable && !disabled && !loading && !error && frame !== null
    && (resourceIdentity === undefined || frameIdentity === resourceIdentity)
  const identity = resourceIdentity ?? String(frameKey)
  const [retained, setRetained] = useState<{ frame: ResourceConfiguratorFrame; identity: string } | null>(null)
  const current = ready && frame ? { frame, identity } : retained
  if (ready && frame && (retained?.frame !== frame || retained.identity !== identity)) setRetained({ frame, identity })
  // Retention is visual only. Pending/failed acquisition never grants the previous target.
  const compatible = resourceIdentity === undefined || current?.identity === resourceIdentity

  return <>
    {disabled ? <Placeholder>Choose an account before selecting a resource.</Placeholder>
      : loading ? <Placeholder>Loading configurator...</Placeholder>
      : error ? <Placeholder>{error}</Placeholder> : null}
    <Activity mode={ready && compatible ? 'visible' : 'hidden'}>
    {current && compatible && <SandboxedResourceConfigurator
    key={current.identity}
    frame={current.frame}
    resourceIdentity={resourceIdentity}
    authorityAvailable={ready}
    isAuthorityCurrent={isAuthorityCurrent}
    topOffset={topOffset}
    onCollectResourceUrlChange={onCollectResourceUrlChange}
    onSelectionReadyChange={onSelectionReadyChange}
    initialResourceUrl={initialResourceUrl}
    resourceUrlPattern={resourceUrlPattern}
  />}
    </Activity>
  </>
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-3 text-[12px] leading-4 text-kumo-subtle">
      {children}
    </section>
  )
}
