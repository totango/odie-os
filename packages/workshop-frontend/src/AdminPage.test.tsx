// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import { FinanceHubAdminRow } from './AdminPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FinanceHubAdminRow', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  async function render(admin: AdminApi) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<FinanceHubAdminRow admin={admin as never} />))
  }

  it('checks status without presenting Finance as a toggle', async () => {
    const admin = {
      diagnoseFinanceHub: vi.fn<AdminApi['diagnoseFinanceHub']>(
        async () => ({ status: 'healthy' as const }),
      ),
    } as unknown as AdminApi
    await render(admin)

    expect(container!.querySelector('input[type="checkbox"]')).toBeNull()
    expect(container!.textContent).toContain('Status not checked.')
    await act(async () => {
      Array.from(container!.querySelectorAll('button')).find(button => button.textContent === 'Check status')!.click()
    })
    expect(container!.textContent).toContain('Claim, workspace owner, and Finance registration are healthy.')
    expect(container!.textContent).not.toContain('Repair')
  })

  it('offers and applies only a server-approved repair', async () => {
    const admin = {
      diagnoseFinanceHub: vi.fn<AdminApi['diagnoseFinanceHub']>(async () => ({
        status: 'repairable',
        repair: 'missing-finance-origin',
      })),
      repairFinanceHub: vi.fn<AdminApi['repairFinanceHub']>(async () => ({
        repaired: true,
        diagnostic: { status: 'healthy' },
      })),
    } as unknown as AdminApi
    await render(admin)

    await act(async () => {
      Array.from(container!.querySelectorAll('button')).find(button => button.textContent === 'Check status')!.click()
    })
    expect(container!.textContent).toContain('missing its Finance origin')
    await act(async () => {
      Array.from(container!.querySelectorAll('button')).find(button => button.textContent === 'Repair')!.click()
    })
    expect(admin.repairFinanceHub).toHaveBeenCalledOnce()
    expect(container!.textContent).toContain('Finance registration are healthy.')
    expect(container!.textContent).not.toContain('Repair')
  })

  it('describes uninitialized Finance recovery as bundled app restoration', async () => {
    const admin = {
      diagnoseFinanceHub: vi.fn<AdminApi['diagnoseFinanceHub']>(async () => ({
        status: 'repairable',
        repair: 'uninitialized-workspace',
      })),
      repairFinanceHub: vi.fn<AdminApi['repairFinanceHub']>(async () => ({
        repaired: true,
        diagnostic: { status: 'healthy' },
      })),
    } as unknown as AdminApi
    await render(admin)

    await act(async () => {
      Array.from(container!.querySelectorAll('button')).find(button => button.textContent === 'Check status')!.click()
    })
    expect(container!.textContent).toContain('restored from the bundled Finance application')
    expect(container!.textContent).toContain('Repair')
  })

  it('shows incomplete blueprint initialization as blocked', async () => {
    const admin = {
      diagnoseFinanceHub: vi.fn<AdminApi['diagnoseFinanceHub']>(async () => ({
        status: 'blocked',
        reason: 'incomplete-workspace',
      })),
    } as unknown as AdminApi
    await render(admin)

    await act(async () => {
      Array.from(container!.querySelectorAll('button')).find(button => button.textContent === 'Check status')!.click()
    })
    expect(container!.textContent).toContain('did not complete Finance blueprint initialization')
    expect(container!.textContent).not.toContain('Repair')
  })
})
