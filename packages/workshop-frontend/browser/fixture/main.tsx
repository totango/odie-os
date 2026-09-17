import { Activity, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import GadgetUI from '../../src/GadgetUI'
import { fixtureSessions } from './session-ledger'

const params = new URLSearchParams(location.search)
let releaseInitial: () => void = () => {}
const initialReady = params.has('initial')
  ? new Promise<void>(resolve => { releaseInitial = resolve })
  : Promise.resolve()

// This code runs inside GadgetUI's real opaque-origin sandbox and CSP. It cannot
// access parent DOM/storage. A boot beacon is telemetry, never a host capability.
const jsCode = `
document.documentElement.dataset.boot = crypto.randomUUID();
window.parent.postMessage({ type: 'continuity-fixture-boot' }, '*');
document.body.innerHTML = '<header style="position:sticky;top:0;background:white;padding:8px"><label>Unsaved draft <input aria-label="Unsaved draft"></label> <button id="read">Read server</button> <output id="result">idle</output></header><main style="height:2600px">Scroll state is document-local</main>';
document.querySelector('#read').onclick = async () => {
  document.querySelector('#result').textContent = 'pending';
  try { document.querySelector('#result').textContent = await gadget.read(); }
  catch (error) { document.querySelector('#result').textContent = 'error: ' + error.message; }
};
${params.has('immediate') ? "void document.querySelector('#read').onclick();" : ''}
`

class Server extends RpcTarget {
  constructor(private epoch: string) { super() }
  read() { return this.epoch }
}

function transport(epoch: string) {
  return fixtureSessions(() => {
  const { port1, port2 } = new MessageChannel()
  const server = newMessagePortRpcSession(port1, new Server(epoch))
  const rpcClient = newMessagePortRpcSession<Server>(port2)
  return {
    client: rpcClient,
    break() { server[Symbol.dispose](); rpcClient[Symbol.dispose]() },
  }
  })
}

let connections = 0
let current = transport('epoch-1')
let epoch = 1
const ownedClients: RpcStub<GadgetClient>[] = []
let releaseReplacement: (() => void) | undefined
const connectionCount = () => {
  connections++
  document.querySelector('#connections')!.textContent = String(connections)
}

// Only the two GadgetClient methods consumed by GadgetUI are implemented. The
// assertion is fixture-local; no runtime interface or arbitrary host bridge added.
class Client extends RpcTarget implements Pick<GadgetClient, 'getUiBundle' | 'connectToGadget'> {
  constructor(private ready: Promise<void> = Promise.resolve()) { super() }
  async getUiBundle() { return { jsCode } }
  async connectToGadget() {
    connectionCount()
    await this.ready
    return current.client.dup()
  }
}
function client(ready?: Promise<void>) {
  const stub = new RpcStub(new Client(ready)) as RpcStub<GadgetClient>
  ownedClients.push(stub)
  return stub
}

// The listener is outside Activity, so effect cleanup cannot hide a document boot.
let boots = 0
window.addEventListener('message', event => {
  if (event.source === document.querySelector('iframe')?.contentWindow &&
      event.origin === 'null' && event.data?.type === 'continuity-fixture-boot') {
    document.querySelector('#boots')!.textContent = String(++boots)
  }
})

function Fixture() {
  const [endpoint, setEndpoint] = useState(() => ({ stub: client(initialReady) }))
  const [hidden, setHidden] = useState(params.has('hidden'))
  const [mounted, setMounted] = useState(true)
  const [replacementPending, setReplacementPending] = useState(false)
  function replace(delayed: boolean) {
    current.break()
    const nextEpoch = `epoch-${++epoch}`
    let ready = Promise.resolve()
    if (delayed) {
      ready = new Promise<void>(resolve => {
        releaseReplacement = () => {
          current = transport(nextEpoch)
          resolve()
          setReplacementPending(false)
        }
      })
      setReplacementPending(true)
    } else {
      current = transport(nextEpoch)
    }
    setEndpoint({ stub: client(ready) })
  }
  return <>
    <h1>Continuity fixture (no backend)</h1>
    <p>Document boots: <output id="boots">0</output>; connections: <output id="connections">0</output></p>
    <button onClick={() => replace(false)}>Replace now</button>
    <button onClick={() => replace(true)}>Begin delayed replacement</button>
    <button disabled={!replacementPending} onClick={() => releaseReplacement?.()}>Release replacement</button>
    <button onClick={() => setHidden(true)}>Hide Activity</button>
    <button onClick={() => setHidden(false)}>Show Activity</button>
    <button onClick={() => releaseInitial()}>Release initial acquisition</button>
    <button onClick={() => {
      setMounted(false)
      current.break()
      for (const stub of ownedClients.splice(0)) stub[Symbol.dispose]()
    }}>Unmount fixture</button>
    <output id="visibility">{hidden ? 'hidden' : 'visible'}</output>
    {mounted && <Activity mode={hidden ? 'hidden' : 'visible'}>
      <GadgetUI gadget={endpoint.stub} height="420px" chatId={1} />
    </Activity>}
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
