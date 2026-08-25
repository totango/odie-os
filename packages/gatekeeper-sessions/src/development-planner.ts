import type {
  CodingSessionDevelopmentCapacity,
  CodingSessionDevelopmentPlan,
  CodingSessionDevelopmentPlanIssue,
  CodingSessionInstanceTier,
  CodingSessionRepository,
  CodingSessionStackSelection,
  CreateCodingSessionRequest,
} from "@gadgets/workshop-shared/api";
import type { DevelopmentCatalogDefinition, DevelopmentComponentDefinition } from "./development-catalog.js";

/** Capacity snapshots supplied to the pure development-stack planner. */
export type DevelopmentCapacityByTier = Partial<Record<CodingSessionInstanceTier, CodingSessionDevelopmentCapacity>>;

/** Deployment-side non-secret requirements currently available to executable component specs. */
export interface DevelopmentPlannerContext {
  configuration?: Iterable<string>;
  capabilities?: Iterable<string>;
  egressGrants?: Iterable<string>;
  diskBytesByTier?: Partial<Record<CodingSessionInstanceTier, number>>;
}

const TIERS: CodingSessionInstanceTier[] = ["standard-1", "standard-2", "standard-3", "standard-4"];
const EMPTY_CAPACITY: CodingSessionDevelopmentCapacity = { available: false, active: 0, limit: 0 };
const MAX_SELECTION_COMPONENTS = 20;
const MAX_SELECTION_ID_LENGTH = 64;
const SELECTION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Purely expands and validates one request without reserving capacity or contacting a sandbox. */
export function planDevelopmentStack(
  catalog: DevelopmentCatalogDefinition,
  request: Pick<CreateCodingSessionRequest, "repositories" | "developmentStack">,
  capacities: DevelopmentCapacityByTier,
  context: DevelopmentPlannerContext = {},
): CodingSessionDevelopmentPlan {
  const issues: CodingSessionDevelopmentPlanIssue[] = [];
  const requested = request.developmentStack;
  const selection = normalizeSelection(requested, issues);
  if (requested !== undefined && selection.profileId === undefined && (selection.componentIds?.length ?? 0) === 0) {
    issues.push({
      code: "invalid-selection",
      message: "Select a development profile or at least one development component.",
    });
  }
  const componentsById = new Map(catalog.components.map(component => [component.id, component]));
  const profilesById = new Map(catalog.profiles.map(profile => [profile.id, profile]));
  const selectedIds = new Set<string>();
  let profileMinimum: CodingSessionInstanceTier = "standard-1";

  if (selection.profileId) {
    const profile = profilesById.get(selection.profileId);
    if (!profile) {
      issues.push({ code: "unknown-profile", message: `Unknown development profile: ${boundedId(selection.profileId)}.` });
    } else {
      profileMinimum = profile.minimumTier;
      for (const id of profile.componentIds) selectedIds.add(id);
      if (!profile.available) {
        issues.push({
          code: "configuration-unavailable",
          message: profile.unavailableReason ?? `Development profile ${profile.title} is unavailable.`,
        });
      }
    }
  }
  for (const id of selection.componentIds ?? []) {
    if (!componentsById.has(id)) {
      issues.push({ code: "unknown-component", componentId: boundedId(id), message: `Unknown development component: ${boundedId(id)}.` });
    } else {
      selectedIds.add(id);
    }
  }

  const resolved: DevelopmentComponentDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, parentId?: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      issues.push({
        code: "dependency-conflict", componentId: parentId ?? id,
        message: `Development component dependency cycle includes ${boundedId(id)}.`,
      });
      return;
    }
    const component = componentsById.get(id);
    if (!component) {
      issues.push({
        code: "unknown-component", componentId: parentId,
        message: `Development component dependency ${boundedId(id)} is not in the catalog.`,
      });
      return;
    }
    visiting.add(id);
    for (const dependencyId of [...component.dependencyIds].toSorted()) visit(dependencyId, component.id);
    visiting.delete(id);
    visited.add(id);
    resolved.push(component);
  };
  for (const id of [...selectedIds].toSorted()) visit(id);

  const resolvedIds = new Set(resolved.map(component => component.id));
  const repositorySet = new Set<CodingSessionRepository>(request.repositories);
  const requiredRepositories = [...new Set(resolved.flatMap(component => component.requiredRepositories))].toSorted();
  for (const repository of requiredRepositories) {
    if (!repositorySet.has(repository)) {
      const component = resolved.find(entry => entry.requiredRepositories.includes(repository));
      issues.push({
        code: "missing-repository", componentId: component?.id, repository,
        message: `${component?.title ?? "The development stack"} requires repository ${repository}.`,
      });
    }
  }

  const reportedConflicts = new Set<string>();
  for (const component of resolved) {
    if (!component.available) {
      issues.push({
        code: "configuration-unavailable", componentId: component.id,
        message: component.unavailableReason ?? `${component.title} is unavailable.`,
      });
    } else if (component.executionSpec) {
      const configuration = new Set(context.configuration ?? []);
      const capabilities = new Set(context.capabilities ?? []);
      const missingRequirement = component.executionSpec.requirements.configuration.some(
        requirement => !configuration.has(requirement),
      ) || component.executionSpec.requirements.capabilities.some(
        requirement => !capabilities.has(requirement),
      );
      if (missingRequirement) issues.push({
        code: "configuration-unavailable", componentId: component.id,
        message: `${component.title} is missing required deployment configuration or capabilities.`,
      });
      const egressGrants = new Set(context.egressGrants ?? []);
      const missingEgress = component.executionSpec.egress.some(
        rule => !egressGrants.has(`${component.id}:${rule.id}`),
      );
      if (missingEgress) issues.push({
        code: "configuration-unavailable", componentId: component.id,
        message: `${component.title} is missing required reviewed network access.`,
      });
    }
    for (const conflictId of component.conflictsWith ?? []) {
      if (!resolvedIds.has(conflictId)) continue;
      const pair = [component.id, conflictId].toSorted();
      const pairKey = JSON.stringify(pair);
      if (reportedConflicts.has(pairKey)) continue;
      reportedConflicts.add(pairKey);
      issues.push({
        code: "dependency-conflict", componentId: component.id,
        message: `${component.title} conflicts with ${componentsById.get(conflictId)?.title ?? boundedId(conflictId)}.`,
      });
    }
  }

  const portOwners = new Map<number, DevelopmentComponentDefinition>();
  for (const component of resolved) {
    for (const port of component.ports) {
      const owner = portOwners.get(port);
      if (owner && owner.id !== component.id) {
        issues.push({
          code: "port-conflict", componentId: component.id,
          message: `${component.title} and ${owner.title} reserve the same private port.`,
        });
      } else {
        portOwners.set(port, component);
      }
    }
  }

  const minimumTier = maxTier(profileMinimum, ...resolved.map(component => component.minimumTier));
  const selectedTier = selection.requestedTier ?? minimumTier;
  const requiredDiskBytes = resolved.reduce((total, component) =>
    component.available && component.execution === "sandbox" && component.executionSpec
      ? total + component.executionSpec.minimumDiskBytes
      : total, 0);
  const diskBudget = context.diskBytesByTier?.[selectedTier];
  if (requiredDiskBytes > 0 &&
      (!Number.isSafeInteger(diskBudget) || (diskBudget as number) < requiredDiskBytes)) {
    issues.push({
      code: "capacity-unavailable",
      message: "The selected tier lacks required development-stack disk capacity.",
    });
  }
  if (tierIndex(selectedTier) < tierIndex(minimumTier)) {
    issues.push({
      code: "tier-too-small",
      message: `Tier ${selectedTier} is smaller than the required ${minimumTier} tier.`,
    });
  }
  const tierEnabled = catalog.enabledTiers.includes(selectedTier);
  if (!tierEnabled) {
    issues.push({ code: "tier-disabled", message: `Tier ${selectedTier} is not enabled in this deployment.` });
  }
  const capacity = cloneCapacity(capacities[selectedTier] ?? EMPTY_CAPACITY);
  if (tierEnabled && !capacity.available) {
    issues.push({ code: "capacity-unavailable", message: `Tier ${selectedTier} has no capacity available.` });
  }

  return {
    catalogRevision: catalog.revision,
    selection,
    resolvedComponentIds: resolved.map(component => component.id),
    requiredRepositories,
    minimumTier,
    selectedTier,
    capacity,
    issues: deduplicateIssues(issues),
    canCreate: issues.length === 0,
  };
}

function normalizeSelection(
  selection: CodingSessionStackSelection | undefined,
  issues: CodingSessionDevelopmentPlanIssue[],
): CodingSessionStackSelection {
  if (!selection) return { componentIds: [], requestedTier: "standard-1" };

  let profileId: string | undefined;
  if (selection.profileId !== undefined) {
    if (typeof selection.profileId === "string" && selection.profileId.length <= MAX_SELECTION_ID_LENGTH &&
        SELECTION_ID_PATTERN.test(selection.profileId)) {
      profileId = selection.profileId;
    } else {
      issues.push({
        code: "unknown-profile",
        message: `Development profile IDs must be lowercase kebab-case and at most ${MAX_SELECTION_ID_LENGTH} characters.`,
      });
    }
  }

  const rawComponentIds: unknown[] = Array.isArray(selection.componentIds) ? selection.componentIds : [];
  if (rawComponentIds.length > MAX_SELECTION_COMPONENTS) {
    issues.push({
      code: "unknown-component",
      message: `Select at most ${MAX_SELECTION_COMPONENTS} development components.`,
    });
  }
  const componentIds: string[] = [];
  for (const value of rawComponentIds.slice(0, MAX_SELECTION_COMPONENTS)) {
    if (typeof value !== "string" || value.length > MAX_SELECTION_ID_LENGTH || !SELECTION_ID_PATTERN.test(value)) {
      issues.push({
        code: "unknown-component",
        message: `Development component IDs must be lowercase kebab-case and at most ${MAX_SELECTION_ID_LENGTH} characters.`,
      });
      continue;
    }
    componentIds.push(value);
  }

  return {
    ...(profileId === undefined ? {} : { profileId }),
    componentIds: [...new Set(componentIds)].toSorted(),
    ...(selection.requestedTier === undefined ? {} : { requestedTier: selection.requestedTier }),
  };
}

function tierIndex(tier: CodingSessionInstanceTier): number {
  return TIERS.indexOf(tier);
}

function maxTier(...tiers: CodingSessionInstanceTier[]): CodingSessionInstanceTier {
  return tiers.reduce((highest, tier) => tierIndex(tier) > tierIndex(highest) ? tier : highest, "standard-1");
}

function cloneCapacity(capacity: CodingSessionDevelopmentCapacity): CodingSessionDevelopmentCapacity {
  return { available: capacity.available, active: capacity.active, limit: capacity.limit };
}

function boundedId(id: string): string {
  return id.slice(0, MAX_SELECTION_ID_LENGTH);
}

function deduplicateIssues(issues: CodingSessionDevelopmentPlanIssue[]): CodingSessionDevelopmentPlanIssue[] {
  const seen = new Set<string>();
  return issues.filter(issue => {
    const key = JSON.stringify([issue.code, issue.componentId, issue.repository, issue.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
