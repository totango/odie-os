import { AdminApi, AdminFormat, AdminFormatPatch, AdminResourceVendor, AdminSettingsView, AmbientGatekeeperMode, BannerColor, BlueprintPublicInfo, ConfigurableDeploymentHubId, FinanceHubDiagnostic, FinanceHubRepairResult, MAX_ANNOUNCEMENT_LENGTH, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_SITE_NAME_LENGTH, isAmbientGatekeeperMode, isBannerColor, isConfigurableDeploymentHubId, isFinanceOperationsWorkbenchBlueprintId, isHexColor } from '@gadgets/workshop-shared/api';
import { GatekeeperVendor } from '@gadgets/workshop-shared/gatekeeper';
import { DurableObject } from 'cloudflare:workers';
import { RpcTarget } from 'capnweb';
import { validateRpc } from 'capnweb-validate';
import { collection, createTypedStorage } from '@gadgets/typed-storage';
import { createWorkshopLogger } from "./observability";
import { ADMIN_CONFIG_KEY, FEATURED_BLUEPRINTS_KEY, isReservedBlueprintKey, parseBlueprintKvRecord, readBlueprintKvRecord, sanitizeBlueprintOutput, serializeFeaturedBlueprints } from './blueprint-archive.js';
import { AdminConfig, DEFAULT_ADMIN_CONFIG, FormatCuration, MAX_AGENT_HINT, applyDeploymentAdminConfigDefaults, defaultOutputFormatId, listPromotedFormats, normalizeEnabledHubs, reorderFormats, sanitizeOutputOverrides, serializeAdminConfig } from './admin-config.js';
import { SITE_LOGO_R2_KEY, siteLogoImage, validateSiteLogo } from './site-logo.js';
import { ambientGatekeeperMode } from './provisioning-policy.js';
import { buildGatekeeperVendorMap } from './auth/auth-vendors.js';
import type { UserDurableObject } from './user.js';
import type { OverseerDurableObject } from './overseer.js';
import { featuredBlueprintsManifestVersion, formatBlueprintsManifestVersion, installFeaturedBlueprints, installFormatBlueprints, loadBundledFinanceOperationsWorkbenchSource } from './format-blueprints.js';
import { FEATURED_BLUEPRINTS, FORMAT_BLUEPRINTS } from './generated/format-blueprints.js';

const logger = createWorkshopLogger("workshop.admin.settings");

/** Stable name of the deployment-wide AdminSettings singleton. */
export const ADMIN_SETTINGS_SINGLETON_NAME = "";

/** Authoritative deployment claim for the single Finance workspace. */
export type FinanceWorkspaceClaim = {
  workspaceId: string;
  ownerUserId: string;
  ownerProfileId: string;
};

/** Outcome of atomically attempting to claim the deployment's Finance workspace. */
export type FinanceWorkspaceClaimResult = "claimed" | "existing" | "conflict";

function makeAdminSettingsStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      // Mirror of the currently-featured blueprint public records. The user DO owns the
      // authoritative featured bit; this DO keeps the publishable deployment-wide copy.
      featuredBlueprints: collection<BlueprintPublicInfo>()({
        primaryKey: 'id',
      }),
    },
    singletons: {
      // Authoritative deployment admin config. Mirrored to BLUEPRINTS KV (ADMIN_CONFIG_KEY) so the
      // connect/login/agent hot paths can read it without touching this singleton DO.
      adminConfig: DEFAULT_ADMIN_CONFIG as AdminConfig,

      // Which set of bundled format blueprints has been installed (see
      // formatBlueprintsManifestVersion). Empty means none yet; a mismatch means the repo shipped
      // new or updated ones and they should be reinstalled.
      installedFormatBlueprints: "",

      // Which set of bundled featured starter blueprints has been installed (see
      // featuredBlueprintsManifestVersion). Separate from formats so starter changes never trigger
      // format promotion.
      installedFeaturedBlueprints: "",

      // Bundled blueprint ids that have already been offered for promotion into
      // AdminConfig.formats. Tracked separately from the install stamp so that promotion happens
      // exactly once per blueprint: an admin who then removes a format keeps it removed, while a
      // deployment that installed before curation existed still gets promoted.
      promotedFormatBlueprints: <string[]>[],

      // True until the authoritative featured collection has been mirrored to KV. Default true
      // also heals deployments left inconsistent by a failed write before this marker existed.
      featuredBlueprintSnapshotDirty: true,

      // The one Finance workspace for this deployment. This lives beside admin configuration
      // because the singleton DO, rather than any one user's listing, is the coordination point.
      financeWorkspace: <FinanceWorkspaceClaim | null>null,
    },
  });
}

type AdminSettingsStorage = ReturnType<typeof makeAdminSettingsStorage>;

/**
 * Deployment-wide admin settings singleton.
 *
 * This durable object is always addressed as `getByName(ADMIN_SETTINGS_SINGLETON_NAME)`. It
 * contains settings that only admins may modify. Settings modified through this DO are published to KV so that user requests
 * do not have to access the AdminSettings DO directly (which they could otherwise overload), but
 * having a singleton DO writing to KV avoids race conditions when updating KV.
 */
export class AdminSettings extends DurableObject<Cloudflare.Env> {
  private storage: AdminSettingsStorage;
  private users: DurableObjectNamespace<UserDurableObject>;
  private overseers: DurableObjectNamespace<OverseerDurableObject>;
  // Every bound gatekeeper, keyed by vendor id. Deployment-global (from env bindings), so admin
  // resource listing needs no user context.
  private vendors: Map<string, Service<GatekeeperVendor>>;
  // Every config setter writes the same authoritative singleton and KV mirror. Serialize the full
  // read/modify/write operation so external KV I/O cannot let concurrent setters lose updates.
  private adminConfigMutationTail = Promise.resolve();
  // R2 and config are separate stores. Serialize logo changes so reset/upload operations cannot
  // interleave while switching whether the fixed public object is enabled.
  private siteLogoMutationTail = Promise.resolve();
  // The featured collection and its KV snapshot form one logical value. Serialize mutations so a
  // slower older snapshot cannot overwrite a newer one after concurrent RPCs interleave at KV I/O.
  private featuredBlueprintMutationTail = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.storage = makeAdminSettingsStorage(ctx.storage);
    this.users = this.ctx.exports.UserDurableObject;
    this.overseers = this.ctx.exports.OverseerDurableObject;
    this.vendors = buildGatekeeperVendorMap(env);
  }

  /** Return the authoritative Finance workspace claim, if one has been made. */
  getFinanceWorkspaceClaim(): FinanceWorkspaceClaim | null {
    return this.storage.financeWorkspace.get();
  }

  /**
   * Atomically claim the deployment's Finance workspace. An exact retry is idempotent; no other
   * workspace or owner can replace an existing claim.
   */
  claimFinanceWorkspace(claim: FinanceWorkspaceClaim): FinanceWorkspaceClaimResult {
    let existing = this.storage.financeWorkspace.get();
    if (existing) {
      return existing.workspaceId === claim.workspaceId &&
          existing.ownerUserId === claim.ownerUserId &&
          existing.ownerProfileId === claim.ownerProfileId
        ? "existing"
        : "conflict";
    }
    this.storage.financeWorkspace.put(claim);
    return "claimed";
  }

  /** Release a failed bootstrap claim only when every identity field still matches. */
  releaseFinanceWorkspace(claim: FinanceWorkspaceClaim): boolean {
    let existing = this.storage.financeWorkspace.get();
    if (!existing || existing.workspaceId !== claim.workspaceId ||
        existing.ownerUserId !== claim.ownerUserId ||
        existing.ownerProfileId !== claim.ownerProfileId) {
      return false;
    }
    this.storage.financeWorkspace.put(null);
    return true;
  }

  /** Return sanitized Finance claim health for the administrator capability. */
  async diagnoseFinanceHub(): Promise<FinanceHubDiagnostic> {
    try {
      return await this.#diagnoseFinanceHub();
    } catch (error) {
      logger.warn("failed to diagnose Finance workspace", {
        event: "finance.diagnosis.failed", error,
      });
      return {status: "blocked", reason: "unavailable"};
    }
  }

  async #diagnoseFinanceHub(): Promise<FinanceHubDiagnostic> {
    let claim = this.storage.financeWorkspace.get();
    if (!claim) return {status: "unclaimed"};
    let ownerId = this.users.idFromName(claim.ownerProfileId);
    if (ownerId.toString() !== claim.ownerUserId) {
      return {status: "blocked", reason: "invalid-claim"};
    }

    let owner = this.users.get(ownerId);
    let profile = await owner.whoamiIfExists();
    if (!profile) return {status: "blocked", reason: "missing-owner-account"};
    if (profile.id !== claim.ownerProfileId) {
      return {status: "blocked", reason: "invalid-claim"};
    }

    let workspaceId: DurableObjectId;
    try {
      workspaceId = this.overseers.idFromString(claim.workspaceId);
    } catch {
      return {status: "blocked", reason: "invalid-claim"};
    }
    let workspace = this.overseers.get(workspaceId);
    let workspaceStatus = await workspace.validateFinanceWorkspaceOwner(claim);
    if (workspaceStatus === "uninitialized") {
      let registration = financeRegistrationDiagnostic(await owner.getFinanceGadgetRegistrationStatus(
          claim.workspaceId));
      if (registration.status === "blocked") return registration;
      try {
        await loadBundledFinanceOperationsWorkbenchSource();
      } catch (error) {
        logger.warn("failed to validate bundled Finance workspace source", {
          event: "finance.bundled-source.validation.failed", error,
        });
        return {status: "blocked", reason: "unavailable"};
      }
      return {status: "repairable", repair: "uninitialized-workspace"};
    }
    if (workspaceStatus === "incomplete") {
      return {status: "blocked", reason: "incomplete-workspace"};
    }
    if (workspaceStatus === "owner-mismatch") {
      return {status: "blocked", reason: "owner-mismatch"};
    }

    return financeRegistrationDiagnostic(await owner.getFinanceGadgetRegistrationStatus(
        claim.workspaceId));
  }

  /**
   * Repair the claimed owner's Finance registration only after claim identity, workspace ownership,
   * and completed protected-blueprint initialization validate. Exact retries are no-ops.
   */
  async repairFinanceHub(): Promise<FinanceHubRepairResult> {
    // Keep the singleton claim stable while validation waits on its owner and workspace DOs.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        let before = await this.#diagnoseFinanceHub();
        if (before.status !== "repairable") return {repaired: false, diagnostic: before};
        let claim = this.storage.financeWorkspace.get();
        if (!claim) return {repaired: false, diagnostic: {status: "unclaimed"}};
        let owner = this.users.get(this.users.idFromString(claim.ownerUserId));
        let recovered = false;
        if (before.repair === "uninitialized-workspace") {
          let workspace = this.overseers.get(this.overseers.idFromString(claim.workspaceId));
          let source = await loadBundledFinanceOperationsWorkbenchSource();
          let recovery = await workspace.recoverUninitializedFinanceWorkspace(
              claim, source.blueprintId, source.metadata.title, source.code);
          if (recovery === "rejected") {
            let diagnostic = await this.#diagnoseFinanceHub();
            return {repaired: false, diagnostic};
          }
          recovered = recovery === "recovered";
        }
        let result = await owner.repairFinanceGadgetRegistration(claim.workspaceId);
        let diagnostic = await this.#diagnoseFinanceHub();
        return {
          repaired: (recovered || result === "inserted" || result === "updated") &&
              diagnostic.status === "healthy",
          diagnostic,
        };
      } catch (error) {
        logger.warn("failed to repair Finance workspace registration", {
          event: "finance.repair.failed", error,
        });
        return {repaired: false, diagnostic: {status: "blocked", reason: "unavailable"}};
      }
    });
  }

  /**
   * Install the bundled blueprints shipped with this deployment, if that hasn't already happened
   * for this exact manifest. Idempotent and cheap: an up-to-date deployment does one string
   * comparison and returns.
   *
   * Written straight into the featured mirror rather than through setBlueprintFeatured(), whose
   * authoritative bit lives in the publishing user's DO -- these have no owning user.
   *
   * Callers are coalesced onto one run, or two isolates racing on a fresh deployment both promote
   * the same blueprints, and a duplicated id makes setFormatOrder() reject every reordering.
   */
  ensureFormatBlueprintsInstalled(): Promise<boolean> {
    return this.#installInFlight ??= this.#installFormatBlueprints()
        .finally(() => { this.#installInFlight = undefined; });
  }

  #installInFlight?: Promise<boolean>;

  // Resolves true once every bundled blueprint is live. A partial install resolves false rather
  // than throwing: the caller has nothing to handle, but it does need to know to ask again.
  async #installFormatBlueprints(): Promise<boolean> {
    let complete = true;
    let manifestVersion = formatBlueprintsManifestVersion();
    if (this.storage.installedFormatBlueprints.get() !== manifestVersion) {
      let installed = await installFormatBlueprints(this.env);

      if (installed.length > 0) {
        await this.#mutateFeaturedMirror(() => {
          for (let publicInfo of installed) {
            this.storage.featuredBlueprints.put(publicInfo);
          }
          return true;
        });
      }

      // Stamped only once the whole manifest is live, so a crash or a single bad archive retries
      // next time. Recording a partial install as complete would strand the entries that failed
      // until the manifest happened to change again.
      complete = installed.length === FORMAT_BLUEPRINTS.length;
      if (complete) {
        this.storage.installedFormatBlueprints.put(manifestVersion);
      }
      logger.info("installed bundled format blueprints", {
        event: "formats.install.complete",
        size: installed.length,
        failureCount: FORMAT_BLUEPRINTS.length - installed.length,
      });
    }

    let featuredManifestVersion = featuredBlueprintsManifestVersion();
    if (this.storage.installedFeaturedBlueprints.get() !== featuredManifestVersion) {
      let installed = await installFeaturedBlueprints(this.env);
      if (installed.length > 0) {
        await this.#mutateFeaturedMirror(() => {
          for (let publicInfo of installed) {
            if (isFinanceOperationsWorkbenchBlueprintId(publicInfo.id)) {
              this.storage.featuredBlueprints.delete(publicInfo.id);
            } else {
              this.storage.featuredBlueprints.put(publicInfo);
            }
          }
          return true;
        });
      }

      let featuredComplete = installed.length === FEATURED_BLUEPRINTS.length;
      complete &&= featuredComplete;
      if (featuredComplete) {
        this.storage.installedFeaturedBlueprints.put(featuredManifestVersion);
      }
      logger.info("installed bundled featured blueprints", {
        event: "featured.install.complete",
        size: installed.length,
        failureCount: FEATURED_BLUEPRINTS.length - installed.length,
      });
    }

    // Promotion is checked on every run, not just after an install, so a deployment that installed
    // before curation existed still ends up offering its bundled formats.
    await this.#promoteBundledFormats();
    // Heal a snapshot write that failed before the dirty marker was introduced.
    await this.#mutateFeaturedMirror(() => false);
    return complete;
  }

  // Offer each bundled blueprint as a standard format, once ever. A separate one-shot decision per
  // blueprint: re-deriving the list from the manifest would undo an admin's removal on every
  // startup, and reinstalling an updated archive must refresh the blueprint without resetting how
  // the deployment has chosen to offer it.
  //
  // The converse isn't handled: a blueprint dropped from the bundle, or given a new blueprintId,
  // leaves its record and its promotion behind for an admin to remove by hand. Withdrawing them
  // would mean tracking which promotions this installer made, which is worth doing before the
  // bundled set ever changes.
  async #promoteBundledFormats(): Promise<void> {
    let promoted = new Set(this.storage.promotedFormatBlueprints.get());
    let pending = FORMAT_BLUEPRINTS.filter(entry => !promoted.has(entry.blueprintId));
    if (pending.length === 0) return;

    let config = this.#config();
    let known = new Set(config.formats.map(f => f.blueprintId));
    let added = pending
        .filter(entry => !known.has(entry.blueprintId))
        .map(entry => ({blueprintId: entry.blueprintId, enabled: true}));
    // Always write, even when every pending format is already in DO storage. That is the retry
    // state after a prior KV mirror failure; stamping promotion without writing would strand the
    // hot-path mirror on its old config forever.
    await this.updateAdminConfig({formats: [...config.formats, ...added]});

    for (let entry of pending) promoted.add(entry.blueprintId);
    this.storage.promotedFormatBlueprints.put([...promoted]);
  }

  async #writeFeaturedSnapshot(): Promise<void> {
    let featured = [...this.storage.featuredBlueprints.list()]
        .filter(({id}) => !isFinanceOperationsWorkbenchBlueprintId(id));
    await this.env.BLUEPRINTS.put(FEATURED_BLUEPRINTS_KEY, serializeFeaturedBlueprints(featured));
  }

  async #mutateFeaturedMirror(mutate: () => boolean | Promise<boolean>): Promise<void> {
    let previousMutation = this.featuredBlueprintMutationTail;
    let release!: () => void;
    this.featuredBlueprintMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previousMutation;
    try {
      let changed = await mutate();
      if (changed) this.storage.featuredBlueprintSnapshotDirty.put(true);
      if (!this.storage.featuredBlueprintSnapshotDirty.get()) return;
      await this.#writeFeaturedSnapshot();
      this.storage.featuredBlueprintSnapshotDirty.put(false);
    } finally {
      release();
    }
  }

  // Apply one owner-authorized state to the local collection. Metadata only moves forward, since
  // an admin toggle may have read KV while a newer Overseer propagation was still publishing.
  #applyFeaturedMirror(publicInfo: BlueprintPublicInfo, featured: boolean): boolean {
    if (isFinanceOperationsWorkbenchBlueprintId(publicInfo.id)) featured = false;
    let existing = this.storage.featuredBlueprints.get(publicInfo.id);
    if (!featured) {
      if (!existing) return false;
      this.storage.featuredBlueprints.delete(publicInfo.id);
      return true;
    }
    if (existing) {
      let current = existing.metadata;
      let incoming = publicInfo.metadata;
      if (incoming.version < current.version || (
        incoming.version === current.version &&
        incoming.lastUpdated.valueOf() < current.lastUpdated.valueOf()
      )) return false;
    }
    this.storage.featuredBlueprints.put(publicInfo);
    return true;
  }

  async #getOwnerBlueprint(blueprintId: string): Promise<{
    // Absent for a blueprint with no owning user, in which case `featureable` is false.
    owner: DurableObjectStub<UserDurableObject> | undefined;
    ownerId: string | undefined;
    featureable: boolean;
  }> {
    if (isReservedBlueprintKey(blueprintId)) {
      throw new Error('Blueprint not found.');
    }

    let raw = await this.env.BLUEPRINTS.get(blueprintId);
    if (!raw) {
      throw new Error('Blueprint not found.');
    }

    let kvRecord = parseBlueprintKvRecord(raw);

    return {
      ownerId: kvRecord.ownerId,
      owner: kvRecord.ownerId
          ? this.users.get(this.users.idFromString(kvRecord.ownerId))
          : undefined,
      // A deployment-installed blueprint (see format-blueprints.ts) has no owning User DO to hold
      // the authoritative featured bit, so the owner-anchored toggle doesn't apply -- the same
      // answer as an uploaded blueprint. It reaches users through the deployment's curation.
      featureable: !!kvRecord.gadgetId && !!kvRecord.ownerId,
    };
  }

  async isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    let { owner, ownerId, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      return null;
    }

    let featured: boolean | null = null;
    await this.#mutateFeaturedMirror(async () => {
      let kvRecord = await readBlueprintKvRecord(this.env, blueprintId);
      featured = await owner.isBlueprintFeatured(blueprintId);
      if (!kvRecord || kvRecord.ownerId !== ownerId || featured === null) {
        featured = null;
        if (!this.storage.featuredBlueprints.get(blueprintId)) return false;
        this.storage.featuredBlueprints.delete(blueprintId);
        return true;
      }
      return this.#applyFeaturedMirror({
        id: blueprintId,
        metadata: kvRecord.metadata,
      }, featured);
    });
    return featured;
  }

  async setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    let { owner, ownerId, featureable } = await this.#getOwnerBlueprint(blueprintId);
    if (!featureable || !owner) {
      throw new Error('Blueprint not featureable.');
    }

    await this.#mutateFeaturedMirror(async () => {
      let kvRecord = await readBlueprintKvRecord(this.env, blueprintId);
      if (!kvRecord?.gadgetId || kvRecord.ownerId !== ownerId) {
        throw new Error('Blueprint not featureable.');
      }
      await owner.setBlueprintFeatured(blueprintId, featured);
      return this.#applyFeaturedMirror({
        id: blueprintId,
        metadata: kvRecord.metadata,
      }, featured);
    });
  }

  async syncFeaturedBlueprint(publicInfo: BlueprintPublicInfo, ownerId: string): Promise<void> {
    // Overseer propagation calls this after blueprint updates so the mirror keeps up with the
    // latest published metadata. Re-read both canonical KV metadata and the owner bit inside the
    // mutation lane: either may have changed since the cross-DO caller formed its arguments.
    let owner = this.users.get(this.users.idFromString(ownerId));
    await this.#mutateFeaturedMirror(async () => {
      let kvRecord = await readBlueprintKvRecord(this.env, publicInfo.id);
      if (!kvRecord || kvRecord.ownerId !== ownerId) {
        return this.#applyFeaturedMirror(publicInfo, false);
      }
      let featured = await owner.isBlueprintFeatured(publicInfo.id);
      return this.#applyFeaturedMirror({
        id: publicInfo.id,
        metadata: kvRecord.metadata,
      }, featured === true);
    });
  }

  async deleteFeaturedBlueprint(blueprintId: string): Promise<void> {
    await this.#mutateFeaturedMirror(() => {
      if (!this.storage.featuredBlueprints.get(blueprintId)) return false;
      this.storage.featuredBlueprints.delete(blueprintId);
      return true;
    });
  }

  // --- Deployment admin config ---

  // Every read of the stored config goes through here. A config persisted before a field existed
  // is missing that field entirely, so reads must backfill from the defaults or the first
  // deployment to upgrade hits `undefined` on it.
  #storedConfig(): AdminConfig {
    let stored = this.storage.adminConfig.get();
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      ...stored,
      ambientGatekeeperModes: {
        ...DEFAULT_ADMIN_CONFIG.ambientGatekeeperModes,
        ...stored.ambientGatekeeperModes,
      },
    };
    return {
      ...config,
      enabledHubs: normalizeEnabledHubs(config.enabledHubs),
      formats: config.formats.filter(
          ({blueprintId}) => !isFinanceOperationsWorkbenchBlueprintId(blueprintId)),
    };
  }

  #config(): AdminConfig {
    return applyDeploymentAdminConfigDefaults(this.#storedConfig(), this.env);
  }

  getAdminConfig(): AdminConfig {
    return this.#config();
  }

  async #mutateAdminConfig(mutate: (config: AdminConfig) => AdminConfig): Promise<void> {
    let previousMutation = this.adminConfigMutationTail;
    let release!: () => void;
    this.adminConfigMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previousMutation;
    try {
      let current = this.#storedConfig();
      let next = mutate(current);
      this.storage.adminConfig.put(next);
      try {
        await this.env.BLUEPRINTS.put(ADMIN_CONFIG_KEY, serializeAdminConfig(next));
      } catch (error) {
        this.storage.adminConfig.put(current);
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * Merge a partial update into the admin config and mirror it to KV. Callers (AdminApiImpl) validate
   * scalar values; this just persists atomically.
   */
  updateAdminConfig(patch: Partial<AdminConfig>): Promise<void> {
    return this.#mutateAdminConfig(config => ({ ...config, ...patch }));
  }

  /**
   * Read all admin-managed settings for the admin UI in one call: the stored config plus the live
   * resource catalog (every bound gatekeeper's resource types annotated with their enabled state).
   *
   * `adminUserId` is the requesting admin's user id (email/username), forwarded to each gatekeeper's
   * getSupportedResources(). Most gatekeepers ignore it, but RBAC-gated ones (e.g. the internal GTM
   * Data gatekeeper) only reveal their resources to users with the right permission — so without it
   * they'd be hidden from the admin Gatekeepers tab.
   */
  async getSettings(adminUserId: string): Promise<AdminSettingsView> {
    let config = this.#config();
    return {
      signupsEnabled: config.signupsEnabled,
      siteName: config.siteName,
      siteLogo: siteLogoImage(config.siteLogoConfigured),
      instanceInstructions: config.instanceInstructions,
      announcement: config.announcement,
      banner: config.banner,
      accentColor: config.accentColor,
      enabledHubs: config.enabledHubs,
      resourceVendors: await this.#listResourceConfig(config, adminUserId),
      formats: await this.#listFormatConfig(config),
    };
  }

  // --- Standard output formats ---

  // Admin view of the promoted formats: the deployment's curation joined with each blueprint, so
  // the panel can show what is being curated and flag entries whose blueprint has been deleted.
  async #listFormatConfig(config: AdminConfig): Promise<AdminFormat[]> {
    let bundled = new Set(FORMAT_BLUEPRINTS.map(entry => entry.blueprintId));

    // Every entry, not just the offered ones: the panel exists to show what is disabled and what
    // points at a deleted blueprint.
    return (await listPromotedFormats(this.env, config.formats)).map(
        ({entry, metadata, declared, output}) => ({
          blueprintId: entry.blueprintId,
          blueprintTitle: metadata?.title ?? "",
          blueprintDescription: metadata?.description ?? "",
          output,
          declared,
          overrides: entry.overrides,
          enabled: entry.enabled,
          agentHint: entry.agentHint ?? "",
          missing: !metadata,
          bundled: bundled.has(entry.blueprintId),
        }));
  }

  // Read-modify-write one format entry within the DO, so concurrent admin edits can't clobber each
  // other. `mutate` returns the replacement list, or null to leave the config untouched.
  async #mutateFormats(mutate: (formats: FormatCuration[]) => FormatCuration[] | null)
      : Promise<void> {
    await this.#mutateAdminConfig(config => {
      let next = mutate(config.formats);
      // A no-op may be a retry after the prior KV write failed but DO storage succeeded. Mirror the
      // current config again so idempotent retries repair that partial failure.
      return next ? {...config, formats: next} : config;
    });
  }

  async promoteFormat(blueprintId: string): Promise<void> {
    if (isFinanceOperationsWorkbenchBlueprintId(blueprintId)) {
      throw new Error("Blueprint not found.");
    }
    let record = await readBlueprintKvRecord(this.env, blueprintId);
    if (!record) {
      throw new Error("Blueprint not found.");
    }
    await this.#mutateFormats(formats => {
      // Idempotent so retrying after a KV mirror failure reaches #mutateFormats()'s repair write.
      if (formats.some(f => f.blueprintId === blueprintId)) return null;
      // A blueprint that declares no output still needs a stable grouping key before the admin can
      // name it. Generate that hidden implementation detail here; the panel only asks the admin for
      // the human-facing noun, plural and icon.
      let declared = sanitizeBlueprintOutput(record.metadata.output);
      return [...formats, {
        blueprintId,
        enabled: true,
        ...(declared ? {} : {overrides: {id: defaultOutputFormatId(blueprintId)}}),
      }];
    });
  }

  async removeFormat(blueprintId: string): Promise<void> {
    // Enforced here, not just in the panel: this is an RPC an admin session can call directly.
    // Withdrawing a bundled entry is `enabled: false`, which keeps its overrides, hint and
    // position.
    if (FORMAT_BLUEPRINTS.some(entry => entry.blueprintId === blueprintId)) {
      throw new Error(
          "This format ships with the deployment, so it can't be removed. Turn it off instead.");
    }
    await this.#mutateFormats(formats => {
      let next = formats.filter(f => f.blueprintId !== blueprintId);
      return next.length === formats.length ? null : next;
    });
  }

  async updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    await this.#mutateFormats(formats => formats.map(entry => {
      if (entry.blueprintId !== blueprintId) return entry;

      let next: FormatCuration = {...entry};
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.agentHint !== undefined) {
        // Truncated because every hint is repeated in the system prompt on every turn, so an
        // over-long one costs tokens on requests nobody connects back to this panel.
        let hint = patch.agentHint.trim().slice(0, MAX_AGENT_HINT);
        if (hint) next.agentHint = hint; else delete next.agentHint;
      }
      if (patch.overrides) {
        // null reverts a field to the blueprint's own declaration; absent leaves it alone.
        let merged: Record<string, unknown> = {...entry.overrides};
        for (let [key, value] of Object.entries(patch.overrides)) {
          if (value === null) delete merged[key]; else merged[key] = value;
        }
        let clean = sanitizeOutputOverrides(merged);
        if (clean) next.overrides = clean; else delete next.overrides;
      }
      return next;
    }));
  }

  async setFormatOrder(blueprintIds: string[]): Promise<void> {
    await this.#mutateFormats(formats => reorderFormats(formats, blueprintIds));
  }

  /** Enable/disable a single gatekeeper resource type atomically (read-modify-write within the DO). */
  async setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    vendorId = vendorId.toLowerCase();
    await this.#mutateAdminConfig(config => {
      let map = { ...config.disabledResources };
      let disabled = new Set(map[vendorId] ?? []);
      if (enabled) disabled.delete(urlPattern); else disabled.add(urlPattern);
      if (disabled.size === 0) delete map[vendorId]; else map[vendorId] = [...disabled];
      return { ...config, disabledResources: map };
    });
  }

  async setHubEnabled(hubId: ConfigurableDeploymentHubId, enabled: boolean): Promise<void> {
    await this.#mutateAdminConfig(config => {
      let hubs = new Set(normalizeEnabledHubs(config.enabledHubs));
      if (enabled) hubs.add(hubId); else hubs.delete(hubId);
      if (hubs.size === 0) throw new Error("At least one hub must stay enabled.");
      return { ...config, enabledHubs: normalizeEnabledHubs([...hubs]) };
    });
  }

  async setSiteLogo(data: Uint8Array | null): Promise<boolean> {
    let previous = this.siteLogoMutationTail;
    let release!: () => void;
    this.siteLogoMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      let current = this.#config();
      if (data === null) {
        await this.updateAdminConfig({ siteLogoConfigured: false });
        try {
          await this.env.BLUEPRINT_CONTENT.delete(SITE_LOGO_R2_KEY);
        } catch (error) {
          logger.warn("failed to delete disabled site logo", {
            event: "site.logo.delete.failed", error,
          });
        }
        return false;
      }

      await this.env.BLUEPRINT_CONTENT.put(SITE_LOGO_R2_KEY, data, {
        httpMetadata: { contentType: "image/png" },
      });
      if (!current.siteLogoConfigured) {
        await this.updateAdminConfig({ siteLogoConfigured: true });
      }
      return true;
    } finally {
      release();
    }
  }

  /**
   * Set a gatekeeper's availability atomically (read-modify-write within the DO). Routes by kind: an
   * auto-provisioning ("ambient") gatekeeper stores its three-state mode in ambientGatekeeperModes
   * (default stored as absence); an ordinary gatekeeper stores a binary enabled/disabled in
   * disabledGatekeepers and rejects the ambient-only 'optional'.
   */
  async setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let vendor = this.vendors.get(vendorId);
    let autoProvisions = !!vendor && (await vendor.describe()).autoProvisionsAccount === true;
    if (autoProvisions) {
      let deploymentDefault = ambientGatekeeperMode(
          applyDeploymentAdminConfigDefaults(DEFAULT_ADMIN_CONFIG, this.env), vendorId);
      await this.#mutateAdminConfig(config => {
        let modes = { ...config.ambientGatekeeperModes };
        if (mode === deploymentDefault) delete modes[vendorId];
        else modes[vendorId] = mode;
        let disabled = config.disabledGatekeepers.filter(id => id !== vendorId);
        return { ...config, ambientGatekeeperModes: modes, disabledGatekeepers: disabled };
      });
    } else {
      if (mode === "optional") {
        throw new Error(`"${vendorId}" is not an auto-provisioning gatekeeper; use 'enabled' or 'disabled'.`);
      }
      await this.#mutateAdminConfig(config => {
        let disabled = new Set(config.disabledGatekeepers);
        if (mode === "enabled") disabled.delete(vendorId); else disabled.add(vendorId);
        return { ...config, disabledGatekeepers: [...disabled] };
      });
    }
  }

  // Admin view of every bound gatekeeper's resource types, annotated with their enabled state.
  // Unlike the user-facing listGatekeeperVendors, this does NOT hide disabled resources (so admins
  // can re-enable them). `adminUserId` is forwarded to getSupportedResources() so RBAC-gated
  // gatekeepers still surface for an admin who has access to them.
  async #listResourceConfig(config: AdminConfig, adminUserId: string): Promise<AdminResourceVendor[]> {
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<AdminResourceVendor | null>[] = [];
    for (let [id, vendor] of this.vendors) {
      promises.push((async () => {
        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources({ userId: adminUserId }),
          ]);
          if (description.autoProvisionsAccount) {
            // Auto-provisioning ("ambient") gatekeeper: a three-state mode, no resources to toggle.
            let mode = ambientGatekeeperMode(config, id);
            return {
              vendorId: id,
              displayName: description.displayName,
              logo: description.logo,
              autoProvisions: true,
              ambientMode: mode,
            };
          }
          if (supportedResources.length === 0) {
            // Nothing to toggle for this gatekeeper.
            return null;
          }
          let disabled = new Set(config.disabledResources[id] ?? []);
          return {
            vendorId: id,
            displayName: description.displayName,
            logo: description.logo,
            autoProvisions: false,
            enabled: !disabledGatekeeperSet.has(id),
            resources: supportedResources.map(r => ({
              urlPattern: r.urlPattern,
              title: r.title,
              description: r.description,
              icon: r.icon,
              enabled: !disabled.has(r.urlPattern),
            })),
          };
        } catch (err) {
          logger.warn("failed to read resource config for gatekeeper", {
            event: "gatekeeper.resource.config.read.failed", gatekeeperId: id, error: err,
          });
          return null;
        }
      })());
    }

    let vendors = (await Promise.all(promises)).filter((v): v is AdminResourceVendor => v !== null);
    // Show auto-provisioned ("ambient") gatekeepers first; preserve the existing order otherwise.
    vendors.sort((a, b) => Number(b.autoProvisions) - Number(a.autoProvisions));
    return vendors;
  }
}

function financeRegistrationDiagnostic(
    status: Awaited<ReturnType<UserDurableObject["getFinanceGadgetRegistrationStatus"]>>,
): FinanceHubDiagnostic {
  switch (status) {
    case "missing": return {status: "repairable", repair: "missing-owner-registration"};
    case "missing-origin": return {status: "repairable", repair: "missing-finance-origin"};
    case "healthy": return {status: "healthy"};
    case "shared": return {status: "blocked", reason: "shared-registration"};
    case "non-finance": return {status: "blocked", reason: "non-finance-origin"};
    case "duplicate": return {status: "blocked", reason: "duplicate-finance-registration"};
  }
}

// Capability for managing deployment-wide admin settings, obtained via
// AuthenticatedApi.getAdminApi() (which is null for non-admins). The admin access check happens once
// when the capability is minted in server.ts, so these methods don't re-check. This is a thin
// validation+forwarding facade over the AdminSettings DO — fully user-independent — so a disabled
// gatekeeper/resource can't be re-enabled via a crafted request, and the client never receives a
// stub to the DO's internal methods. Covers branding, agent instructions, signups, and gatekeeper
// connector/resource availability; authentication config stays env-var driven.
@validateRpc()
export class AdminApiImpl extends RpcTarget implements AdminApi {
  /**
   * `adminUserId` is the requesting admin's identity, forwarded to gatekeepers when listing the
   * resource catalog (some are RBAC-gated per user). It's plain data — not a user-DO dependency.
   */
  constructor(private admin: DurableObjectStub<AdminSettings>, private adminUserId: string) {
    super();
  }

  getSettings(): Promise<AdminSettingsView> {
    return this.admin.getSettings(this.adminUserId);
  }

  diagnoseFinanceHub(): Promise<FinanceHubDiagnostic> {
    return this.admin.diagnoseFinanceHub();
  }

  repairFinanceHub(): Promise<FinanceHubRepairResult> {
    return this.admin.repairFinanceHub();
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    await this.admin.updateAdminConfig({ signupsEnabled: enabled });
  }

  async setSiteName(name: string): Promise<void> {
    if (name.length > MAX_SITE_NAME_LENGTH) {
      throw new Error(`Site name too long (max ${MAX_SITE_NAME_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ siteName: name });
  }

  async setSiteLogo(data: Uint8Array | null): Promise<AdminSettingsView['siteLogo']> {
    if (data !== null) validateSiteLogo(data);
    return siteLogoImage(await this.admin.setSiteLogo(data));
  }

  async setInstanceInstructions(text: string): Promise<void> {
    if (text.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH) {
      throw new Error(`Instructions too long (max ${MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ instanceInstructions: text });
  }

  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void> {
    return this.admin.setResourceEnabled(vendorId, urlPattern, enabled);
  }

  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void> {
    if (!isAmbientGatekeeperMode(mode)) {
      throw new Error(`Invalid gatekeeper mode: ${mode}`);
    }
    return this.admin.setGatekeeperMode(vendorId, mode);
  }

  async setAnnouncement(text: string): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Announcement too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    await this.admin.updateAdminConfig({ announcement: text });
  }

  async setBanner(text: string, color: BannerColor): Promise<void> {
    if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
      throw new Error(`Banner too long (max ${MAX_ANNOUNCEMENT_LENGTH} characters).`);
    }
    if (!isBannerColor(color)) {
      throw new Error(`Invalid banner color: ${color}`);
    }
    await this.admin.updateAdminConfig({ banner: { text, color } });
  }

  async setAccentColor(color: string): Promise<void> {
    if (color !== "" && !isHexColor(color)) {
      throw new Error(`Invalid accent color: ${color}`);
    }
    await this.admin.updateAdminConfig({ accentColor: color });
  }

  setHubEnabled(hubId: ConfigurableDeploymentHubId, enabled: boolean): Promise<void> {
    if (!isConfigurableDeploymentHubId(hubId)) {
      throw new Error(`Invalid hub id: ${hubId}`);
    }
    return this.admin.setHubEnabled(hubId, enabled);
  }

  isBlueprintFeatured(blueprintId: string): Promise<boolean | null> {
    return this.admin.isBlueprintFeatured(blueprintId);
  }

  setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void> {
    return this.admin.setBlueprintFeatured(blueprintId, featured);
  }

  promoteFormat(blueprintId: string): Promise<void> {
    return this.admin.promoteFormat(blueprintId);
  }

  removeFormat(blueprintId: string): Promise<void> {
    return this.admin.removeFormat(blueprintId);
  }

  updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void> {
    return this.admin.updateFormat(blueprintId, patch);
  }

  setFormatOrder(blueprintIds: string[]): Promise<void> {
    return this.admin.setFormatOrder(blueprintIds);
  }
}
