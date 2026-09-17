// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { useAuth } from './useAuth'

vi.mock('./errorReporting', () => ({ setReportedUserId: vi.fn<(id?: string) => void>() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const auth = { current: undefined as ReturnType<typeof useAuth> | undefined }

function identity(id: string) {
  return { whoami: async () => ({ id, name: id, type: 'user' as const }),
    [Symbol.dispose]: vi.fn<() => void>(), switchAccountIdentity: vi.fn<(id: string) => Promise<unknown>>() }
}

function apiFor(source: ReturnType<typeof identity>) {
  return { authenticate: () => source, authenticateFromCfAccess: () => source } as unknown as RpcStub<PublicApi>
}

function captureAuth(value: ReturnType<typeof useAuth>) {
  auth.current = value
}

function Consumer({ api }: { api: RpcStub<PublicApi> }) {
  captureAuth(useAuth(api))
  return null
}

async function mount(api: RpcStub<PublicApi>) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  localStorage.setItem('authToken', 'login-one')
  await act(async () => root.render(<Consumer api={api} />))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  localStorage.clear()
})

it('disposes the previous capability, resets the identity boundary, and restores the choice on reconnect', async () => {
  const old = identity('a@totango.com')
  const collision = identity('a@heyodie.ai')
  old.switchAccountIdentity.mockResolvedValue(collision)
  await mount(apiFor(old))
  await act(async () => auth.current!.switchIdentity('a@heyodie.ai'))
  expect(auth.current!.authenticatedApi).toBe(collision)
  expect(auth.current!.identityRevision).toBe(1)
  expect(old[Symbol.dispose]).toHaveBeenCalled()
  const reconnected = identity('a@totango.com')
  const restored = identity('a@heyodie.ai')
  reconnected.switchAccountIdentity.mockResolvedValue(restored)
  await act(async () => root.render(<Consumer api={apiFor(reconnected)} />))
  expect(reconnected.switchAccountIdentity).toHaveBeenCalledWith('a@heyodie.ai')
  expect(reconnected[Symbol.dispose]).toHaveBeenCalled()
  expect(auth.current!.authenticatedApi).toBe(restored)
  expect(auth.current!.identityRevision).toBe(1)
})

it('does not carry a choice into a new login', async () => {
  const old = identity('a@totango.com')
  old.switchAccountIdentity.mockResolvedValue(identity('a@heyodie.ai'))
  await mount(apiFor(old))
  await act(async () => auth.current!.switchIdentity('a@heyodie.ai'))
  await act(async () => auth.current!.login('login-two'))
  expect(auth.current!.authenticatedApi).toBe(old)
  expect(old.switchAccountIdentity).toHaveBeenCalledTimes(1)
  expect(auth.current!.identityRevision).toBe(2)
})

it('disposes a late switch result after logout instead of restoring account access', async () => {
  const old = identity('a@totango.com')
  const collision = identity('a@heyodie.ai')
  let finish!: (value: typeof collision) => void
  old.switchAccountIdentity.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await mount(apiFor(old))
  let switching!: Promise<void>
  await act(async () => { switching = auth.current!.switchIdentity('a@heyodie.ai') })
  act(() => auth.current!.logout())
  await act(async () => {
    finish(collision)
    await expect(switching).rejects.toThrow('login changed')
  })
  expect(auth.current!.authenticatedApi).toBeNull()
  expect(collision[Symbol.dispose]).toHaveBeenCalledOnce()
})

it('keeps the current capability when the server denies switching', async () => {
  const old = identity('a@totango.com')
  old.switchAccountIdentity.mockRejectedValue(new Error('fresh SSO required'))
  await mount(apiFor(old))
  await act(async () => {
    await expect(auth.current!.switchIdentity('a@heyodie.ai')).rejects.toThrow('fresh SSO')
  })
  expect(auth.current!.authenticatedApi).toBe(old)
  expect(auth.current!.identityRevision).toBeUndefined()
})

it('replaces B state when a changed token scope reconnects to base A', async () => {
  const base = identity('A')
  const selected = identity('B')
  base.switchAccountIdentity.mockResolvedValue(selected)
  await mount(apiFor(base))
  await act(async () => auth.current!.switchIdentity('B'))
  expect(auth.current!.identityRevision).toBe(1)
  localStorage.setItem('authToken', 'rotated-login')
  const nextBase = identity('A')
  await act(async () => root.render(<Consumer api={apiFor(nextBase)} />))
  expect(nextBase.switchAccountIdentity).not.toHaveBeenCalled()
  expect(auth.current!.authenticatedApi).toBe(nextBase)
  expect(auth.current!.identityRevision).toBe(2)
})

it('verifies the selected result before publishing a switch', async () => {
  const base = identity('A')
  let finish!: (info: { id: string; name: string; type: 'user' }) => void
  const selected = { ...identity('B'), whoami: () => new Promise<{ id: string; name: string; type: 'user' }>(resolve => { finish = resolve }) }
  base.switchAccountIdentity.mockResolvedValue(selected)
  await mount(apiFor(base))
  let switching!: Promise<void>
  await act(async () => { switching = auth.current!.switchIdentity('B') })
  expect(auth.current!.authenticatedApi).toBe(base)
  expect(base[Symbol.dispose]).not.toHaveBeenCalled()
  await act(async () => { finish({ id: 'B', name: 'B', type: 'user' }); await switching })
  expect(auth.current!.authenticatedApi).toBe(selected)
  expect(base[Symbol.dispose]).toHaveBeenCalled()
})

it('fences the actual restored identity, not the requested identity or base login', async () => {
  const base = identity('A')
  base.switchAccountIdentity.mockResolvedValue(identity('B'))
  await mount(apiFor(base))
  await act(async () => auth.current!.switchIdentity('B'))
  const nextBase = identity('A')
  const different = identity('C')
  nextBase.switchAccountIdentity.mockResolvedValue(different)
  await act(async () => root.render(<Consumer api={apiFor(nextBase)} />))
  expect(auth.current!.authenticatedApi).toBe(different)
  expect(auth.current!.identityRevision).toBe(2)
})
