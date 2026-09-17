// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AuthProvider, useAuthenticatedApi } from './AuthContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('does not lend a previous API admin result to its replacement', async () => {
  let resolve!: (value: boolean) => void
  const pending = new Promise<boolean>(done => { resolve = done })
  const api = (admin: Promise<boolean>) => ({
    whoami: async () => ({ type: 'user', id: 'owner', name: 'Owner' }),
    amIAdmin: () => admin,
  }) as unknown as RpcStub<AuthenticatedApi>
  function Probe() { return <p>{useAuthenticatedApi().isAdmin ? 'admin' : 'ordinary'}</p> }
  const container = document.createElement('div')
  const root = createRoot(container)
  const render = async (authenticatedApi: RpcStub<AuthenticatedApi>) => {
    await act(async () => root.render(<AuthProvider authenticatedApi={authenticatedApi} onLogout={() => {}}>
      <Probe />
    </AuthProvider>))
  }
  try {
    await render(api(Promise.resolve(true)))
    expect(container.textContent).toBe('admin')
    await render(api(pending))
    expect(container.textContent).toBe('ordinary')
    await render(api(Promise.resolve(false)))
    await act(async () => resolve(true))
    expect(container.textContent).toBe('ordinary')
  } finally {
    act(() => root.unmount())
  }
})
