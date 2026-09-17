import { Activity, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcTarget, RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import GadgetUI from '../../GadgetUI'

// Synthetic authority, real GadgetUI/bootstrap/opaque iframe and Cap'n Web MessagePorts.
const jsCode = `
document.documentElement.dataset.boot = crypto.randomUUID();
document.body.innerHTML = '<header style="position:sticky;top:0"><label>Draft <input aria-label="Draft"></label><button id="read">Read</button><output id="result">idle</output></header><div style="height:2400px">Scroll</div>';
document.querySelector('#read').onclick = async () => {
  document.querySelector('#result').textContent = 'pending';
  try { document.querySelector('#result').textContent = await gadget.read(); }
  catch { document.querySelector('#result').textContent = 'disconnected'; }
};
`
class Server extends RpcTarget {
  constructor(private epoch: number) { super() }
  read() { return `epoch-${this.epoch}` }
}
const client = (epoch: number) => ({
  getUiBundle: async () => ({ jsCode }),
  connectToGadget: async () => new RpcStub(new Server(epoch)),
}) as unknown as RpcStub<GadgetClient>

const Fixture = () => {
  const [hidden, setHidden] = useState(false)
  const [endpoint, setEndpoint] = useState(() => ({ epoch: 1, stub: client(1) }))
  return <>
    <button onClick={() => setHidden(true)}>Hide Activity</button>
    <button onClick={() => setHidden(false)}>Show Activity</button>
    <button onClick={() => setEndpoint(current => ({ epoch: current.epoch + 1, stub: client(current.epoch + 1) }))}>Replace authority</button>
    <Activity mode={hidden ? 'hidden' : 'visible'}><GadgetUI gadget={endpoint.stub} height="420px" /></Activity>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
