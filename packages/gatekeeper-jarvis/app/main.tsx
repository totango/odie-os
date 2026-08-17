import { createRoot } from "react-dom/client";
import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "capnweb";
import { useEffect, useState } from "react";
import type { GatekeeperAppTheme, GatekeeperAppThemeReceiver } from "@gadgets/workshop-shared/theme";
import { applyAccentColor } from "@gadgets/workshop-shared/theme";
import {
  JARVIS_SETTINGS_TOOLS,
  type JarvisToolPolicy,
  type JarvisToolPolicyInput,
} from "../src/policy-types";
import "./styles.css";

type PolicyApi = {
  get(): Promise<JarvisToolPolicy>;
  update(input: JarvisToolPolicyInput): Promise<JarvisToolPolicy>;
};
const PRODUCTION_DIAGNOSTICS_TOOL = "jarvis_call_prod_tool";

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<PolicyApi>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
}

function applyTheme(theme: GatekeeperAppTheme) {
  document.documentElement.dataset.mode = theme.mode;
  document.documentElement.style.colorScheme = theme.mode;
  applyAccentColor(document.documentElement.style, theme.accentColor);
}

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void { applyTheme(theme); }
}

function ToolList({ selected, onChange, disabled = false }: {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  return <div className="grid gap-2 sm:grid-cols-2">
    {JARVIS_SETTINGS_TOOLS.map(name => <label key={name} className="flex items-start gap-2 rounded-lg border border-kumo-line bg-kumo-control p-3 text-sm">
      <input type="checkbox" checked={selected.has(name)} disabled={disabled}
        onChange={event => {
          const next = new Set(selected);
          if (event.target.checked) next.add(name); else next.delete(name);
          onChange(next);
        }} />
      <code className="break-all">{name}</code>
    </label>)}
  </div>;
}

function App({ api }: { api: RpcStub<PolicyApi> }) {
  const [chat, setChat] = useState(new Set<string>());
  const [code, setCode] = useState(new Set<string>());
  const [syncCode, setSyncCode] = useState(true);
  const [revision, setRevision] = useState<number>();
  const [status, setStatus] = useState("Loading policy...");

  useEffect(() => {
    api.get().then(policy => {
      setChat(new Set((policy.chat.tools ?? []).filter(tool => tool !== PRODUCTION_DIAGNOSTICS_TOOL)));
      setCode(new Set(policy.code.tools ?? []));
      setSyncCode(policy.syncCode && !policy.code.tools?.includes(PRODUCTION_DIAGNOSTICS_TOOL));
      setRevision(policy.revision);
      setStatus("");
    }).catch(error => setStatus(error instanceof Error ? error.message : String(error)));
  }, [api]);

  async function save() {
    setStatus("Saving...");
    try {
      const policy = await api.update({
        chatTools: [...chat],
        syncCode: syncCode && !code.has(PRODUCTION_DIAGNOSTICS_TOOL),
        codeTools: [...code],
      });
      setChat(new Set(policy.chat.tools ?? []));
      setCode(new Set(policy.code.tools ?? []));
      setRevision(policy.revision);
      setStatus(`Saved revision ${policy.revision}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return <main className="mx-auto max-w-4xl space-y-7 p-5 sm:p-8">
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-kumo-subtle">Deployment policy</p>
      <h1 className="text-3xl font-semibold">JARVIS tool permissions</h1>
      <p className="max-w-2xl text-sm text-kumo-subtle">Saving mints revision {revision === undefined ? "..." : revision + 1}. Existing chats and gadget bindings keep their immutable facet IDs and scopes; only newly minted ambient facets use the new policy.</p>
    </header>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Chat and agent tools</h2><ToolList selected={chat} onChange={setChat} /></section>
    <section className="space-y-3">
      <label className="flex items-center gap-3 rounded-xl bg-kumo-tint p-4"><input type="checkbox" checked={syncCode} disabled={code.has(PRODUCTION_DIAGNOSTICS_TOOL)} onChange={event => setSyncCode(event.target.checked)} /><span><strong>Code mirrors chat</strong><span className="block text-sm text-kumo-subtle">Disable to maintain a separate persistent gadget-code scope.</span></span></label>
      <label className="flex items-center gap-3 rounded-xl bg-kumo-tint p-4">
        <input type="checkbox" checked={code.has(PRODUCTION_DIAGNOSTICS_TOOL)} onChange={event => {
          const next = new Set(syncCode ? chat : code);
          if (event.target.checked) {
            next.add(PRODUCTION_DIAGNOSTICS_TOOL);
            setSyncCode(false);
          } else {
            next.delete(PRODUCTION_DIAGNOSTICS_TOOL);
          }
          setCode(next);
        }} />
        <span><strong>Production diagnostics for coding sessions</strong><span className="block text-sm text-kumo-subtle">Allow code sessions to request approval-gated JARVIS calls to production logs, databases, traces, and Kubernetes tools.</span></span>
      </label>
      <h2 className="text-lg font-semibold">Persistent gadget code tools</h2>
      <ToolList selected={syncCode ? chat : code} onChange={setCode} disabled={syncCode} />
    </section>
    <div className="flex items-center gap-4"><button className="rounded-lg bg-kumo-brand px-4 py-2 font-semibold text-white disabled:opacity-50" disabled={revision === undefined || status === "Saving..."} onClick={save}>Save policy</button><span className="text-sm text-kumo-subtle" role="status">{status}</span></div>
  </main>;
}

const element = document.getElementById("root");
if (!element) throw new Error("Missing JARVIS app root.");
const { port1, port2 } = new MessageChannel();
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
const iframe = new AppIframe();
const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
host.subscribeTheme(iframe).then(applyTheme).catch(() => {});
createRoot(element).render(<App api={host.ui} />);
