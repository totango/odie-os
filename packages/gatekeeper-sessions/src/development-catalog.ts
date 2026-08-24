import type {
  CodingSessionDevelopmentCatalog,
  CodingSessionDevelopmentComponent,
  CodingSessionDevelopmentExecution,
  CodingSessionDevelopmentProfile,
  CodingSessionInstanceTier,
  CodingSessionRepository,
} from "@gadgets/workshop-shared/api";

/** Server-private execution details for one reviewed development component. */
export interface DevelopmentComponentDefinition extends CodingSessionDevelopmentComponent {
  /** Canonical localhost ports reserved by the component. Never included in the public catalog. */
  ports: number[];
  /** Components that cannot safely share one generation with this component. */
  conflictsWith?: string[];
}

/** Complete server-private development catalog used by the deterministic planner. */
export interface DevelopmentCatalogDefinition {
  revision: number;
  components: DevelopmentComponentDefinition[];
  profiles: CodingSessionDevelopmentProfile[];
  enabledTiers: CodingSessionInstanceTier[];
}

const NOT_YET_AVAILABLE = "Development-stack execution is not available in this deployment yet.";

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
    "Reviewed shared-development GraphQL, Agentic API, and authentication endpoints.",
    "external", [], [], "standard-1", [],
  ),
  component(
    "unison-frontend-shared", "Unison frontend with shared services",
    "Unison Vite development server backed by reviewed shared-development services.",
    "sandbox", ["agentic"], ["shared-development-services"], "standard-3", [5001],
    [{ id: "unison-shared", title: "Unison frontend", authority: "application", description: "Hot-reload Unison application." }],
  ),
  component(
    "agentic-core", "Agentic core",
    "Agentic databases, MCP, API, and realtime gateway.",
    "sandbox", ["agentic"], [], "standard-3", [3001, 3003, 4400, 55431, 6381],
    [{ id: "agentic-api", title: "Agentic API", authority: "application" }, { id: "agentic-gateway", title: "Agentic gateway", authority: "application" }],
  ),
  component(
    "leviosa-graphql", "Leviosa GraphQL",
    "Leviosa Postgres, Redis, migrations, and GraphQL/REST process.",
    "sandbox", ["leviosa-backend"], [], "standard-3", [3100, 9091, 55432, 6382],
    [{ id: "leviosa-graphql", title: "Leviosa GraphQL", authority: "application" }],
  ),
  component(
    "temporal-service", "Temporal service",
    "Shared Temporal persistence, server, namespaces, and search-attribute initialization.",
    "sandbox", [], [], "standard-3", [55435, 7233, 8085],
    [{ id: "temporal-ui", title: "Temporal UI", authority: "management" }],
  ),
  component(
    "leviosa-workflows", "Leviosa workflows",
    "A bounded reviewed set of Leviosa Temporal workflow workers.",
    "sandbox", ["leviosa-backend"], ["temporal-service"], "standard-3", [],
  ),
  component(
    "data-odi-clickhouse", "ODI ClickHouse",
    "Reviewed ClickHouse service and selected ODI migration and projection jobs.",
    "sandbox", ["leviosa-backend"], ["temporal-service"], "standard-3", [8123, 9000],
    [{ id: "clickhouse-play", title: "ClickHouse HTTP console", authority: "management", description: "Owner-only SQL authority." }],
  ),
  component(
    "integrations", "Integrations",
    "Integrations databases, Redis, LocalStack, API, and one reviewed worker.",
    "sandbox", ["unison-integrations"], ["temporal-service"], "standard-4",
    [3109, 9092, 9093, 55433, 55434, 6383, 4566],
    [{ id: "integrations-api", title: "Integrations API", authority: "application" }],
  ),
  component(
    "unison-frontend-local", "Unison frontend with local services",
    "Unison Vite development server configured for reviewed local Agentic and Leviosa services.",
    "sandbox", ["agentic"], ["agentic-core", "leviosa-graphql"], "standard-3", [5001],
    [{ id: "unison-local", title: "Unison frontend", authority: "application", description: "Hot-reload Unison application." }],
  ),
  component(
    "complete-external", "Complete external development environment",
    "Reviewed externally executed full product graph reached through a future narrow connector.",
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
  profile("frontend-shared", "Frontend with shared development services", "Fast Unison UI work against reviewed shared-development services.", ["unison-frontend-shared"], "standard-3"),
  profile("agentic-core", "Agentic core", "Agentic chat, tools, approvals, realtime, and reports.", ["agentic-core"], "standard-3"),
  profile("leviosa-graphql", "Leviosa GraphQL", "Core Unison GraphQL and REST data plane.", ["leviosa-graphql"], "standard-3"),
  profile("temporal-workflows", "Temporal workflows", "Selected asynchronous workflows and schedules.", ["leviosa-workflows"], "standard-3"),
  profile("data-odi-clickhouse", "ODI ClickHouse", "Selected ODI, semantic, and product-usage projections.", ["data-odi-clickhouse"], "standard-3"),
  profile("integrations", "Integrations", "Connector provisioning and one reviewed ingestion scenario.", ["integrations"], "standard-4"),
  profile(
    "complete-local", "Complete local product scenario",
    "Reviewed union of the audited local partial product stacks.",
    ["unison-frontend-local", "leviosa-workflows", "data-odi-clickhouse", "integrations"], "standard-4",
    "The complete local graph exceeds the public sandbox disk limit; use the external profile.",
  ),
  profile("complete-external", "Complete external product scenario", "Full product development graph in reviewed external ephemeral infrastructure.", ["complete-external"], "standard-1"),
];

/** Initial audited catalog. Only the historical terminal tier is enabled until pool supervision ships. */
export const DEVELOPMENT_CATALOG: DevelopmentCatalogDefinition = {
  revision: 1,
  components,
  profiles,
  enabledTiers: ["standard-1"],
};

/** Returns a fresh display-safe catalog projection with no execution-private fields. */
export function publicDevelopmentCatalog(
  catalog: DevelopmentCatalogDefinition = DEVELOPMENT_CATALOG,
): CodingSessionDevelopmentCatalog {
  return {
    revision: catalog.revision,
    enabledTiers: [...catalog.enabledTiers],
    components: catalog.components.map(({ ports: _ports, conflictsWith: _conflicts, ...entry }) => ({
      ...entry,
      requiredRepositories: [...entry.requiredRepositories],
      dependencyIds: [...entry.dependencyIds],
      applications: entry.applications.map(application => ({ ...application })),
    })),
    profiles: catalog.profiles.map(entry => ({ ...entry, componentIds: [...entry.componentIds] })),
  };
}
