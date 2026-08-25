import type {
  CodingSessionDevelopmentCatalog,
  CodingSessionDevelopmentComponent,
  CodingSessionDevelopmentExecution,
  CodingSessionDevelopmentProfile,
  CodingSessionInstanceTier,
  CodingSessionRepository,
} from "@gadgets/workshop-shared/api";
import { isCodingSessionRepository } from "@gadgets/workshop-shared/coding-sessions";

/** Ordered lifecycle phase for one server-private execution process. */
export type DevelopmentProcessPhase = "init" | "migration" | "seed" | "service";

/** One reviewed non-secret environment declaration for a process. */
export interface DevelopmentEnvironmentSpec {
  name: string;
  source:
    | { kind: "literal"; value: string }
    | { kind: "configuration"; requirement: string };
}

/** One exact server-private process definition. */
export interface DevelopmentProcessSpec {
  id: string;
  phase: DevelopmentProcessPhase;
  argv: string[];
  cwd: string;
  repository?: CodingSessionRepository;
  imageId?: string;
  environment: DevelopmentEnvironmentSpec[];
  /** Required declaration for every retry-safe one-shot lifecycle job. */
  idempotent?: true;
  /** Bounded remote lifetime required for every one-shot lifecycle job. */
  timeoutMs?: number;
}

/** One digest-pinned image available to the execution contract. */
export interface DevelopmentImageSpec {
  id: string;
  reference: string;
}

/** One private, unambiguous readiness or liveness probe for a service process. */
export type DevelopmentHealthSpec =
  | { processId: string; kind: "http"; port: number; path: string; statuses: number[]; timeoutMs: number }
  | { processId: string; kind: "tcp"; port: number; timeoutMs: number }
  | { processId: string; kind: "command"; argv: string[]; cwd: string; timeoutMs: number };

/** Private mapping from a public application to its exact reviewed listener. */
export interface DevelopmentApplicationSpec {
  applicationId: string;
  processId: string;
  port: number;
  protocols: Array<"http" | "websocket" | "sse">;
}

/** One reviewed outbound destination used by an execution contract. */
export interface DevelopmentEgressSpec {
  id: string;
  protocol: "https";
  host: string;
  port: 443;
  pathPrefixes: string[];
  methods: Array<"GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE">;
}

/** Complete private authority required before a component can be executable. */
export interface DevelopmentExecutionSpec {
  processes: DevelopmentProcessSpec[];
  images: DevelopmentImageSpec[];
  minimumDiskBytes: number;
  requirements: {
    configuration: string[];
    capabilities: string[];
  };
  readiness: DevelopmentHealthSpec[];
  liveness: DevelopmentHealthSpec[];
  applications: DevelopmentApplicationSpec[];
  logs: { maxBytes: number; maxLines: number };
  restart: { maxAttempts: number; backoffMs: number };
  stop: { processOrder: string[]; graceMs: number };
  dataDisposition: "disposable" | "checkpointable";
  egress: DevelopmentEgressSpec[];
}

/** Server-private definition for one planned or executable development component. */
export interface DevelopmentComponentDefinition extends CodingSessionDevelopmentComponent {
  /** Canonical localhost ports reserved by the component. Never included in the public catalog. */
  ports: number[];
  /** Components that cannot safely share one generation with this component. */
  conflictsWith?: string[];
  /** Full trusted authority contract. Required whenever this component is available. */
  executionSpec?: DevelopmentExecutionSpec;
}

/** Complete server-private development catalog used by the deterministic planner. */
export interface DevelopmentCatalogDefinition {
  revision: number;
  components: DevelopmentComponentDefinition[];
  profiles: CodingSessionDevelopmentProfile[];
  enabledTiers: CodingSessionInstanceTier[];
}

const TIERS = new Set<CodingSessionInstanceTier>(["standard-1", "standard-2", "standard-3", "standard-4"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_PATTERN = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DEVELOPMENT_JOB_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_DEVELOPMENT_STOP_GRACE_MS = 60_000;
const MAX_DEVELOPMENT_LOG_BYTES = 64 * 1024;
const MAX_DEVELOPMENT_LOG_LINES = 2_000;
const NOT_YET_AVAILABLE = "Development-stack execution is not available in this deployment yet.";
const COMPLETE_LOCAL_UNAVAILABLE = "The complete local stack exceeds the public sandbox disk limit. Use the complete external profile instead.";

function component(
  id: string,
  title: string,
  description: string,
  execution: CodingSessionDevelopmentExecution,
  requiredRepositories: CodingSessionRepository[],
  dependencyIds: string[],
  minimumTier: CodingSessionInstanceTier,
  ports: number[],
  applications: CodingSessionDevelopmentComponent["applications"] = [],
): DevelopmentComponentDefinition {
  return {
    id, revision: 1, title, description, available: false,
    unavailableReason: NOT_YET_AVAILABLE,
    execution, requiredRepositories, dependencyIds, minimumTier, applications, ports,
  };
}

const components: DevelopmentComponentDefinition[] = [
  component(
    "shared-development-services", "Shared development services",
    "Planned shared-development GraphQL, Agentic API, and authentication endpoints.",
    "external", [], [], "standard-1", [],
  ),
  component(
    "unison-frontend-shared", "Unison frontend with shared services",
    "Planned Unison Vite server backed by shared-development services.",
    "sandbox", ["agentic"], ["shared-development-services"], "standard-3", [5001],
    [{ id: "unison-shared", title: "Unison frontend", authority: "application", description: "Hot-reload Unison application." }],
  ),
  component(
    "agentic-core", "Agentic core",
    "Planned Agentic databases, MCP, API, and realtime gateway.",
    "sandbox", ["agentic"], [], "standard-3", [3001, 3003, 4400, 55431, 6381],
    [{ id: "agentic-api", title: "Agentic API", authority: "application" }, { id: "agentic-gateway", title: "Agentic gateway", authority: "application" }],
  ),
  component(
    "leviosa-graphql", "Leviosa GraphQL",
    "Planned Leviosa source database, Redis, migrations, and GraphQL/REST process.",
    "sandbox", ["leviosa-backend"], [], "standard-3", [3100, 9091, 55432, 6382],
    [{ id: "leviosa-graphql", title: "Leviosa GraphQL", authority: "application" }],
  ),
  component(
    "temporal-service", "Temporal service",
    "Planned Temporal persistence, server, namespaces, and search-attribute initialization.",
    "sandbox", [], [], "standard-3", [55435, 7233, 8085],
    [{ id: "temporal-ui", title: "Temporal UI", authority: "management" }],
  ),
  component(
    "leviosa-core-workflow-scenario", "Leviosa core workflow scenario",
    "Planned bounded Leviosa core workflow worker scenario.",
    "sandbox", ["leviosa-backend"], ["temporal-service", "leviosa-graphql"], "standard-3", [],
  ),
  component(
    "clickhouse-infrastructure", "ClickHouse infrastructure",
    "Planned shared ClickHouse infrastructure and deterministic initialization.",
    "sandbox", [], [], "standard-3", [8123, 9000],
    [{ id: "clickhouse-play", title: "ClickHouse HTTP console", authority: "management", description: "Owner-only SQL authority." }],
  ),
  component(
    "odi-projection-scenario", "ODI projection scenario",
    "Planned bounded ODI migration and projection worker scenario.",
    "sandbox", ["leviosa-backend"], ["clickhouse-infrastructure", "temporal-service", "leviosa-graphql"], "standard-3", [],
  ),
  component(
    "integrations-infrastructure", "Integrations infrastructure",
    "Planned Integrations Postgres, Timescale, Redis, and LocalStack services.",
    "sandbox", ["unison-integrations"], [], "standard-3", [55433, 55434, 6383, 4566],
  ),
  component(
    "integrations-api", "Integrations API",
    "Planned Integrations API backed by its local infrastructure.",
    "sandbox", ["unison-integrations"], ["integrations-infrastructure"], "standard-3", [3109, 9092],
    [{ id: "integrations-api", title: "Integrations API", authority: "application" }],
  ),
  component(
    "integrations-connector-landing-scenario", "Integrations connector landing scenario",
    "Planned bounded connector-provisioning and landing worker scenario.",
    "sandbox", ["unison-integrations"], ["integrations-api", "temporal-service"], "standard-4", [9093],
  ),
  component(
    "unison-frontend-local", "Unison frontend with local services",
    "Planned Unison Vite server configured for local Agentic and Leviosa services.",
    "sandbox", ["agentic"], ["agentic-core", "leviosa-graphql"], "standard-3", [5001],
    [{ id: "unison-local", title: "Unison frontend", authority: "application", description: "Hot-reload Unison application." }],
  ),
  component(
    "complete-external", "Complete external development environment",
    "Planned externally executed product graph reached through a future narrow connector.",
    "external", ["agentic", "leviosa-backend", "unison-integrations"], [], "standard-1", [],
    [{ id: "complete-external-app", title: "Complete product environment", authority: "application" }],
  ),
];

function profile(
  id: string,
  title: string,
  description: string,
  componentIds: string[],
  minimumTier: CodingSessionInstanceTier,
  unavailableReason = NOT_YET_AVAILABLE,
): CodingSessionDevelopmentProfile {
  return {
    id, revision: 1, title, description, available: false,
    unavailableReason, componentIds, minimumTier,
  };
}

const profiles: CodingSessionDevelopmentProfile[] = [
  profile("frontend-shared", "Frontend with shared development services", "Planned fast Unison UI stack against shared-development services.", ["unison-frontend-shared"], "standard-3"),
  profile("agentic-core", "Agentic core", "Planned Agentic chat, tools, approvals, realtime, and reports stack.", ["agentic-core"], "standard-3"),
  profile("leviosa-graphql", "Leviosa GraphQL", "Planned core Unison GraphQL and REST data plane.", ["leviosa-graphql"], "standard-3"),
  profile("temporal-workflows", "Temporal workflows", "Planned bounded Leviosa core workflow scenario.", ["leviosa-core-workflow-scenario"], "standard-3"),
  profile("data-odi-clickhouse", "ODI ClickHouse", "Planned bounded ODI projection scenario.", ["odi-projection-scenario"], "standard-3"),
  profile("integrations", "Integrations", "Planned connector provisioning and landing worker scenario.", ["integrations-connector-landing-scenario"], "standard-4"),
  profile("complete-local", "Complete local product scenario", "Planned union of the documented local partial stacks.", ["unison-frontend-local", "leviosa-core-workflow-scenario", "odi-projection-scenario", "integrations-connector-landing-scenario"], "standard-4", COMPLETE_LOCAL_UNAVAILABLE),
  profile("complete-external", "Complete external product scenario", "Planned product graph in external ephemeral infrastructure.", ["complete-external"], "standard-1"),
];

/** Initial planned catalog. Only legacy terminal capacity is enabled; no stack entry is executable. */
export const DEVELOPMENT_CATALOG: DevelopmentCatalogDefinition = {
  revision: 1,
  components,
  profiles,
  enabledTiers: ["standard-1"],
};

/** Validates structural integrity and every executable component's complete private authority spec. */
export function validateDevelopmentCatalog(catalog: DevelopmentCatalogDefinition): void {
  positiveInteger(catalog.revision, "Catalog revision");
  const componentIds = uniqueIds(catalog.components, "component");
  uniqueIds(catalog.profiles, "profile");
  const applicationIds = new Set<string>();

  let previousTier = -1;
  for (const tier of catalog.enabledTiers) {
    validTier(tier);
    const index = tierIndex(tier);
    if (index <= previousTier) throw new Error("Enabled tiers must be unique and canonically ordered.");
    previousTier = index;
  }

  for (const entry of catalog.components) {
    positiveInteger(entry.revision, `Component ${entry.id} revision`);
    validatePublicText(entry.title, 120, `Component ${entry.id} title`);
    validatePublicText(entry.description, 1_024, `Component ${entry.id} description`);
    validateAvailability(entry, `Component ${entry.id}`);
    validateRepositories(entry.requiredRepositories, `Component ${entry.id}`);
    validTier(entry.minimumTier);
    if (entry.execution !== "sandbox" && entry.execution !== "external") throw new Error(`Component ${entry.id} has an invalid execution location.`);
    if (new Set(entry.dependencyIds).size !== entry.dependencyIds.length) throw new Error(`Component ${entry.id} repeats a dependency.`);
    if (new Set(entry.conflictsWith ?? []).size !== (entry.conflictsWith ?? []).length) throw new Error(`Component ${entry.id} repeats a conflict.`);
    const ports = new Set<number>();
    for (const port of entry.ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Component ${entry.id} has an invalid port.`);
      if (ports.has(port)) throw new Error(`Component ${entry.id} repeats a port.`);
      ports.add(port);
    }
    for (const target of entry.dependencyIds) {
      if (!componentIds.has(target)) throw new Error(`Component ${entry.id} has an unknown dependency.`);
    }
    for (const target of entry.conflictsWith ?? []) {
      if (!componentIds.has(target) || target === entry.id) throw new Error(`Component ${entry.id} has an invalid conflict target.`);
    }
    for (const application of entry.applications) {
      validId(application.id, "application");
      validatePublicText(application.title, 120, `Application ${application.id} title`);
      if (application.description !== undefined) validatePublicText(application.description, 1_024, `Application ${application.id} description`);
      if (application.authority !== "application" && application.authority !== "management") throw new Error(`Application ${application.id} has invalid authority.`);
      if (applicationIds.has(application.id)) throw new Error(`Duplicate application ID: ${application.id}`);
      applicationIds.add(application.id);
    }
    if (entry.available && !entry.executionSpec) throw new Error(`Available component ${entry.id} lacks an execution spec.`);
    if (entry.available && entry.dependencyIds.some(id => !catalog.components.find(candidate => candidate.id === id)!.available)) {
      throw new Error(`Available component ${entry.id} depends on an unavailable component.`);
    }
    if (entry.executionSpec) validateExecutionSpec(entry, entry.executionSpec);
  }

  assertAcyclic(catalog.components);
  for (const entry of catalog.profiles) {
    positiveInteger(entry.revision, `Profile ${entry.id} revision`);
    validatePublicText(entry.title, 120, `Profile ${entry.id} title`);
    validatePublicText(entry.description, 1_024, `Profile ${entry.id} description`);
    validateAvailability(entry, `Profile ${entry.id}`);
    validTier(entry.minimumTier);
    if (new Set(entry.componentIds).size !== entry.componentIds.length) throw new Error(`Profile ${entry.id} repeats a component.`);
    for (const componentId of entry.componentIds) {
      if (!componentIds.has(componentId)) throw new Error(`Profile ${entry.id} has an unknown component.`);
    }
    if (entry.available && entry.componentIds.length === 0) throw new Error(`Available profile ${entry.id} is empty.`);
    if (entry.available && entry.componentIds.some(id => !catalog.components.find(candidate => candidate.id === id)!.available)) {
      throw new Error(`Available profile ${entry.id} selects an unavailable component.`);
    }
  }
}

function validateExecutionSpec(entry: DevelopmentComponentDefinition, spec: DevelopmentExecutionSpec): void {
  if (!spec || typeof spec !== "object") throw new Error(`Component ${entry.id} has an invalid execution spec.`);
  if (!Array.isArray(spec.processes) || spec.processes.length === 0 || !Array.isArray(spec.images) ||
      !Array.isArray(spec.readiness) || !Array.isArray(spec.liveness) || !Array.isArray(spec.applications) ||
      !Array.isArray(spec.egress)) {
    throw new Error(`Component ${entry.id} has an incomplete execution spec.`);
  }
  if (!spec.requirements || !Array.isArray(spec.requirements.configuration) || !Array.isArray(spec.requirements.capabilities)) {
    throw new Error(`Component ${entry.id} has invalid requirements.`);
  }
  if (!spec.logs || !spec.restart || !spec.stop || !Array.isArray(spec.stop.processOrder)) {
    throw new Error(`Component ${entry.id} has incomplete lifecycle policy.`);
  }
  if (spec.dataDisposition !== "disposable" && spec.dataDisposition !== "checkpointable") {
    throw new Error(`Component ${entry.id} has invalid data disposition.`);
  }
  if (!Number.isSafeInteger(spec.minimumDiskBytes) || spec.minimumDiskBytes <= 0) throw new Error(`Component ${entry.id} has invalid disk headroom.`);
  positiveInteger(spec.logs.maxBytes, `Component ${entry.id} log byte limit`);
  positiveInteger(spec.logs.maxLines, `Component ${entry.id} log line limit`);
  if (spec.logs.maxBytes > MAX_DEVELOPMENT_LOG_BYTES || spec.logs.maxLines > MAX_DEVELOPMENT_LOG_LINES) {
    throw new Error(`Component ${entry.id} log retention exceeds the durable storage bound.`);
  }
  if (!Number.isInteger(spec.restart.maxAttempts) || spec.restart.maxAttempts < 0) throw new Error(`Component ${entry.id} has invalid restart attempts.`);
  if (!Number.isInteger(spec.restart.backoffMs) || spec.restart.backoffMs < 0) throw new Error(`Component ${entry.id} has invalid restart backoff.`);
  positiveInteger(spec.stop.graceMs, `Component ${entry.id} stop grace`);
  if (spec.stop.graceMs > MAX_DEVELOPMENT_STOP_GRACE_MS) {
    throw new Error(`Component ${entry.id} stop grace exceeds the supervision bound.`);
  }

  uniqueIds(spec.processes, `process in ${entry.id}`);
  const imageIds = uniqueIds(spec.images, `image in ${entry.id}`);
  for (const image of spec.images) if (!IMAGE_PATTERN.test(image.reference)) throw new Error(`Image ${image.id} is not digest-pinned.`);
  const processPhases: DevelopmentProcessPhase[] = ["init", "migration", "seed", "service"];
  let previousPhase = -1;
  for (const process of spec.processes) {
    if (!["init", "migration", "seed", "service"].includes(process.phase)) throw new Error(`Process ${process.id} has invalid phase.`);
    const phase = processPhases.indexOf(process.phase);
    if (phase < previousPhase) throw new Error(`Component ${entry.id} has processes out of lifecycle order.`);
    previousPhase = phase;
    if (process.phase === "service") {
      if (process.idempotent !== undefined || process.timeoutMs !== undefined) {
        throw new Error(`Service process ${process.id} has one-shot declarations.`);
      }
    } else if (process.idempotent !== true || !Number.isSafeInteger(process.timeoutMs) || process.timeoutMs! <= 0 ||
        process.timeoutMs! > MAX_DEVELOPMENT_JOB_TIMEOUT_MS) {
      throw new Error(`One-shot process ${process.id} must be idempotent with a bounded timeout.`);
    }
    if (!Array.isArray(process.argv) || process.argv.length === 0 || process.argv.some(arg => typeof arg !== "string" || arg.length === 0)) throw new Error(`Process ${process.id} has invalid argv.`);
    if (typeof process.cwd !== "string" || !process.cwd.startsWith("/")) throw new Error(`Process ${process.id} must have an absolute cwd.`);
    if (process.repository && !entry.requiredRepositories.includes(process.repository)) throw new Error(`Process ${process.id} uses an undeclared repository.`);
    if (process.imageId && !imageIds.has(process.imageId)) throw new Error(`Process ${process.id} uses an undeclared image.`);
    if (!Array.isArray(process.environment)) throw new Error(`Process ${process.id} has invalid environment declarations.`);
    const environmentNames = new Set<string>();
    for (const variable of process.environment) {
      if (!variable || variable.name === "ODIE_SUPERVISION_MARKER" ||
          !ENV_NAME_PATTERN.test(variable.name) || environmentNames.has(variable.name)) {
        throw new Error(`Process ${process.id} has an invalid or duplicate environment name.`);
      }
      environmentNames.add(variable.name);
      if (variable.source.kind === "literal") {
        if (typeof variable.source.value !== "string" || variable.source.value.length > 4_096 || hasControlCharacters(variable.source.value)) {
          throw new Error(`Process ${process.id} has an invalid public environment value.`);
        }
      } else if (variable.source.kind === "configuration") {
        if (!spec.requirements.configuration.includes(variable.source.requirement)) {
          throw new Error(`Process ${process.id} references undeclared configuration.`);
        }
      } else {
        throw new Error(`Process ${process.id} has an invalid environment source.`);
      }
    }
  }
  const configuration = uniqueStrings(spec.requirements.configuration, `configuration requirement in ${entry.id}`);
  const capabilities = uniqueStrings(spec.requirements.capabilities, `capability requirement in ${entry.id}`);
  for (const requirement of [...configuration, ...capabilities]) validId(requirement, "requirement");
  const serviceIds = new Set(spec.processes.filter(process => process.phase === "service").map(process => process.id));
  for (const health of [...spec.readiness, ...spec.liveness]) {
    if (!health || !serviceIds.has(health.processId)) throw new Error(`Component ${entry.id} has a health check for a non-service process.`);
    if (!Number.isSafeInteger(health.timeoutMs) || health.timeoutMs <= 0 || health.timeoutMs > 300_000) {
      throw new Error(`Component ${entry.id} has an invalid health timeout.`);
    }
    if (health.kind === "http") {
      validPort(health.port, `Component ${entry.id} HTTP health port`);
      if (!entry.ports.includes(health.port)) throw new Error(`Component ${entry.id} HTTP health port is undeclared.`);
      if (!isSafePath(health.path) || health.path.length > 2_048 || !Array.isArray(health.statuses) ||
          health.statuses.length === 0 || new Set(health.statuses).size !== health.statuses.length ||
          health.statuses.some(status => !Number.isInteger(status) || status < 100 || status > 599) ||
          ![...health.statuses].toSorted((a, b) => a - b)
            .every((status, index, statuses) => index === 0 || status === statuses[index - 1]! + 1)) {
        throw new Error(`Component ${entry.id} has an invalid HTTP health check.`);
      }
    } else if (health.kind === "tcp") {
      validPort(health.port, `Component ${entry.id} TCP health port`);
      if (!entry.ports.includes(health.port)) throw new Error(`Component ${entry.id} TCP health port is undeclared.`);
    } else if (health.kind === "command") {
      if (!Array.isArray(health.argv) || health.argv.length === 0 ||
          health.argv.some(arg => typeof arg !== "string" || arg.length === 0) ||
          typeof health.cwd !== "string" || !health.cwd.startsWith("/")) {
        throw new Error(`Component ${entry.id} has an invalid command health check.`);
      }
    } else {
      throw new Error(`Component ${entry.id} has an invalid health check kind.`);
    }
  }
  const readinessProcesses = new Set(spec.readiness.map(health => health.processId));
  const livenessProcesses = new Set(spec.liveness.map(health => health.processId));
  if (spec.readiness.length !== serviceIds.size || readinessProcesses.size !== serviceIds.size ||
      [...serviceIds].some(id => !readinessProcesses.has(id))) {
    throw new Error(`Component ${entry.id} lacks readiness coverage for every service process.`);
  }
  if (spec.liveness.length !== serviceIds.size || livenessProcesses.size !== serviceIds.size ||
      [...serviceIds].some(id => !livenessProcesses.has(id))) {
    throw new Error(`Component ${entry.id} lacks liveness coverage for every service process.`);
  }

  const publicApplicationIds = new Set(entry.applications.map(application => application.id));
  const mappedApplicationIds = new Set<string>();
  for (const application of spec.applications) {
    if (!application || !publicApplicationIds.has(application.applicationId) ||
        mappedApplicationIds.has(application.applicationId)) {
      throw new Error(`Component ${entry.id} has an extra or duplicate application mapping.`);
    }
    mappedApplicationIds.add(application.applicationId);
    if (!serviceIds.has(application.processId)) throw new Error(`Component ${entry.id} maps an application to a non-service process.`);
    validPort(application.port, `Component ${entry.id} application port`);
    if (!entry.ports.includes(application.port)) throw new Error(`Component ${entry.id} application port is undeclared.`);
    if (!Array.isArray(application.protocols) || application.protocols.length === 0 ||
        new Set(application.protocols).size !== application.protocols.length ||
        application.protocols.some(protocol => !["http", "websocket", "sse"].includes(protocol))) {
      throw new Error(`Component ${entry.id} has invalid application protocols.`);
    }
  }
  if (mappedApplicationIds.size !== publicApplicationIds.size) {
    throw new Error(`Component ${entry.id} does not map every public application.`);
  }

  if (new Set(spec.stop.processOrder).size !== spec.stop.processOrder.length ||
      spec.stop.processOrder.some(id => !serviceIds.has(id)) || spec.stop.processOrder.length !== serviceIds.size) {
    throw new Error(`Component ${entry.id} has an invalid stop order.`);
  }
  const egressIds = new Set<string>();
  for (const rule of spec.egress) {
    if (!rule) throw new Error(`Component ${entry.id} has an invalid egress rule.`);
    validId(rule.id, `egress rule in ${entry.id}`);
    if (egressIds.has(rule.id)) throw new Error(`Component ${entry.id} repeats an egress rule ID.`);
    egressIds.add(rule.id);
    if (rule.protocol !== "https" || rule.port !== 443 || typeof rule.host !== "string" ||
        !HOST_PATTERN.test(rule.host) || rule.host === "localhost" || rule.host.endsWith(".localhost") ||
        !Array.isArray(rule.pathPrefixes) || rule.pathPrefixes.length === 0 ||
        new Set(rule.pathPrefixes).size !== rule.pathPrefixes.length ||
        rule.pathPrefixes.some(prefix => typeof prefix !== "string" || prefix.length > 2_048 || !isSafePath(prefix)) ||
        !Array.isArray(rule.methods) || rule.methods.length === 0 || new Set(rule.methods).size !== rule.methods.length ||
        rule.methods.some(method => !["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(method))) {
      throw new Error(`Component ${entry.id} has an invalid egress rule.`);
    }
  }
}

function validateRepositories(repositories: CodingSessionRepository[], label: string): void {
  if (new Set(repositories).size !== repositories.length ||
      repositories.some(repository => !isCodingSessionRepository(repository)) ||
      repositories.some((repository, index) => index > 0 && repositories[index - 1]! >= repository)) {
    throw new Error(`${label} repositories must be canonical, unique, and ordered.`);
  }
}

function validateAvailability(
  entry: { available: boolean; unavailableReason?: string },
  label: string,
): void {
  if (entry.available) {
    if (entry.unavailableReason !== undefined) throw new Error(`${label} is available but has an unavailable reason.`);
  } else {
    if (entry.unavailableReason === undefined) throw new Error(`${label} is unavailable without a reason.`);
    validatePublicText(entry.unavailableReason, 500, `${label} unavailable reason`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isSafePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !hasControlCharacters(value);
}

function validatePublicText(value: string, maximum: number, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || hasControlCharacters(value)) {
    throw new Error(`${label} must be bounded, nonempty display text.`);
  }
}

function validPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} is invalid.`);
}

function tierIndex(tier: CodingSessionInstanceTier): number {
  return ["standard-1", "standard-2", "standard-3", "standard-4"].indexOf(tier);
}

function uniqueStrings(values: string[], kind: string): string[] {
  if (values.some(value => typeof value !== "string") || new Set(values).size !== values.length) {
    throw new Error(`Duplicate or invalid ${kind}.`);
  }
  return values;
}

function uniqueIds(entries: Array<{ id: string }>, kind: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    validId(entry.id, kind);
    if (ids.has(entry.id)) throw new Error(`Duplicate ${kind} ID: ${entry.id}`);
    ids.add(entry.id);
  }
  return ids;
}

function validId(id: string, kind: string): void {
  if (!ID_PATTERN.test(id) || id.length > 64) throw new Error(`Invalid ${kind} ID.`);
}

function validTier(tier: CodingSessionInstanceTier): void {
  if (!TIERS.has(tier)) throw new Error(`Invalid development tier: ${tier}`);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function assertAcyclic(entries: DevelopmentComponentDefinition[]): void {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Development catalog dependency cycle includes ${id}.`);
    visiting.add(id);
    for (const dependencyId of byId.get(id)!.dependencyIds) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const entry of entries) visit(entry.id);
}

validateDevelopmentCatalog(DEVELOPMENT_CATALOG);
deepFreeze(DEVELOPMENT_CATALOG);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Returns a fresh display-safe catalog projection with no execution-private fields. */
export function publicDevelopmentCatalog(
  catalog: DevelopmentCatalogDefinition = DEVELOPMENT_CATALOG,
): CodingSessionDevelopmentCatalog {
  return {
    revision: catalog.revision,
    enabledTiers: [...catalog.enabledTiers],
    components: catalog.components.map(entry => ({
      id: entry.id,
      revision: entry.revision,
      title: entry.title,
      description: entry.description,
      available: entry.available,
      unavailableReason: entry.unavailableReason,
      execution: entry.execution,
      requiredRepositories: [...entry.requiredRepositories],
      dependencyIds: [...entry.dependencyIds],
      minimumTier: entry.minimumTier,
      applications: entry.applications.map(application => ({
        id: application.id,
        title: application.title,
        authority: application.authority,
        description: application.description,
      })),
    })),
    profiles: catalog.profiles.map(entry => ({
      id: entry.id,
      revision: entry.revision,
      title: entry.title,
      description: entry.description,
      available: entry.available,
      unavailableReason: entry.unavailableReason,
      componentIds: [...entry.componentIds],
      minimumTier: entry.minimumTier,
    })),
  };
}
