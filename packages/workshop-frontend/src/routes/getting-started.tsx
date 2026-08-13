import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { RpcTarget } from 'capnweb'
import {
  ArrowRight,
  CheckCircle,
  Code,
  Detective,
  GithubLogo,
  Lightning,
  Plugs,
  Robot,
  ShieldCheck,
  TerminalWindow,
  Warning,
} from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'
import { refreshGatekeeperApps } from '../useGatekeeperApps'
import type {
  AiChatAuthorInfo,
  ConnectedAccountsSubscriber,
  GatekeeperVendorInfo,
} from '@gadgets/workshop-shared/api'
import type {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'

export const Route = createFileRoute('/getting-started')({ component: GettingStartedPage })

const TEAM_PI_CODEX_PREFIX = 'team-pi-codex/'

type AccountEntry = {
  id: number
  accountDescription: AccountDescription
  vendorDescription: VendorDescription
  vendorId: string
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

type ReadinessState = {
  models: AiChatAuthorInfo[]
  accounts: AccountEntry[]
  vendors: GatekeeperVendorInfo[]
  addableGatekeepers: GatekeeperVendorInfo[]
  modelsLoaded: boolean
  accountsLoaded: boolean
  vendorsLoaded: boolean
  loadError: boolean
}

export function isTeamPiCodexModel(model: AiChatAuthorInfo): boolean {
  return model.id.startsWith(TEAM_PI_CODEX_PREFIX)
}

export function isJarvisAccount(account: AccountEntry): boolean {
  const haystack = `${account.vendorId} ${account.vendorDescription.displayName} ${account.accountDescription.singleton?.tsType ?? ''}`
  return !!account.accountDescription.singleton && /jarvis/i.test(haystack)
}

export function isTeamPiVendor(vendor: Pick<GatekeeperVendorInfo, 'id' | 'description'>): boolean {
  return /team[-_\s]?pi/i.test(`${vendor.id} ${vendor.description.displayName}`)
}

export function isTeamPiAccount(account: AccountEntry): boolean {
  return /team[-_\s]?pi/i.test(`${account.vendorId} ${account.vendorDescription.displayName}`)
}

function accountLabel(account: AccountEntry): string {
  return account.accountDescription.displayName ||
    account.accountDescription.uniqueName ||
    account.vendorDescription.displayName
}

function useGettingStartedReadiness(): ReadinessState {
  const { authenticatedApi } = useAuthenticatedApi()
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [accounts, setAccounts] = useState<AccountEntry[]>([])
  const [vendors, setVendors] = useState<GatekeeperVendorInfo[]>([])
  const [addableGatekeepers, setAddableGatekeepers] = useState<GatekeeperVendorInfo[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [vendorsLoaded, setVendorsLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const subscriptionRef = useRef<{ [Symbol.dispose](): void } | null>(null)

  useEffect(() => {
    let cancelled = false
    const accountMap = new Map<number, AccountEntry>()
    setModelsLoaded(false)
    setAccountsLoaded(false)
    setVendorsLoaded(false)
    setLoadError(false)
    setModels([])
    setAccounts([])
    setVendors([])
    setAddableGatekeepers([])

    authenticatedApi.listModels()
      .then((list) => { if (!cancelled) setModels(list) })
      .catch((err) => { console.error('Getting started: failed to load models', err); if (!cancelled) setLoadError(true) })
      .finally(() => { if (!cancelled) setModelsLoaded(true) })

    Promise.all([
      authenticatedApi.listGatekeeperVendors(),
      authenticatedApi.listAddableGatekeepers(),
    ])
      .then(([vendorList, addable]) => {
        if (cancelled) return
        setVendors(vendorList.filter((vendor) => !vendor.unavailable))
        setAddableGatekeepers(addable)
      })
      .catch((err) => { console.error('Getting started: failed to load gatekeeper vendors', err); if (!cancelled) setLoadError(true) })
      .finally(() => { if (!cancelled) setVendorsLoaded(true) })

    class AccountsSubscriber extends RpcTarget implements ConnectedAccountsSubscriber {
      add(
        id: number,
        description: AccountDescription,
        vendor: VendorDescription,
        supportedResources: SupportedResource[] = [],
        credentialsValid: boolean = true,
        vendorId: string = '',
      ) {
        if (cancelled) return
        accountMap.set(id, {
          id,
          accountDescription: description,
          vendorDescription: vendor,
          vendorId,
          supportedResources,
          credentialsValid,
        })
        setAccounts(Array.from(accountMap.values()))
      }

      remove(id: number) {
        accountMap.delete(id)
        if (!cancelled) setAccounts(Array.from(accountMap.values()))
      }

      ready() {
        if (!cancelled) setAccountsLoaded(true)
      }
    }

    const subscriber = new AccountsSubscriber()
    authenticatedApi.subscribeConnectedAccounts(subscriber, { includeForcedAutoProvisionedAccounts: true })
      .then((stub) => {
        if (cancelled) stub[Symbol.dispose]()
        else subscriptionRef.current = stub
      })
      .catch((err) => {
        console.error('Getting started: failed to subscribe to connected accounts', err)
        if (!cancelled) {
          setLoadError(true)
          setAccountsLoaded(true)
        }
      })

    return () => {
      cancelled = true
      subscriptionRef.current?.[Symbol.dispose]()
      subscriptionRef.current = null
    }
  }, [authenticatedApi])

  return { models, accounts, vendors, addableGatekeepers, modelsLoaded, accountsLoaded, vendorsLoaded, loadError }
}

function StatusPill({ state, children }: { state: 'ready' | 'pending' | 'warning'; children: React.ReactNode }) {
  const className = state === 'ready'
    ? 'bg-kumo-success-tint text-kumo-success'
    : state === 'warning'
      ? 'bg-kumo-warning-tint text-kumo-warning'
      : 'bg-kumo-tint text-kumo-subtle'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.35px] ${className}`}>
      {state === 'ready' ? <CheckCircle size={12} weight="fill" /> : state === 'warning' ? <Warning size={12} weight="fill" /> : null}
      {children}
    </span>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-kumo-line bg-kumo-base p-5 ${className}`}>{children}</section>
}

const INTERNAL_LINK_CLASS = 'inline-flex items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[13px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base'

function PromptLink({ prompt, children }: { prompt: string; children: React.ReactNode }) {
  return (
    <Link
      to="/"
      search={{ prompt }}
      className={INTERNAL_LINK_CLASS}
    >
      {children}
      <ArrowRight size={13} />
    </Link>
  )
}

function GatekeepersLink({ children }: { children: React.ReactNode }) {
  return (
    <Link to="/gatekeepers" className={INTERNAL_LINK_CLASS}>
      {children}
      <ArrowRight size={13} />
    </Link>
  )
}

// A card in "Where everything lives" that names one surface and links to it, so the page answers
// "where do I do this?" rather than only "is this configured?".
function PlaceCard(
  { icon, title, to, linkLabel, children }: {
    icon: React.ReactNode
    title: string
    to?: '/workspaces' | '/gatekeepers' | '/outputs' | '/blueprints' | '/admin'
    linkLabel?: string
    children: React.ReactNode
  },
) {
  return (
    <div className="flex gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-brand">{icon}</div>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold tracking-[-0.25px] text-kumo-default">{title}</h3>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">{children}</p>
        {to && (
          <span className="mt-3 block">
            <Link to={to} className={INTERNAL_LINK_CLASS}>
              {linkLabel ?? title}
              <ArrowRight size={13} />
            </Link>
          </span>
        )}
      </div>
    </div>
  )
}

function FlowStep({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-brand">{icon}</div>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold tracking-[-0.25px] text-kumo-default">{title}</h3>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">{children}</p>
      </div>
    </div>
  )
}

export function GettingStartedPage() {
  useDocumentTitle('Getting started')
  return <GettingStartedPageContent readiness={useGettingStartedReadiness()} />
}

export function GettingStartedPageContent({ readiness }: { readiness: ReadinessState }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [connectingVendor, setConnectingVendor] = useState<string>()
  const [setupError, setSetupError] = useState<string>()
  const teamPiModels = readiness.models.filter(isTeamPiCodexModel)
  const singletonAccounts = readiness.accounts.filter((account) => account.accountDescription.singleton)
  const teamPiAccounts = readiness.accounts.filter(isTeamPiAccount)
  const jarvisAccounts = readiness.accounts.filter((account) => isJarvisAccount(account) && account.credentialsValid)
  const connectableVendors = [...readiness.vendors, ...readiness.addableGatekeepers]
  const teamPiVendors = connectableVendors.filter(isTeamPiVendor)
  const accountsReady = readiness.accountsLoaded && readiness.accounts.length > 0
  const modelReady = readiness.modelsLoaded && teamPiModels.length > 0
  const teamPiVendorReady = readiness.vendorsLoaded && teamPiVendors.length > 0
  const githubAccounts = readiness.accounts.filter((account) => account.vendorId === 'github' && account.credentialsValid)
  const portalAccounts = readiness.accounts.filter((account) =>
    account.vendorId === 'mcp-portal' && account.credentialsValid)
  const teamPiReady = teamPiAccounts.some((account) => account.credentialsValid)
  const approvedWorkAppRouteReady = teamPiReady || portalAccounts.length > 0
  const portalVendorId = connectableVendors.find((candidate) => candidate.id === 'mcp-portal')?.id
  const workAppVendorId = teamPiVendors[0]?.id ?? portalVendorId
  const setupChecks = [githubAccounts.length > 0, jarvisAccounts.length > 0, approvedWorkAppRouteReady, modelReady]
  const completedSetupChecks = setupChecks.filter(Boolean).length

  const vendor = (id: string) => connectableVendors.find((candidate) => candidate.id === id)
  const addable = (id: string) => readiness.addableGatekeepers.find((candidate) => candidate.id === id)

  const connectVendor = async (vendorId: string) => {
    setConnectingVendor(vendorId)
    setSetupError(undefined)
    try {
      if (addable(vendorId)) {
        await authenticatedApi.provisionAmbientAccount(vendorId)
        refreshGatekeeperApps(authenticatedApi)
      } else {
        const { url } = await authenticatedApi.connectAccount(vendorId)
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : `Could not connect ${vendorId}.`)
    } finally {
      setConnectingVendor(undefined)
    }
  }

  return (
    <div className="min-h-full bg-kumo-base">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-8 sm:py-14">
        <header className="mb-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-end">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-kumo-line bg-kumo-elevated px-3 py-1 text-[12px] font-medium tracking-[-0.2px] text-kumo-subtle">
              <ShieldCheck size={13} className="text-kumo-brand" />
              First-party operating guide
            </div>
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-kumo-default sm:text-[38px]">
              Getting started with Odie, JARVIS, and Team PI
            </h1>
            <p className="mt-3 max-w-2xl text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
              Use the managed Codex model for code work, let JARVIS mediate production investigations,
              and connect TEAM_PI only through approval-gated actions. This page keeps those paths
              separate so prompts stay safe and auditable.
            </p>
          </div>
          <Card className="bg-kumo-elevated">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.65px] text-kumo-subtle">Live readiness</h2>
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-kumo-default">Team PI Codex model</span>
                <StatusPill state={modelReady ? 'ready' : readiness.modelsLoaded ? 'warning' : 'pending'}>
                  {modelReady ? 'Available' : readiness.modelsLoaded ? 'Missing' : 'Checking'}
                </StatusPill>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-kumo-default">Connected / forced accounts</span>
                <StatusPill state={accountsReady ? 'ready' : readiness.accountsLoaded ? 'warning' : 'pending'}>
                  {readiness.accountsLoaded ? `${readiness.accounts.length} found` : 'Subscribing'}
                </StatusPill>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-kumo-default">TEAM_PI vendor</span>
                <StatusPill state={teamPiVendorReady ? 'ready' : readiness.vendorsLoaded ? 'warning' : 'pending'}>
                  {teamPiVendorReady ? 'Available' : readiness.vendorsLoaded ? 'Missing' : 'Loading'}
                </StatusPill>
              </div>
            </div>
            {readiness.loadError && (
              <p className="mt-4 rounded-lg bg-kumo-danger-tint px-3 py-2 text-[12px] leading-4 text-kumo-danger">
                Some readiness checks failed. Refresh, confirm the WebSocket is connected, then try again.
              </p>
            )}
          </Card>
        </header>

        <Card className="mb-8 overflow-hidden !p-0">
          <div className="grid gap-6 border-b border-kumo-line bg-kumo-elevated p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-center">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.65px] text-kumo-brand">Developer setup</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.5px] text-kumo-default">Connect your engineering workbench</h2>
              <p className="mt-2 max-w-2xl text-[13px] leading-5 text-kumo-subtle">
                Connect source control, confirm the managed agent path, and choose an approved route to Jira and Zendesk. New OpenCode sessions inherit eligible JARVIS and MCP tools automatically.
              </p>
            </div>
            <div className="rounded-xl border border-kumo-line bg-kumo-base p-4">
              <div className="flex items-end justify-between gap-3">
                <div><span className="text-3xl font-semibold text-kumo-default">{completedSetupChecks}</span><span className="text-sm text-kumo-subtle"> / {setupChecks.length}</span></div>
                <StatusPill state={completedSetupChecks === setupChecks.length ? 'ready' : 'pending'}>
                  {completedSetupChecks === setupChecks.length ? 'Ready to build' : 'Setup in progress'}
                </StatusPill>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-kumo-fill">
                <div className="h-full rounded-full bg-kumo-brand transition-[width]" style={{ width: `${completedSetupChecks / setupChecks.length * 100}%` }} />
              </div>
            </div>
          </div>

          {setupError && <div className="border-b border-kumo-danger/20 bg-kumo-danger-tint px-5 py-3 text-xs text-kumo-danger">{setupError}</div>}

          <div className="grid divide-y divide-kumo-line lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <div className="space-y-3 p-5 sm:p-6">
              <DeveloperSetupStep
                icon={<GithubLogo size={17} />}
                title="Connect GitHub"
                description="Required for private repository clone, push authorization, pull requests, and coding sessions."
                ready={githubAccounts.length > 0}
                available={!!vendor('github')}
                actionLabel="Connect GitHub"
                busy={connectingVendor === 'github'}
                onAction={() => connectVendor('github')}
              />
              <DeveloperSetupStep
                icon={<Code size={17} />}
                title="Enable JARVIS"
                description="Provides approved repository knowledge and mediated production investigation tools. Deployment admins control availability."
                ready={jarvisAccounts.length > 0}
                available={!!addable('jarvis')}
                actionLabel="Enable JARVIS"
                busy={connectingVendor === 'jarvis'}
                onAction={() => connectVendor('jarvis')}
              />
              <DeveloperSetupStep
                icon={<Robot size={17} />}
                title="Confirm Team PI Codex"
                description="The managed model used by OpenCode sessions; no personal model credential is copied into the sandbox."
                ready={modelReady}
                available={false}
                actionLabel="Managed by admin"
              />
            </div>

            <div className="space-y-3 p-5 sm:p-6">
              <DeveloperSetupStep
                icon={<Plugs size={17} />}
                title="Route Jira and Zendesk"
                description={approvedWorkAppRouteReady
                  ? 'An approved Team PI or MCP Portal route is available. Finish Jira and Zendesk authorization inside that connector.'
                  : 'Use Team PI when available, or the deployment-configured MCP Portal. User-pasted MCP endpoints do not count as an approved Jira or Zendesk route.'}
                ready={approvedWorkAppRouteReady}
                available={!!workAppVendorId}
                actionLabel={teamPiVendors.length > 0 ? 'Connect Team PI' : 'Connect MCP Portal'}
                busy={connectingVendor === workAppVendorId}
                onAction={workAppVendorId ? () => connectVendor(workAppVendorId) : undefined}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Link to="/blueprint/$id" params={{ id: 'starter.developer-delivery-kit' }} className={`${INTERNAL_LINK_CLASS} !justify-between`}>
                  <span><span className="block text-[11px] font-semibold uppercase tracking-wide text-kumo-brand">Starter</span>Developer Delivery Kit</span>
                  <ArrowRight size={14} />
                </Link>
                <Link to="/sessions" className={`${INTERNAL_LINK_CLASS} !justify-between`}>
                  <span><span className="block text-[11px] font-semibold uppercase tracking-wide text-kumo-brand">Code</span>Open a coding session</span>
                  <TerminalWindow size={14} />
                </Link>
              </div>
              <p className="rounded-lg bg-kumo-tint px-3 py-2 text-[11px] leading-4 text-kumo-subtle">
                The Developer Delivery Kit is useful before every connector is ready. Add GitHub and work-app resources from its Connections tab when you want live data.
              </p>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-4">
          <Card className="lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">1. Use Team PI Codex for code changes</h2>
                <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
                  Team PI Codex is a deployment-managed model route. It is not a personal provider and it
                  never asks you for raw Codex credentials. Prompt links below only prepare text in the
                  composer — select Team PI Codex from the model menu before sending.
                </p>
              </div>
              <Robot size={24} className="shrink-0 text-kumo-brand" />
            </div>
            <div className="mt-4 rounded-xl bg-kumo-tint p-3 text-[13px] leading-[18px] text-kumo-subtle">
              {modelReady ? (
                <>Ready: {teamPiModels.map((model) => model.name).join(', ')}</>
              ) : readiness.modelsLoaded ? (
                <>Not shown in your model list. Use a connected internal account or ask an admin to verify Team PI Codex configuration and eligibility.</>
              ) : (
                <>Checking your model list…</>
              )}
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">2. Let ambient JARVIS provide repo knowledge</h2>
                <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
                  JARVIS is an ambient binding for codebase and repository context. Ask it for code and repo
                  knowledge; do not paste secrets or production payloads into prompts.
                </p>
              </div>
              <Code size={24} className="shrink-0 text-kumo-brand" />
            </div>
            <div className="mt-4 rounded-xl bg-kumo-tint p-3 text-[13px] leading-[18px] text-kumo-subtle">
              {jarvisAccounts.length > 0
                ? `Detected ${jarvisAccounts.map(accountLabel).join(', ')} as connected or deployment-forced.`
                : singletonAccounts.length > 0
                  ? `Singleton accounts detected: ${singletonAccounts.map(accountLabel).slice(0, 3).join(', ')}.`
                  : readiness.accountsLoaded
                    ? 'No ambient JARVIS-like account is visible yet. Check Gatekeepers or ask an admin whether it is forced for this deployment.'
                    : 'Subscribing to connected and forced accounts…'}
            </div>
            <div className="mt-3">
              <GatekeepersLink>Check Gatekeepers for JARVIS</GatekeepersLink>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">3. Investigate production through JARVIS</h2>
                <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
                  For production incidents, ask JARVIS to investigate. Never connect Odie directly to raw
                  production MCP endpoints or paste prod tokens. JARVIS is the mediated path for safe reads.
                </p>
              </div>
              <Detective size={24} className="shrink-0 text-kumo-brand" />
            </div>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-[13px] leading-[18px] text-kumo-subtle">
              <li>Ask for a scoped hypothesis, exact evidence, and links or trace IDs.</li>
              <li>Keep write/remediation steps as proposed actions for human approval.</li>
              <li>If JARVIS cannot reach the needed system, stop and ask for an approved connector path.</li>
            </ul>
            <div className="mt-4">
              <GatekeepersLink>Review approved connectors</GatekeepersLink>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">4. Use TEAM_PI for skills, connections, and providers</h2>
                <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
                  A user-connected TEAM_PI binding can read skills, connections, and provider metadata.
                  Install or start-connection operations must remain approval-gated.
                </p>
              </div>
              <Plugs size={24} className="shrink-0 text-kumo-brand" />
            </div>
            <div className="mt-4 rounded-xl bg-kumo-tint p-3 text-[13px] leading-[18px] text-kumo-subtle">
              {teamPiAccounts.length > 0
                ? `TEAM_PI-like account visible: ${teamPiAccounts.map(accountLabel).join(', ')}.`
                : teamPiVendorReady
                  ? 'If TEAM_PI is not connected, open Gatekeepers and connect it before asking for TEAM_PI reads.'
                  : readiness.vendorsLoaded
                    ? 'TEAM_PI is not listed as a connectable vendor for this account. Ask an admin to enable the approved vendor.'
                    : 'Loading TEAM_PI vendor readiness…'}
            </div>
            <div className="mt-3">
              <GatekeepersLink>Open Gatekeepers to connect TEAM_PI</GatekeepersLink>
            </div>
          </Card>
        </div>

        <section className="mt-8">
          <Card>
            <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">Where everything lives</h2>
            <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              The parts of this deployment and where to reach them.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <PlaceCard icon={<Robot size={16} weight="bold" />} title="Workspaces" to="/workspaces" linkLabel="Open workspaces">
                A workspace holds its conversations, anything the agent builds, and its own activity log.
                Work stays inside the workspace it happened in, so a workspace is the unit you share.
              </PlaceCard>
              <PlaceCard icon={<Code size={16} weight="bold" />} title="Gadgets">
                Ask the agent to build something and it appears in the pane beside the chat, with tabs for the
                running app, its code, and its connections. Gadgets are real apps: they keep data and can be
                given resources of their own.
              </PlaceCard>
              <PlaceCard icon={<Plugs size={16} weight="bold" />} title="Connectors" to="/gatekeepers" linkLabel="Open Connections">
                Connect an account once and the agent can use it. Each connector decides what it exposes, and
                only what you connect is reachable.
              </PlaceCard>
              <PlaceCard icon={<CheckCircle size={16} weight="bold" />} title="Outputs and blueprints" to="/outputs" linkLabel="Open outputs">
                Finished documents and other standard formats collect here. Blueprints are reusable starting
                points you can build a new workspace from.
              </PlaceCard>
              <PlaceCard icon={<ShieldCheck size={16} weight="bold" />} title="Activity and approvals">
                Every read the agent makes is recorded, and anything that would change an external system waits
                for you. The Activity button in a workspace lists whatever needs review.
              </PlaceCard>
              <PlaceCard icon={<Lightning size={16} weight="bold" />} title="Admin settings" to="/admin" linkLabel="Open admin">
                Administrators set the deployment name and logo, standing instructions for the agent, and which
                connectors are offered. Sign-in configuration deliberately lives outside this panel.
              </PlaceCard>
            </div>
          </Card>
        </section>

        <section className="mt-8">
          <Card>
            <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">How permission works</h2>
            <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              The agent can read a great deal on your behalf, but it cannot quietly change anything.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <FlowStep icon={<Detective size={16} weight="bold" />} title="Reads are recorded, not blocked">
                Looking something up happens immediately and is written to the workspace activity log, so you can
                always see what the agent saw.
              </FlowStep>
              <FlowStep icon={<ShieldCheck size={16} weight="bold" />} title="Changes wait for you">
                Anything that writes to an outside system is described first and applied only after you approve it.
                You can approve a kind of action once and let it run automatically afterwards; that choice is yours
                to make and to withdraw.
              </FlowStep>
              <FlowStep icon={<Warning size={16} weight="bold" />} title="Private data locks a workspace">
                Once a workspace reads someone&rsquo;s private data it stops being able to act, and it cannot be shared.
                That is deliberate. Start a fresh workspace for work that needs to act.
              </FlowStep>
              <FlowStep icon={<CheckCircle size={16} weight="bold" />} title="Buttons and forms are just messages">
                The agent may offer options, a form, a table, or a chart in the conversation. Answering one sends
                your reply as an ordinary message; it never performs an action on its own, so a change still comes
                back to you for approval.
              </FlowStep>
            </div>
          </Card>
        </section>

        <section className="mt-8 grid gap-4 lg:grid-cols-[1fr_1fr]">
          <Card>
            <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">Practical prompts</h2>
            <p className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              These links prefill the composer only. For Codex work, choose Team PI Codex in the model picker before you send.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <PromptLink prompt="Before sending, select Team PI Codex in the model picker. Then inspect this repo and propose a small, reviewable plan before making changes.">Prepare Codex prompt</PromptLink>
              <PromptLink prompt="Use ambient JARVIS repo knowledge to explain the architecture and point me to the files I should read first.">Ask JARVIS about the repo</PromptLink>
              <PromptLink prompt="Ask JARVIS to investigate the production issue through the approved mediated path. Do not use raw prod MCP. Return evidence and next actions only.">Investigate production safely</PromptLink>
              <PromptLink prompt="Use TEAM_PI for skills, connections, and provider reads. If an install or start-connection action is needed, queue it for approval.">Read TEAM_PI capabilities</PromptLink>
              <GatekeepersLink>Manage Gatekeepers</GatekeepersLink>
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold tracking-[-0.35px] text-kumo-default">Failure guidance</h2>
            <div className="mt-4 grid gap-3">
              <FlowStep icon={<Lightning size={16} weight="bold" />} title="Model missing">
                Confirm you are signed in with an eligible internal account. If it still is not listed,
                ask an admin to verify the Team PI Codex environment and model allowlist.
              </FlowStep>
              <FlowStep icon={<ShieldCheck size={16} weight="bold" />} title="JARVIS not available">
                Do not substitute raw production MCP. Use Gatekeepers to check connected or forced accounts,
                then ask an admin for the approved JARVIS binding.
                <span className="mt-3 block"><GatekeepersLink>Open Connections</GatekeepersLink></span>
              </FlowStep>
              <FlowStep icon={<Plugs size={16} weight="bold" />} title="TEAM_PI action blocked">
                Reads should work through the binding. Installs and start-connection actions are intentionally
                approval-gated; approve only after reviewing the proposed scope.
                <span className="mt-3 block"><GatekeepersLink>Open Connections</GatekeepersLink></span>
              </FlowStep>
            </div>
          </Card>
        </section>
      </div>
    </div>
  )
}

function DeveloperSetupStep({
  icon,
  title,
  description,
  ready,
  available,
  actionLabel,
  busy = false,
  onAction,
}: {
  icon: React.ReactNode
  title: string
  description: string
  ready: boolean
  available: boolean
  actionLabel: string
  busy?: boolean
  onAction?: () => void
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3.5">
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${ready ? 'bg-kumo-success-tint text-kumo-success' : 'bg-kumo-fill text-kumo-brand'}`}>
        {ready ? <CheckCircle size={17} weight="fill" /> : icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-kumo-default">{title}</h3>
          <StatusPill state={ready ? 'ready' : available ? 'pending' : 'warning'}>
            {ready ? 'Ready' : available ? 'Available' : 'Admin required'}
          </StatusPill>
        </div>
        <p className="mt-1 text-[12px] leading-[17px] text-kumo-subtle">{description}</p>
        {!ready && available && onAction && (
          <button type="button" onClick={onAction} disabled={busy} className="mt-2 text-[12px] font-medium text-kumo-link hover:underline disabled:opacity-50">
            {busy ? 'Opening…' : actionLabel} <ArrowRight size={11} className="inline" />
          </button>
        )}
      </div>
    </div>
  )
}
