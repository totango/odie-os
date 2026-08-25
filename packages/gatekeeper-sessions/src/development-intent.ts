import type { CodingSessionDevelopmentPlan, CodingSessionInstanceTier } from "@gadgets/workshop-shared/api";
import {
  validateDevelopmentCatalog,
  type DevelopmentCatalogDefinition,
  type DevelopmentExecutionSpec,
} from "./development-catalog.js";

/** Complete server-private authority fixed for one coding-session sandbox generation. */
export interface DevelopmentGenerationIntent {
  sessionId: string;
  sandboxId: string;
  generation: number;
  catalogRevision: number;
  instanceTier: CodingSessionInstanceTier;
  components: DevelopmentGenerationComponentIntent[];
}

/** One catalog component revision and its complete private execution authority. */
export interface DevelopmentGenerationComponentIntent {
  id: string;
  revision: number;
  title: string;
  dependencyIds: string[];
  applications: Array<{ id: string; title: string }>;
  executionSpec: DevelopmentExecutionSpec;
}

/** Constructs a detached immutable generation intent only from a validated server catalog and plan. */
export function createDevelopmentGenerationIntent(
  catalog: DevelopmentCatalogDefinition,
  plan: CodingSessionDevelopmentPlan,
  fence: { sessionId: string; sandboxId: string; generation: number },
): DevelopmentGenerationIntent {
  validateDevelopmentCatalog(catalog);
  if (!plan.canCreate || plan.issues.length !== 0 || !plan.capacity.available ||
      plan.catalogRevision !== catalog.revision || !catalog.enabledTiers.includes(plan.selectedTier)) {
    throw new Error("Development generation requires a current eligible server plan.");
  }
  const byId = new Map(catalog.components.map(component => [component.id, component]));
  const profiles = new Map(catalog.profiles.map(profile => [profile.id, profile]));
  const requested = new Set(plan.selection.componentIds ?? []);
  if (plan.selection.profileId) {
    const profile = profiles.get(plan.selection.profileId);
    if (!profile?.available) throw new Error("Development plan profile is unavailable.");
    for (const id of profile.componentIds) requested.add(id);
  }
  const canonical: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const component = byId.get(id);
    if (!component) throw new Error(`Development component ${id} has no executable server definition.`);
    for (const dependencyId of [...component.dependencyIds].toSorted()) visit(dependencyId);
    visited.add(id);
    canonical.push(id);
  };
  for (const id of [...requested].toSorted()) visit(id);
  if (JSON.stringify(canonical) !== JSON.stringify(plan.resolvedComponentIds)) {
    throw new Error("Development plan does not match the canonical dependency closure.");
  }
  const canonicalSet = new Set(canonical);
  const ports = new Set<number>();
  for (const id of canonical) {
    const component = byId.get(id)!;
    if (component.conflictsWith?.some(conflict => canonicalSet.has(conflict))) {
      throw new Error("Development plan contains conflicting components.");
    }
    for (const port of component.ports) {
      if (ports.has(port)) throw new Error("Development plan contains a port conflict.");
      ports.add(port);
    }
  }
  const requiredRepositories = [...new Set(canonical.flatMap(id => byId.get(id)!.requiredRepositories))].toSorted();
  if (JSON.stringify(requiredRepositories) !== JSON.stringify(plan.requiredRepositories)) {
    throw new Error("Development plan repository requirements are stale.");
  }
  const tiers = ["standard-1", "standard-2", "standard-3", "standard-4"] as const;
  const minimumTier = canonical.reduce<CodingSessionInstanceTier>((minimum, id) =>
    tiers.indexOf(byId.get(id)!.minimumTier) > tiers.indexOf(minimum) ? byId.get(id)!.minimumTier : minimum,
  plan.selection.profileId ? profiles.get(plan.selection.profileId)!.minimumTier : "standard-1");
  if (plan.minimumTier !== minimumTier || plan.selectedTier !== (plan.selection.requestedTier ?? minimumTier)) {
    throw new Error("Development plan tier selection is stale.");
  }
  const seen = new Set<string>();
  const components = plan.resolvedComponentIds.map(id => {
    if (seen.has(id)) throw new Error(`Development plan repeats component ${id}.`);
    const component = byId.get(id);
    if (!component?.available || !component.executionSpec || component.execution !== "sandbox") {
      throw new Error(`Development component ${id} has no executable server definition.`);
    }
    if (component.dependencyIds.some(dependencyId => !seen.has(dependencyId))) {
      throw new Error(`Development plan is not topological at component ${id}.`);
    }
    seen.add(id);
    return {
      id: component.id,
      revision: component.revision,
      title: component.title,
      dependencyIds: structuredClone(component.dependencyIds),
      applications: component.applications.map(application => ({ id: application.id, title: application.title })),
      executionSpec: structuredClone(component.executionSpec),
    };
  });
  const intent: DevelopmentGenerationIntent = {
    ...fence,
    catalogRevision: catalog.revision,
    instanceTier: plan.selectedTier,
    components,
  };
  return deepFreeze(intent);
}

/** Returns a detached copy suitable for Durable Object storage without retaining mutable catalog references. */
export function cloneDevelopmentGenerationIntent(intent: DevelopmentGenerationIntent): DevelopmentGenerationIntent {
  return deepFreeze(structuredClone(intent));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
