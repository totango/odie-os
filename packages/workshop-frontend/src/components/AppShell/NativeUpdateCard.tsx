import { ArrowRight, DownloadSimple } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { getWorkshopRuntime } from '../../runtime'

type AvailableUpdate = { version: string }

const metadataPath = '/downloads/mac/OdieOS-latest.json'
const downloadPath = '/downloads/mac/OdieOS-latest.dmg'

function numericVersion(value: string): number[] | null {
  if (value.length > 32 || !/^\d+(?:\.\d+){0,3}$/.test(value)) return null
  return value.split('.').map(Number)
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = numericVersion(candidate)
  const installed = numericVersion(current)
  if (!next || !installed) return false
  for (let index = 0; index < Math.max(next.length, installed.length); index++) {
    const difference = (next[index] ?? 0) - (installed[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

export default function NativeUpdateCard({ collapsed }: { collapsed: boolean }) {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null)
  const runtime = getWorkshopRuntime()

  useEffect(() => {
    if (runtime.kind !== 'tauri') return
    let cancelled = false
    const check = async () => {
      const app = await runtime.getNativeAppInfo()
      if (app?.platform !== 'macos') return
      const response = await fetch(new URL(metadataPath, runtime.apiOrigin), { headers: { Accept: 'application/json' } })
      if (!response.ok) return
      const metadata = await response.json() as { version?: unknown }
      if (!cancelled && typeof metadata.version === 'string' && isNewerVersion(metadata.version, app.version)) {
        setUpdate({ version: metadata.version })
      }
    }
    check().catch(() => {})
    return () => { cancelled = true }
  }, [runtime])

  if (!update) return null
  const label = `Download Odie OS ${update.version} update`
  const download = () => runtime.openExternal(new URL(downloadPath, runtime.apiOrigin).toString()).catch(() => {})

  if (collapsed) {
    return (
      <button type="button" onClick={download} aria-label={label} title="Update available" className="flex h-9 w-9 items-center justify-center rounded-lg border border-kumo-line bg-kumo-base text-kumo-brand shadow-sm transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated">
        <DownloadSimple size={17} weight="bold" />
      </button>
    )
  }

  return (
    <button type="button" onClick={download} aria-label={label} className="group w-full rounded-xl border border-kumo-line bg-kumo-base p-3 text-left shadow-sm transition-colors hover:border-kumo-brand/40 hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated">
      <span className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-brand">
          <DownloadSimple size={16} weight="bold" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-4 text-kumo-default">Update available</span>
          <span className="mt-1 block text-[11px] leading-4 text-kumo-subtle">Odie OS {update.version} is ready</span>
        </span>
        <ArrowRight size={14} className="mt-1 shrink-0 text-kumo-inactive transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  )
}
