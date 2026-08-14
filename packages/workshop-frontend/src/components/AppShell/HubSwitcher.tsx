import { CaretDown } from '@phosphor-icons/react'
import { HUB_DETAILS, useHub } from '../../HubContext'

export default function HubSwitcher() {
  const { hub, enabledHubs, selectHub } = useHub()

  return (
    <label className="relative ml-2 flex items-center md:ml-0">
      <span className="sr-only">Active hub</span>
      <select
        aria-label="Active hub"
        value={hub}
        onChange={(event) => selectHub(event.target.value as typeof hub)}
        className="h-8 appearance-none rounded-lg border border-kumo-line bg-kumo-elevated py-1 pl-3 pr-8 text-[13px] font-semibold text-kumo-default outline-none transition-colors hover:bg-kumo-tint focus:border-kumo-brand focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base"
      >
        {enabledHubs.map((id) => (
          <option key={id} value={id}>{HUB_DETAILS[id].label}</option>
        ))}
        <option disabled>Finance (Coming soon)</option>
      </select>
      <CaretDown size={12} aria-hidden className="pointer-events-none absolute right-2.5 text-kumo-subtle" />
    </label>
  )
}
