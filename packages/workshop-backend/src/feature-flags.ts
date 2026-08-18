import {
  DEFAULT_UI_FEATURE_FLAGS,
  DEV_UI_FEATURE_FLAGS,
  UI_FEATURE_FLAGS,
  type UiFeatureFlagName,
  type UiFeatureFlags,
} from "@gadgets/workshop-shared/feature-flags";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.feature-flags");

type FeatureFlagEnv = {
  DEV?: boolean;
  FLAGS?: Pick<Flagship, "getBooleanValue">;
  CODING_SESSION_PI_RUNTIME_ENABLED?: string;
};

type UiFeatureFlagEntry = [UiFeatureFlagName, boolean];

export async function resolveUiFeatureFlags(
    env: FeatureFlagEnv,
    userId: string,
): Promise<UiFeatureFlags> {
  if (env.DEV) {
    return { ...DEV_UI_FEATURE_FLAGS };
  }

  const piRuntimeEnabled = env.CODING_SESSION_PI_RUNTIME_ENABLED === "true";
  const deploymentDefaults: UiFeatureFlags = {
    ...DEFAULT_UI_FEATURE_FLAGS,
    "pi-coding-session-runtime": piRuntimeEnabled,
  };

  const flags = env.FLAGS;
  if (!flags) {
    logger.warn("Flagship binding missing; using default values", {
      event: "feature-flags.binding.missing",
      operation: "feature-flags.resolve",
    });
    return deploymentDefaults;
  }

  const values: UiFeatureFlagEntry[] = await Promise.all(
    UI_FEATURE_FLAGS.map(async (flag): Promise<UiFeatureFlagEntry> => {
      const deploymentDefault = deploymentDefaults[flag.key];
      try {
        const value = await flags.getBooleanValue(flag.key, deploymentDefault, { userId });
        return [flag.key, flag.key === "pi-coding-session-runtime" ? value && piRuntimeEnabled : value];
      } catch (error) {
        logger.warn("feature flag evaluation failed", {
          event: "feature-flags.evaluate.failed",
          operation: "feature-flags.evaluate",
          error,
        });
        return [flag.key, deploymentDefault];
      }
    }),
  );

  return Object.fromEntries(values) as UiFeatureFlags;
}
