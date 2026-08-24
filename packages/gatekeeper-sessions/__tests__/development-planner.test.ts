import { describe, expect, it } from "vitest";
import type { CodingSessionDevelopmentProfile, CodingSessionInstanceTier } from "@gadgets/workshop-shared/api";
import {
  DEVELOPMENT_CATALOG,
  publicDevelopmentCatalog,
  type DevelopmentCatalogDefinition,
  type DevelopmentComponentDefinition,
} from "../src/development-catalog.js";
import { planDevelopmentStack } from "../src/development-planner.js";

const openCapacity = {
  "standard-1": { available: true, active: 1, limit: 5 },
  "standard-3": { available: true, active: 0, limit: 2 },
  "standard-4": { available: true, active: 0, limit: 1 },
} as const;

function component(
  id: string,
  options: Partial<DevelopmentComponentDefinition> = {},
): DevelopmentComponentDefinition {
  return {
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
  enabledTiers: CodingSessionInstanceTier[] = ["standard-1", "standard-3", "standard-4"],
): DevelopmentCatalogDefinition {
  return { revision: 7, components, profiles, enabledTiers };
}

describe("development catalog", () => {
  it("projects every audited partial and complete profile without private execution fields", () => {
    const projected = publicDevelopmentCatalog();
    expect(projected.profiles.map(entry => entry.id)).toEqual([
      "frontend-shared", "agentic-core", "leviosa-graphql", "temporal-workflows",
      "data-odi-clickhouse", "integrations", "complete-local", "complete-external",
    ]);
    expect(projected.components.map(entry => entry.id)).toEqual([
      "shared-development-services", "unison-frontend-shared", "agentic-core", "leviosa-graphql",
      "temporal-service", "leviosa-workflows", "data-odi-clickhouse", "integrations",
      "unison-frontend-local", "complete-external",
    ]);
    expect(projected.profiles.every(entry => !entry.available)).toBe(true);
    expect(projected.components.every(entry => !entry.available)).toBe(true);
    expect(projected.enabledTiers).toEqual(["standard-1"]);
    expect(projected.components.find(entry => entry.id === "complete-external")?.execution).toBe("external");
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

  it("returns a fresh projection that cannot mutate the server catalog", () => {
    const first = publicDevelopmentCatalog();
    first.components[0]!.dependencyIds.push("mutated");
    first.profiles[0]!.componentIds.push("mutated");
    const second = publicDevelopmentCatalog();
    expect(second.components[0]!.dependencyIds).not.toContain("mutated");
    expect(second.profiles[0]!.componentIds).not.toContain("mutated");
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

  it("fully expands an unavailable audited profile and reports repositories, tier, and availability", () => {
    const plan = planDevelopmentStack(DEVELOPMENT_CATALOG, {
      repositories: [],
      developmentStack: { profileId: "integrations" },
    }, openCapacity);
    expect(plan.resolvedComponentIds).toEqual(["temporal-service", "integrations"]);
    expect(plan.requiredRepositories).toEqual(["unison-integrations"]);
    expect(plan.minimumTier).toBe("standard-4");
    expect(plan.selectedTier).toBe("standard-4");
    expect(plan.issues.map(issue => issue.code)).toEqual([
      "configuration-unavailable", "missing-repository", "configuration-unavailable",
      "configuration-unavailable", "tier-disabled",
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
    }, openCapacity);
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
    }, openCapacity);
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
    }, openCapacity);
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
    expect(integrations.resolvedComponentIds).toEqual(["temporal-service", "integrations"]);

    const complete = planDevelopmentStack(DEVELOPMENT_CATALOG, {
      repositories: ["agentic", "leviosa-backend", "unison-integrations"],
      developmentStack: { profileId: "complete-local" },
    }, openCapacity);
    expect(complete.resolvedComponentIds).not.toContain("shared-development-services");
    expect(complete.resolvedComponentIds).not.toContain("unison-frontend-shared");
    expect(complete.resolvedComponentIds).toContain("unison-frontend-local");
  });

  it("checks profile and component minimum tiers", () => {
    const definition = catalog(
      [component("large", { minimumTier: "standard-3" })],
      [profile("large-profile", ["large"], "standard-4")],
    );
    const plan = planDevelopmentStack(definition, {
      repositories: [],
      developmentStack: { profileId: "large-profile", requestedTier: "standard-3" },
    }, openCapacity);
    expect(plan.minimumTier).toBe("standard-4");
    expect(plan.selectedTier).toBe("standard-3");
    expect(plan.issues).toEqual([{
      code: "tier-too-small",
      message: "Tier standard-3 is smaller than the required standard-4 tier.",
    }]);
  });

  it("distinguishes a disabled tier from exhausted enabled-tier capacity", () => {
    const disabled = planDevelopmentStack(catalog([], [], ["standard-1"]), {
      repositories: [], developmentStack: { requestedTier: "standard-3" },
    }, { ...openCapacity, "standard-3": { available: false, active: 2, limit: 2 } });
    expect(disabled.issues.map(issue => issue.code)).toEqual(["tier-disabled"]);
    expect(disabled.capacity).toEqual({ available: false, active: 2, limit: 2 });

    const exhausted = planDevelopmentStack(catalog([]), {
      repositories: [], developmentStack: { requestedTier: "standard-3" },
    }, { ...openCapacity, "standard-3": { available: false, active: 2, limit: 2 } });
    expect(exhausted.issues.map(issue => issue.code)).toEqual(["capacity-unavailable"]);
  });
});
