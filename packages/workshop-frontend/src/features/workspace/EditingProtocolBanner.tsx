import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { editingMessage, negotiateEditing, useEditingState } from './editingProtocol'
import { WorkshopButton } from '../../components/WorkshopControls'

export const EditingProtocolBanner = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
  const state = useEditingState(overseer)
  if (state === 'ready') return null
  return <div role="status" className="border-b border-kumo-line bg-kumo-base p-3 text-sm text-kumo-default">
    {editingMessage(state)} Export draft text from the composer or saved code from the Code tab. Nothing will be resent automatically.
    <WorkshopButton disabled={state === 'checking'} onClick={() => { void negotiateEditing(overseer, true) }}>Check compatibility again</WorkshopButton>
  </div>
}
