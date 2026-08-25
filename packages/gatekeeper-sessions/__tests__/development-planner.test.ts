import { describe, expect, it } from "vitest";
import type { CodingSessionDevelopmentProfile, CodingSessionInstanceTier } from "@gadgets/workshop-shared/api";
import {
  DEVELOPMENT_CATALOG,
  publicDevelopmentCatalog,
  validateDevelopmentCatalog,
  type DevelopmentCatalogDefinition,
  type DevelopmentComponentDefinition,
  type DevelopmentExecutionSpec,
} from "../src/development-catalog.js";
import { planDevelopmentStack } from "../src/development-planner.js";

const openCapacity = {
  "standard-1": { available: true, active: 1, limit: 5 },
  "standard-2": { available: true, active: 0, limit: 3 },
  "standard-3": { available: true, active: 0, limit: 2 },
  "standard-4": { available: true, active: 0, limit: 1 },
} as const;

const openContext = {
  diskBytesByTier: {
    "standard-1": 1_000_000,
    "standard-2": 1_000_000,
    "standard-3": 1_000_000,
    "standard-4": 1_000_000,
  },
};

function component(
  id: string,
  options: Partial<DevelopmentComponentDefinition> = {},
): DevelopmentComponentDefinition {
  const definition: DevelopmentComponentDefinition = {
    id,
    revision: 1,
    title: id,
    description: `${id} description`,
    available: true,
    execution: "sandbox",
    requiredRepositories: [],
    dependencyIds: [],
    minimumTier: "standard-1",
    applications: [],
    ports: [],
    ...options,
  };
  if (!Object.prototype.hasOwnProperty.call(options, "executionSpec") && definition.available) {
    definition.executionSpec = executionSpec({
      applications: definition.applications.map(application => ({
        applicationId: application.id,
        processId: "service",
        port: definition.ports[0]!,
        protocols: ["http"],
      })),
    });
  }
  return definition;
}

function executionSpec(overrides: Partial<DevelopmentExecutionSpec> = {}): DevelopmentExecutionSpec {
  return {
    processes: [{ id: "service", phase: "service", argv: ["bin/service"], cwd: "/workspace", environment: [] }],
    images: [],
    minimumDiskBytes: 1,
    requirements: { configuration: [], capabilities: [] },
    readiness: [{ processId: "service", kind: "command", argv: ["bin/ready"], cwd: "/workspace", timeoutMs: 1_000 }],
    liveness: [{ processId: "service", kind: "command", argv: ["bin/live"], cwd: "/workspace", timeoutMs: 1_000 }],
    applications: [],
    logs: { maxBytes: 1, maxLines: 1 },
    restart: { maxAttempts: 0, backoffMs: 0 },
    stop: { processOrder: ["service"], graceMs: 1 },
    dataDisposition: "disposable",
    egress: [],
    ...overrides,
  };
}

function profile(
  id: string,
  componentIds: string[],
  minimumTier: CodingSessionInstanceTier = "standard-1",
): CodingSessionDevelopmentProfile {
  return {
    id, revision: 1, title: id, description: `${id} description`, available: true,
    componentIds, minimumTier,
  };
}

function catalog(
  components: DevelopmentComponentDefinition[],
  profiles: CodingSessionDevelopmentProfile[] = [],
  enabledTiers: CodingSessionInstanceTier[] = ["standard-1", "standard-2", "standard-3", "standard-4"],
): DevelopmentCatalogDefinition {
  return { revision: 7, components, profiles, enabledTiers };
}

describe("development catalog", () => {
  it("projects every planned partial and complete profile without private execution fields", () => {
    const projected = publicDevelopmentCatalog();
    expect(projected.profiles.map(entry => entry.id)).toEqual([
      "frontend-shared", "agentic-core", "leviosa-graphql", "temporal-workflows",
      "data-odi-clickhouse", "integrations", "complete-local", "complete-external",
    ]);
    expect(projected.components.map(entry => entry.id)).toEqual([
      "shared-development-services", "unison-frontend-shared", "agentic-core", "leviosa-graphql",
      "temporal-service", "leviosa-core-workflow-scenario", "clickhouse-infrastructure",
      "odi-projection-scenario", "integrations-infrastructure", "integrations-api",
      "integrations-connector-landing-scenario", "unison-frontend-local", "complete-external",
    ]);
    expect(projected.profiles.every(entry => !entry.available)).toBe(true);
    expect(projected.components.every(entry => !entry.available)).toBe(true);
    expect(projected.enabledTiers).toEqual(["standard-1"]);
    expect(projected.components.find(entry => entry.id === "complete-external")?.execution).toBe("external");
    expect(projected.profiles.find(entry => entry.id === "complete-local")?.unavailableReason)
      .toContain("exceeds the public sandbox disk limit");
    for (const entry of projected.components) {
      expect(entry).not.toHaveProperty("ports");
      expect(entry).not.toHaveProperty("conflictsWith");
      expect(entry).not.toHaveProperty("command");
      expect(entry).not.toHaveProperty("env");
      for (const application of entry.applications) {
        expect(["application", "management"]).toContain(application.authority);
      }
    }
  });

  it("uses an explicit public allowlist that excludes populated and future private fields", () => {
    const privateEntry = component("private", {
      ports: [4321],
      conflictsWith: ["other"],
      applications: [{ id: "private-app", title: "Private app", authority: "application" }],
      executionSpec: executionSpec({ applications: [{
        applicationId: "private-app", processId: "service", port: 4321, protocols: ["http", "websocket"],
      }] }),
    }) as DevelopmentComponentDefinition & { futurePrivate?: string };
    privateEntry.futurePrivate = "must-not-leak";
    const projected = publicDevelopmentCatalog(catalog([privateEntry, component("other")]));
    const entry = projected.components[0] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty("ports");
    expect(entry).not.toHaveProperty("conflictsWith");
    expect(entry).not.toHaveProperty("executionSpec");
    expect(entry).not.toHaveProperty("futurePrivate");
  });

  it("returns a fresh projection that cannot mutate the server catalog", () => {
    const first = publicDevelopmentCatalog();
    first.components[0]!.dependencyIds.push("mutated");
    first.profiles[0]!.componentIds.push("mutated");
    const second = publicDevelopmentCatalog();
    expect(second.components[0]!.dependencyIds).not.toContain("mutated");
    expect(second.profiles[0]!.componentIds).not.toContain("mutated");
  });
});

describe("development catalog integrity", () => {
  it("accepts the planned deployment catalog", () => {
    expect(() => validateDevelopmentCatalog(DEVELOPMENT_CATALOG)).not.toThrow();
  });

  it.each([
    ["duplicate component", () => catalog([component("same"), component("same")])],
    ["duplicate profile", () => catalog([], [profile("same", []), profile("same", [])])],
    ["duplicate application", () => catalog([
      component("a", { ports: [80], applications: [{ id: "app", title: "A", authority: "application" }] }),
      component("b", { ports: [81], applications: [{ id: "app", title: "B", authority: "application" }] }),
    ])],
    ["bad revision", () => ({ ...catalog([]), revision: 0 })],
    ["bad tier", () => ({ ...catalog([]), enabledTiers: ["standard-9" as CodingSessionInstanceTier] })],
    ["unordered tiers", () => ({ ...catalog([]), enabledTiers: ["standard-2", "standard-1"] as CodingSessionInstanceTier[] })],
    ["invalid repository", () => catalog([component("a", { requiredRepositories: ["Invalid Repo"] })])],
    ["unordered repositories", () => catalog([component("a", { requiredRepositories: ["zeta", "alpha"] })])],
    ["empty public title", () => catalog([component("a", { title: "" })])],
    ["unavailable without reason", () => catalog([component("a", { available: false, unavailableReason: undefined, executionSpec: undefined })])],
    ["available with unavailable reason", () => catalog([component("a", { unavailableReason: "not available" })])],
    ["bad port", () => catalog([component("a", { ports: [0] })])],
    ["repeated port", () => catalog([component("a", { ports: [80, 80] })])],
    ["unknown dependency", () => catalog([component("a", { dependencyIds: ["missing"] })])],
    ["unknown conflict", () => catalog([component("a", { conflictsWith: ["missing"] })])],
    ["dependency cycle", () => catalog([
      component("a", { dependencyIds: ["b"] }), component("b", { dependencyIds: ["a"] }),
    ])],
    ["unknown profile component", () => catalog([], [profile("p", ["missing"])])],
    ["available without spec", () => catalog([component("a", { available: true, executionSpec: undefined })])],
    ["mutable image", () => catalog([component("a", {
      available: true,
      executionSpec: executionSpec({ images: [{ id: "image", reference: "vendor/image:latest" }] }),
    })])],
    ["missing readiness coverage", () => catalog([component("a", {
      executionSpec: executionSpec({ readiness: [] }),
    })])],
    ["missing liveness coverage", () => catalog([component("a", {
      executionSpec: executionSpec({ liveness: [] }),
    })])],
    ["ambiguous command health", () => catalog([component("a", {
      executionSpec: executionSpec({
        readiness: [{ processId: "service", kind: "command", target: "curl /health", timeoutMs: 1_000 } as never],
      }),
    })])],
    ["undeclared environment configuration", () => catalog([component("a", {
      executionSpec: executionSpec({ processes: [{
        id: "service", phase: "service", argv: ["bin/service"], cwd: "/workspace",
        environment: [{ name: "PUBLIC_URL", source: { kind: "configuration", requirement: "missing" } }],
      }] }),
    })])],
    ["missing application mapping", () => catalog([component("a", {
      ports: [8080],
      applications: [{ id: "app", title: "App", authority: "application" }],
      executionSpec: executionSpec(),
    })])],
    ["extra application mapping", () => catalog([component("a", {
      ports: [8080],
      executionSpec: executionSpec({ applications: [{
        applicationId: "extra", processId: "service", port: 8080, protocols: ["http"],
      }] }),
    })])],
    ["duplicate application mapping", () => catalog([component("a", {
      ports: [8080],
      applications: [{ id: "app", title: "App", authority: "application" }],
      executionSpec: executionSpec({ applications: [
        { applicationId: "app", processId: "service", port: 8080, protocols: ["http"] },
        { applicationId: "app", processId: "service", port: 8080, protocols: ["sse"] },
      ] }),
    })])],
    ["undeclared application port", () => catalog([component("a", {
      ports: [8080],
      applications: [{ id: "app", title: "App", authority: "application" }],
      executionSpec: executionSpec({ applications: [{
        applicationId: "app", processId: "service", port: 8081, protocols: ["http"],
      }] }),
    })])],
    ["empty application protocols", () => catalog([component("a", {
      ports: [8080],
      applications: [{ id: "app", title: "App", authority: "application" }],
      executionSpec: executionSpec({ applications: [{
        applicationId: "app", processId: "service", port: 8080, protocols: [],
      }] }),
    })])],
    ["undeclared health port", () => catalog([component("a", {
      ports: [8080],
      executionSpec: executionSpec({ readiness: [{
        processId: "service", kind: "http", port: 8081, path: "/health", statuses: [200], timeoutMs: 1_000,
      }] }),
    })])],
    ["invalid health timeout", () => catalog([component("a", {
      ports: [8080],
      executionSpec: executionSpec({ readiness: [{
        processId: "service", kind: "tcp", port: 8080, timeoutMs: 0,
      }] }),
    })])],
    ["duplicate egress rule ID", () => catalog([component("a", {
      executionSpec: executionSpec({ egress: [
        { id: "read", protocol: "https", host: "github.com", port: 443, pathPrefixes: ["/a"], methods: ["GET"] },
        { id: "read", protocol: "https", host: "example.com", port: 443, pathPrefixes: ["/b"], methods: ["GET"] },
      ] }),
    })])],
    ["localhost egress", () => catalog([component("a", {
      executionSpec: executionSpec({ egress: [{
        id: "local", protocol: "https", host: "localhost", port: 443, pathPrefixes: ["/"], methods: ["GET"],
      }] }),
    })])],
  ])("rejects malformed catalog integrity: %s", (_name, makeCatalog) => {
    expect(() => validateDevelopmentCatalog(makeCatalog())).toThrow();
  });
});

describe("development planner", () => {
  it("keeps an omitted legacy terminal-only stack valid on standard-1", () => {
    const plan = planDevelopmentStack(DEVELOPMENT_CATALOG, { repositories: ["agentic"] }, openCapacity);
    expect(plan).toMatchObject({
      catalogRevision: 1,
      selection: { componentIds: [], requestedTier: "standard-1" },
      resolvedComponentIds: [],
      requiredRepositories: [],
      minimumTier: "standard-1",
      selectedTier: "standard-1",
      issues: [],
      canCreate: true,
    });
    expect(plan.capacity).toEqual(openCapacity["standard-1"]);
  });

  it("rejects every explicitly empty selection while preserving omitted legacy behavior", () => {
    for (const developmentStack of [{}, { componentIds: [] }, { requestedTier: "standard-2" as const }]) {
      const plan = planDevelopmentStack(DEVELOPMENT_CATALOG, { repositories: ["agentic"], developmentStack }, openCapacity);
      expect(plan.canCreate).toBe(false);
      expect(plan.issues).toContainEqual(expect.objectContaining({ code: "invalid-selection" }));
    }
  });

  it("fully expands an unavailable planned profile and reports repositories, tier, and availability", () => {
    const plan = planDevelopmentStack(DEVELOPMENT_CATALOG, {
      repositories: [],
      developmentStack: { profileId: "integrations" },
    }, openCapacity);
    expect(plan.resolvedComponentIds).toEqual([
      "integrations-infrastructure", "integrations-api", "temporal-service",
      "integrations-connector-landing-scenario",
    ]);
    expect(plan.requiredRepositories).toEqual(["unison-integrations"]);
    expect(plan.minimumTier).toBe("standard-4");
    expect(plan.selectedTier).toBe("standard-4");
    expect(plan.issues.map(issue => issue.code)).toEqual([
      "configuration-unavailable", "missing-repository", "configuration-unavailable",
      "configuration-unavailable", "configuration-unavailable", "configuration-unavailable", "tier-disabled",
    ]);
    expect(plan.canCreate).toBe(false);
  });

  it("normalizes direct selections and uses deterministic dependency-first order", () => {
    const definition = catalog([
      component("z"),
      component("b", { dependencyIds: ["z"], requiredRepositories: ["repo-b"] }),
      component("a", { dependencyIds: ["z"], requiredRepositories: ["repo-a"] }),
    ]);
    const plan = planDevelopmentStack(definition, {
      repositories: ["repo-b", "repo-a"],
      developmentStack: { componentIds: ["b", "a", "b"] },
    }, openCapacity, openContext);
    expect(plan.selection.componentIds).toEqual(["a", "b"]);
    expect(plan.resolvedComponentIds).toEqual(["z", "a", "b"]);
    expect(plan.requiredRepositories).toEqual(["repo-a", "repo-b"]);
    expect(plan.canCreate).toBe(true);
  });

  it("reports unknown profiles, direct components, and missing dependency definitions", () => {
    const definition = catalog([component("known", { dependencyIds: ["missing-dependency"] })]);
    const plan = planDevelopmentStack(definition, {
      repositories: [],
      developmentStack: { profileId: "missing-profile", componentIds: ["missing", "known"] },
    }, openCapacity, openContext);
    expect(plan.issues.map(issue => issue.code)).toEqual([
      "unknown-profile", "unknown-component", "unknown-component",
    ]);
    expect(plan.resolvedComponentIds).toEqual(["known"]);
  });

  it("detects dependency cycles, declared conflicts, and private port collisions", () => {
    const definition = catalog([
      component("a", { dependencyIds: ["b"], ports: [3000] }),
      component("b", { dependencyIds: ["a"], conflictsWith: ["a"], ports: [3000] }),
    ]);
    const plan = planDevelopmentStack(definition, {
      repositories: [], developmentStack: { componentIds: ["a"] },
    }, openCapacity, openContext);
    expect(plan.issues.map(issue => issue.code)).toEqual([
      "dependency-conflict", "dependency-conflict", "port-conflict",
    ]);
    expect(plan.issues.find(issue => issue.code === "port-conflict")?.message).not.toContain("3000");
    expect(plan.canCreate).toBe(false);
  });

  it("bounds untrusted selection counts, IDs, reflected messages, and component issue IDs", () => {
    const oversizedId = "x".repeat(10_000);
    const componentIds = [oversizedId, "invalid\u0000id", ...Array.from({ length: 25 }, (_, index) => `unknown-${index}`)];
    const plan = planDevelopmentStack(catalog([]), {
      repositories: [],
      developmentStack: { profileId: oversizedId, componentIds },
    }, openCapacity);
    expect(plan.selection.profileId).toBeUndefined();
    expect(plan.selection.componentIds?.length).toBe(18);
    expect(plan.issues.some(issue => issue.message.includes("at most 20"))).toBe(true);
    expect(plan.issues.every(issue => issue.message.length < 200)).toBe(true);
    expect(plan.issues.every(issue => (issue.componentId?.length ?? 0) <= 64)).toBe(true);
    expect(plan.issues.filter(issue => issue.message.startsWith("Development component IDs"))
      .every(issue => issue.componentId === undefined)).toBe(true);
  });

  it("keeps integrations independent from Leviosa and local complete independent from shared development", () => {
    const integrations = planDevelopmentStack(DEVELOPMENT_CATALOG, {
      repositories: ["unison-integrations"], developmentStack: { profileId: "integrations" },
    }, openCapacity);
    expect(integrations.requiredRepositories).toEqual(["unison-integrations"]);
    expect(integrations.resolvedComponentIds).toEqual([
      "integrations-infrastructure", "integrations-api", "temporal-service",
      "integrations-connector-landing-scenario",
    ]);

    const complete = planDevelopmentStack(DEVELOPMENT_CATALOG, {
      repositories: ["agentic", "leviosa-backend", "unison-integrations"],
      developmentStack: { profileId: "complete-local" },
    }, openCapacity);
    expect(complete.resolvedComponentIds).not.toContain("shared-development-services");
    expect(complete.resolvedComponentIds).not.toContain("unison-frontend-shared");
    expect(complete.resolvedComponentIds).toContain("unison-frontend-local");
  });

  it("orders standard-2 and reports missing deployment requirements for executable specs", () => {
    const definition = catalog([component("configured", {
      available: true,
      minimumTier: "standard-2",
      executionSpec: executionSpec({
        requirements: { configuration: ["public-endpoint"], capabilities: ["package-proxy"] },
      }),
    })]);
    validateDevelopmentCatalog(definition);
    const missing = planDevelopmentStack(definition, {
      repositories: [], developmentStack: { componentIds: ["configured"] },
    }, openCapacity, openContext);
    expect(missing.minimumTier).toBe("standard-2");
    expect(missing.selectedTier).toBe("standard-2");
    expect(missing.issues.map(issue => issue.code)).toEqual(["configuration-unavailable"]);
    expect(missing.issues[0]?.message).not.toContain("public-endpoint");
    expect(missing.issues[0]?.message).not.toContain("package-proxy");
    const ready = planDevelopmentStack(definition, {
      repositories: [], developmentStack: { componentIds: ["configured"] },
    }, openCapacity, { ...openContext, configuration: ["public-endpoint"], capabilities: ["package-proxy"] });
    expect(ready.canCreate).toBe(true);
  });

  it("fails closed on partial private egress grants without exposing grant keys", () => {
    const definition = catalog([component("network", {
      executionSpec: executionSpec({ egress: [
        { id: "github-read", protocol: "https", host: "github.com", port: 443, pathPrefixes: ["/totango/"], methods: ["GET"] },
        { id: "npm-read", protocol: "https", host: "registry.npmjs.org", port: 443, pathPrefixes: ["/"], methods: ["GET"] },
      ] }),
    })]);
    validateDevelopmentCatalog(definition);
    const request = { repositories: [], developmentStack: { componentIds: ["network"] } };
    for (const egressGrants of [[], ["network:github-read"]]) {
      const plan = planDevelopmentStack(definition, request, openCapacity, { ...openContext, egressGrants });
      expect(plan.canCreate).toBe(false);
      expect(plan.issues).toContainEqual(expect.objectContaining({ code: "configuration-unavailable" }));
      expect(plan.issues.every(issue => !issue.message.includes("github-read") &&
        !issue.message.includes("npm-read") && !issue.message.includes("network:"))).toBe(true);
    }
    const complete = planDevelopmentStack(definition, request, openCapacity, {
      ...openContext, egressGrants: ["network:github-read", "network:npm-read"],
    });
    expect(complete.canCreate).toBe(true);
  });

  it("fails closed on missing or insufficient aggregate sandbox disk budget", () => {
    const definition = catalog([
      component("disk-a", { executionSpec: executionSpec({ minimumDiskBytes: 5 }) }),
      component("disk-b", { executionSpec: executionSpec({ minimumDiskBytes: 7 }) }),
    ]);
    const request = { repositories: [], developmentStack: { componentIds: ["disk-a", "disk-b"] } };
    const missing = planDevelopmentStack(definition, request, openCapacity);
    const insufficient = planDevelopmentStack(definition, request, openCapacity, {
      diskBytesByTier: { "standard-1": 11 },
    });
    for (const plan of [missing, insufficient]) {
      expect(plan.canCreate).toBe(false);
      expect(plan.issues).toContainEqual(expect.objectContaining({ code: "capacity-unavailable" }));
    }
    const sufficient = planDevelopmentStack(definition, request, openCapacity, {
      diskBytesByTier: { "standard-1": 12 },
    });
    expect(sufficient.canCreate).toBe(true);
  });

  it("excludes external execution disk from the coding sandbox tier budget", () => {
    const definition = catalog([
      component("external", { execution: "external", executionSpec: executionSpec({ minimumDiskBytes: 1_000 }) }),
      component("sandbox", { executionSpec: executionSpec({ minimumDiskBytes: 5 }) }),
    ]);
    const plan = planDevelopmentStack(definition, {
      repositories: [], developmentStack: { componentIds: ["external", "sandbox"] },
    }, openCapacity, { diskBytesByTier: { "standard-1": 5 } });
    expect(plan.canCreate).toBe(true);
  });

  it("checks profile and component minimum tiers", () => {
    const definition = catalog(
      [component("large", { minimumTier: "standard-3" })],
      [profile("large-profile", ["large"], "standard-4")],
    );
    const plan = planDevelopmentStack(definition, {
      repositories: [],
      developmentStack: { profileId: "large-profile", requestedTier: "standard-3" },
    }, openCapacity, openContext);
    expect(plan.minimumTier).toBe("standard-4");
    expect(plan.selectedTier).toBe("standard-3");
    expect(plan.issues).toEqual([{
      code: "tier-too-small",
      message: "Tier standard-3 is smaller than the required standard-4 tier.",
    }]);
  });

  it("distinguishes a disabled tier from exhausted enabled-tier capacity", () => {
    const disabled = planDevelopmentStack(catalog([component("selected")], [], ["standard-1"]), {
      repositories: [], developmentStack: { componentIds: ["selected"], requestedTier: "standard-3" },
    }, { ...openCapacity, "standard-3": { available: false, active: 2, limit: 2 } }, openContext);
    expect(disabled.issues.map(issue => issue.code)).toEqual(["tier-disabled"]);
    expect(disabled.capacity).toEqual({ available: false, active: 2, limit: 2 });

    const exhausted = planDevelopmentStack(catalog([component("selected")]), {
      repositories: [], developmentStack: { componentIds: ["selected"], requestedTier: "standard-3" },
    }, { ...openCapacity, "standard-3": { available: false, active: 2, limit: 2 } }, openContext);
    expect(exhausted.issues.map(issue => issue.code)).toEqual(["capacity-unavailable"]);
  });

  it("rejects duplicate health coverage and noncontiguous HTTP statuses", () => {
    const duplicate = component("duplicate", { executionSpec: executionSpec() });
    duplicate.executionSpec!.readiness.push(structuredClone(duplicate.executionSpec!.readiness[0]!));
    expect(() => validateDevelopmentCatalog(catalog([duplicate]))).toThrow(/readiness coverage/);

    const noncontiguous = component("noncontiguous", {
      ports: [8080],
      executionSpec: executionSpec({
        readiness: [{ processId: "service", kind: "http", port: 8080, path: "/health", statuses: [200, 204], timeoutMs: 1_000 }],
      }),
    });
    expect(() => validateDevelopmentCatalog(catalog([noncontiguous]))).toThrow(/invalid HTTP health/);
  });


  it("rejects excessive log retention, reserved marker env, and lifecycle phase regressions", () => {
    const logs = component("logs", { executionSpec: executionSpec({ logs: { maxBytes: 65_537, maxLines: 10 } }) });
    expect(() => validateDevelopmentCatalog(catalog([logs]))).toThrow(/storage bound/);
    const logLines = component("log-lines", { executionSpec: executionSpec({ logs: { maxBytes: 1_000, maxLines: 2_001 } }) });
    expect(() => validateDevelopmentCatalog(catalog([logLines]))).toThrow(/storage bound/);

    const longStop = component("long-stop", { executionSpec: executionSpec({ stop: { processOrder: ["service"], graceMs: 60_001 } }) });
    expect(() => validateDevelopmentCatalog(catalog([longStop]))).toThrow(/stop grace exceeds/);
    const longJob = component("long-job", { executionSpec: executionSpec() });
    longJob.executionSpec!.processes.unshift({
      id: "init", phase: "init", argv: ["init"], cwd: "/workspace", environment: [],
      idempotent: true, timeoutMs: 30 * 60 * 1_000 + 1,
    });
    expect(() => validateDevelopmentCatalog(catalog([longJob]))).toThrow(/bounded timeout/);

    const marker = component("marker", { executionSpec: executionSpec() });
    marker.executionSpec!.processes[0]!.environment = [{
      name: "ODIE_SUPERVISION_MARKER", source: { kind: "literal", value: "attacker" },
    }];
    expect(() => validateDevelopmentCatalog(catalog([marker]))).toThrow(/environment name/);

    const order = component("order", { executionSpec: executionSpec() });
    order.executionSpec!.processes.unshift(
      { id: "seed", phase: "seed", argv: ["seed"], cwd: "/workspace", environment: [], idempotent: true, timeoutMs: 100 },
      { id: "migrate", phase: "migration", argv: ["migrate"], cwd: "/workspace", environment: [], idempotent: true, timeoutMs: 100 },
    );
    expect(() => validateDevelopmentCatalog(catalog([order]))).toThrow(/lifecycle order/);
  });

});
