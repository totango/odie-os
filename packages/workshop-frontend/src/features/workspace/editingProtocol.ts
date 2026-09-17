import { useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import { WORKSHOP_EDITING_PROTOCOL, type EditingProtocolStatus, type Overseer } from '@gadgets/workshop-shared/api'

export type EditingState = EditingProtocolStatus['state'] | 'checking'
type Session = { state: EditingState; negotiation?: Promise<EditingProtocolStatus>; listeners: Set<() => void> }
const sessions = new WeakMap<object, Session>()
const sessionFor = (overseer: object): Session => {
  let session = sessions.get(overseer)
  if (!session) { session = { state: 'checking', listeners: new Set() }; sessions.set(overseer, session) }
  return session
}

export const editingFailureState = (error: unknown): 'paused' | 'upgrade-required' | undefined => {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('EDITING_CUTOVER_PAUSED')) return 'paused'
  if (message.includes('EDITING_PROTOCOL_UPGRADE_REQUIRED')) return 'upgrade-required'
}

export const editingMessage = (state: EditingState): string => state === 'paused'
  ? 'Editing is paused for a deployment update. Your input is preserved.'
  : state === 'read-only' ? 'This workspace is read-only.'
  : state === 'checking' ? 'Checking editing compatibility…'
  : 'This server and client cannot edit together. Export your input before choosing to reload.'

const publish = (overseer: object, state: EditingState) => {
  const session = sessionFor(overseer)
  if (session.state === state) return
  session.state = state
  session.listeners.forEach(listener => listener())
}

const validateStatus = (status: EditingProtocolStatus): EditingProtocolStatus => {
  if (status?.protocol !== WORKSHOP_EDITING_PROTOCOL ||
      !['ready', 'paused', 'read-only', 'upgrade-required'].includes(status.state)) {
    return { protocol: WORKSHOP_EDITING_PROTOCOL, state: 'upgrade-required' }
  }
  return status
}

/** Scoped to this exact capability, never to a workspace ID or an earlier authenticated epoch. */
export const negotiateEditing = (overseer: RpcStub<Overseer>, retry = false): Promise<EditingProtocolStatus> => {
  const session = sessionFor(overseer)
  if (retry) { session.negotiation = undefined; publish(overseer, 'checking') }
  session.negotiation ??= (async () => {
    try {
      const status = validateStatus(await overseer.negotiateEditingProtocol(WORKSHOP_EDITING_PROTOCOL))
      publish(overseer, status.state)
      return status
    } catch {
      // Missing methods on old backends and malformed peers fail closed without reloading.
      const status: EditingProtocolStatus = { protocol: WORKSHOP_EDITING_PROTOCOL, state: 'upgrade-required' }
      publish(overseer, status.state)
      return status
    }
  })()
  return session.negotiation
}

/** Recheck the deployment pause before a user-triggered mutation. Does not replay that mutation. */
export const requireEditingReady = async (overseer: RpcStub<Overseer>): Promise<void> => {
  let status = await negotiateEditing(overseer)
  if (status.state !== 'upgrade-required') {
    try { status = validateStatus(await overseer.getEditingProtocol()) }
    catch { status = { protocol: WORKSHOP_EDITING_PROTOCOL, state: 'upgrade-required' } }
    publish(overseer, status.state)
  }
  if (status.state !== 'ready') throw new Error(status.state === 'paused' ? 'EDITING_CUTOVER_PAUSED' : 'EDITING_PROTOCOL_UPGRADE_REQUIRED')
}

/** A compatible pause blocks writes, not the Git/OT chat stream. */
export const requireCompatibleChat = async (overseer: RpcStub<Overseer>): Promise<void> => {
  await negotiateEditing(overseer)
  const state = sessionFor(overseer).state
  if (state !== 'ready' && state !== 'paused') throw new Error('EDITING_PROTOCOL_UPGRADE_REQUIRED')
}

export const recordEditingFailure = (overseer: RpcStub<Overseer>, error: unknown): void => {
  const state = editingFailureState(error)
  if (state) publish(overseer, state)
}

export const useEditingState = (overseer: RpcStub<Overseer> | null): EditingState => useSyncExternalStore(
  listener => {
    if (!overseer) return () => {}
    const session = sessionFor(overseer)
    session.listeners.add(listener)
    return () => { session.listeners.delete(listener) }
  },
  () => overseer ? sessionFor(overseer).state : 'checking',
)
