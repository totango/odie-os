import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, applyDeploymentAdminConfigDefaults } from "../src/admin-config.js";
import {
  ambientGatekeeperMode,
  defaultAmbientGatekeeperMode,
  shouldAutoProvisionAccount,
} from "../src/provisioning-policy.js";

describe("ambient gatekeeper defaults", () => {
  it("enables deployment-controlled internal sources without changing other ambient defaults", () => {
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "jarvis")).toBe("enabled");
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "github_org")).toBe("enabled");
    expect(shouldAutoProvisionAccount(DEFAULT_ADMIN_CONFIG, "JARVIS")).toBe(true);
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "context")).toBe("optional");
    expect(shouldAutoProvisionAccount(DEFAULT_ADMIN_CONFIG, "context")).toBe(false);
    expect(defaultAmbientGatekeeperMode("github_org")).toBe("enabled");
  });

  it("keeps an explicit admin override authoritative", () => {
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: {jarvis: "disabled" as const},
    };
    expect(ambientGatekeeperMode(config, "jarvis")).toBe("disabled");
    expect(shouldAutoProvisionAccount(config, "jarvis")).toBe(false);
  });

  it("keeps an explicit optional override for a deployment-enabled source", () => {
    let config = applyDeploymentAdminConfigDefaults({
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: {context: "optional" as const},
    }, {DEFAULT_ENABLED_AMBIENT_GATEKEEPERS: "context"});
    expect(ambientGatekeeperMode(config, "context")).toBe("optional");
    expect(shouldAutoProvisionAccount(config, "context")).toBe(false);
  });

  it("uses an explicit deployment default when no administrator override exists", () => {
    let config = applyDeploymentAdminConfigDefaults(
        DEFAULT_ADMIN_CONFIG, {DEFAULT_ENABLED_AMBIENT_GATEKEEPERS: "context"});
    expect(ambientGatekeeperMode(config, "context")).toBe("enabled");
    expect(shouldAutoProvisionAccount(config, "context")).toBe(true);
  });

  it("preserves a legacy disabled gatekeeper until an ambient override is stored", () => {
    let legacy = {
      ...DEFAULT_ADMIN_CONFIG,
      disabledGatekeepers: ["jarvis"],
    };
    expect(ambientGatekeeperMode(legacy, "JARVIS")).toBe("disabled");

    let migrated = {
      ...legacy,
      ambientGatekeeperModes: {jarvis: "enabled" as const},
    };
    expect(ambientGatekeeperMode(migrated, "jarvis")).toBe("enabled");
  });
});
