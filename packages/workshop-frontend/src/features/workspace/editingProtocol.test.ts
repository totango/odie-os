import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer, EditingProtocolStatus } from '@gadgets/workshop-shared/api'
import { negotiateEditing, requireCompatibleChat, requireEditingReady } from './editingProtocol'

describe('editing capability negotiation', () => {
  const peer = (state: EditingProtocolStatus['state'] = 'ready', protocol = 'git-ot-v1') => ({
    negotiateEditingProtocol: vi.fn<(protocol: string) => Promise<{ protocol: string; state: EditingProtocolStatus['state'] }>>(async () => ({ protocol, state })),
    getEditingProtocol: vi.fn<() => Promise<{ protocol: string; state: EditingProtocolStatus['state'] }>>(async () => ({ protocol, state })),
  })
  it('negotiates each new capability and shares only that capability’s pending handshake', async () => {
    const first = peer(), second = peer()
    await Promise.all([requireEditingReady(first as unknown as RpcStub<Overseer>), requireCompatibleChat(first as unknown as RpcStub<Overseer>)])
    expect(first.negotiateEditingProtocol).toHaveBeenCalledExactlyOnceWith('git-ot-v1')
    await requireEditingReady(second as unknown as RpcStub<Overseer>)
    expect(second.negotiateEditingProtocol).toHaveBeenCalledExactlyOnceWith('git-ot-v1')
  })
  it('permits compatible paused streams but no edits', async () => {
    const paused = peer('paused') as unknown as RpcStub<Overseer>
    await expect(requireCompatibleChat(paused)).resolves.toBeUndefined()
    await expect(requireEditingReady(paused)).rejects.toThrow('EDITING_CUTOVER_PAUSED')
  })
  it.each(['upgrade-required', 'read-only'] as const)('does not allow %s edits', async state => {
    await expect(requireEditingReady(peer(state) as unknown as RpcStub<Overseer>)).rejects.toThrow('EDITING_PROTOCOL_UPGRADE_REQUIRED')
  })
  it('rejects old/missing methods, unknown wire versions and malformed responses without interpreting a stream', async () => {
    for (const server of [{}, peer('ready', 'yjs-v0'), { negotiateEditingProtocol: async () => null }]) {
      const stub = server as unknown as RpcStub<Overseer>
      await expect(requireCompatibleChat(stub)).rejects.toThrow('EDITING_PROTOCOL_UPGRADE_REQUIRED')
      await expect(requireEditingReady(stub)).rejects.toThrow('EDITING_PROTOCOL_UPGRADE_REQUIRED')
    }
  })
  it('rechecks a new deployment pause and only renegotiates on an explicit retry', async () => {
    const server = peer()
    const stub = server as unknown as RpcStub<Overseer>
    await requireEditingReady(stub)
    server.getEditingProtocol.mockResolvedValue({ protocol: 'git-ot-v1', state: 'paused' })
    await expect(requireEditingReady(stub)).rejects.toThrow('EDITING_CUTOVER_PAUSED')
    await negotiateEditing(stub, true)
    expect(server.negotiateEditingProtocol).toHaveBeenCalledTimes(2)
  })
})
