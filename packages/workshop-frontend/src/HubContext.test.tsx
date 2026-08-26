// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { FinanceHubStatus } from '@gadgets/workshop-shared/api'
import { HubProvider, useHub } from './HubContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe() {
  const { hub, selectHub } = useHub()
  return <button onClick={() => selectHub('revenue')}>{hub}</button>
}

describe('HubProvider', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    localStorage.clear()
  })

  async function render(
    enabledHubs: Array<'ops' | 'revenue' | 'support'>,
    financeStatus?: FinanceHubStatus | null,
  ) {
    container ??= document.createElement('div')
    if (!container.isConnected) document.body.append(container)
    root ??= createRoot(container)
    await act(async () => root!.render(
      <HubProvider enabledHubs={enabledHubs} financeStatus={financeStatus}><Probe /></HubProvider>,
    ))
  }

  it('starts in Ops, persists a selection, and falls back when it is disabled', async () => {
    await render(['ops', 'revenue', 'support'])
    expect(container!.textContent).toBe('ops')

    await act(async () => (container!.querySelector('button') as HTMLButtonElement).click())
    expect(container!.textContent).toBe('revenue')
    expect(localStorage.getItem('odie:selected-hub')).toBe('revenue')

    await render(['ops', 'support'])
    expect(container!.textContent).toBe('ops')
    expect(localStorage.getItem('odie:selected-hub')).toBe('ops')
  })

  it('fails closed when local storage names Finance without server entitlement', async () => {
    localStorage.setItem('odie:selected-hub', 'finance')
    await render(['ops', 'revenue', 'support'])
    expect(container!.textContent).toBe('ops')
    expect(localStorage.getItem('odie:selected-hub')).toBe('ops')
  })

  it('restores Finance only after an authorized server status', async () => {
    localStorage.setItem('odie:selected-hub', 'finance')
    await render(
      ['ops', 'revenue', 'support'],
      { authorized: true, workspaceId: 'finance-workspace', canCreate: false },
    )
    expect(container!.textContent).toBe('finance')
  })

  it('preserves a stored Finance preference while entitlement is loading', async () => {
    localStorage.setItem('odie:selected-hub', 'finance')
    await render(['ops', 'revenue', 'support'], null)
    expect(container!.textContent).toBe('ops')
    expect(localStorage.getItem('odie:selected-hub')).toBe('finance')

    await render(
      ['ops', 'revenue', 'support'],
      { authorized: true, workspaceId: 'finance-workspace', canCreate: false },
    )
    expect(container!.textContent).toBe('finance')
  })
})
