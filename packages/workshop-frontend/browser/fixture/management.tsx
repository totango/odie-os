import { Activity, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import CAPNWEB_BUNDLE from 'capnweb?raw'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import SandboxedGatekeeperApp from '../../src/SandboxedGatekeeperApp'
import { AuthProvider } from '../../src/AuthContext'
import { ThemeProvider } from '../../src/ThemeContext'
import { fixtureSessions } from './session-ledger'

// No external requests or arbitrary host bridge. Only the real component's
// existing handshake protocol and a synthetic read-only server capability.
const code = `
import { newMessagePortRpcSession } from 'data:text/javascript;base64,${btoa(CAPNWEB_BUNDLE)}';
const { port1, port2 } = new MessageChannel();
window.parent.postMessage({ type: 'handshake' }, '*', [port2]);
const host = newMessagePortRpcSession(port1);
document.documentElement.dataset.boot = crypto.randomUUID();
window.parent.postMessage({ type: 'continuity-fixture-boot' }, '*');
document.body.innerHTML = '<header style="position:sticky;top:0;background:white;padding:8px"><label>Unsaved draft <input aria-label="Unsaved draft"></label> <button id="read">Read server</button> <output id="result">idle</output></header><main style="height:2600px">Scroll state is document-local</main>';
document.querySelector('#read').onclick = async () => {
  document.querySelector('#result').textContent = 'pending';
  try { document.querySelector('#result').textContent = await host.ui.read(); }
  catch (error) { document.querySelector('#result').textContent = 'error: ' + error.message; }
};
`
const iframeHtml = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"></head><body><script type="module" src="data:text/javascript,${encodeURIComponent(code)}"></script></body></html>`

class Server extends RpcTarget {
  constructor(private epoch: string) { super() }
  read() { return this.epoch }
}
function transport(epoch: string) {
  return fixtureSessions(() => {
  const { port1, port2 } = new MessageChannel()
  const server = newMessagePortRpcSession(port1, new Server(epoch))
  return { server, ui: newMessagePortRpcSession<Server>(port2) }
  })
}
let current = transport('epoch-1')

// AuthProvider's real effects execute against this narrow, local synthetic API.
// No identity data or privileged capabilities are available to the test frame.
class FixtureAuth extends RpcTarget {
  async whoami(): Promise<never> { throw new Error('Fixture has no user identity') }
  async amIAdmin() { return false }
  async listGadgets() { return [] }
}
const authenticatedApi = new RpcStub(new FixtureAuth()) as RpcStub<AuthenticatedApi>
const noOp = () => {}

let boots = 0
window.addEventListener('message', event => {
  if (event.source === document.querySelector('iframe')?.contentWindow &&
      event.origin === 'null' && event.data?.type === 'continuity-fixture-boot') {
    document.querySelector('#boots')!.textContent = String(++boots)
  }
})

function Fixture() {
  const [frame, setFrame] = useState(() => ({ iframeHtml, ui: current.ui }))
  const [hidden, setHidden] = useState(false)
  const [mounted, setMounted] = useState(true)
  return <>
    <h1>Management continuity fixture (no backend)</h1>
    <p>Document boots: <output id="boots">0</output></p>
    <button onClick={() => {
      current.server[Symbol.dispose]()
      current.ui[Symbol.dispose]()
      current = transport('epoch-2')
      setFrame({ iframeHtml, ui: current.ui })
    }}>Replace capability</button>
    <button onClick={() => setHidden(true)}>Hide Activity</button>
    <button onClick={() => setHidden(false)}>Show Activity</button>
    <button onClick={() => setFrame({
      ...frame,
      iframeHtml: iframeHtml.replace('<html>', '<html data-version="2">'),
    })}>Publish HTML update</button>
    <button onClick={() => {
      setMounted(false)
      current.server[Symbol.dispose]()
      current.ui[Symbol.dispose]()
    }}>Unmount fixture</button>
    <ThemeProvider>
      <AuthProvider authenticatedApi={authenticatedApi} onLogout={noOp}>
        {mounted && <Activity mode={hidden ? 'hidden' : 'visible'}>
          <div style={{ height: 420 }}>
            <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="continuity-fixture" />
          </div>
        </Activity>}
      </AuthProvider>
    </ThemeProvider>
  </>
}

const router = createRouter({
  routeTree: createRootRoute({ component: Fixture }),
  history: createMemoryHistory({ initialEntries: ['/'] }),
})
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
