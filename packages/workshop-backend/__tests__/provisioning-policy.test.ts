import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG } from "../src/admin-config.js";
import { ambientGatekeeperMode, shouldAutoProvisionAccount } from "../src/provisioning-policy.js";

describe("ambient gatekeeper defaults", () => {
  it("enables deployment-controlled JARVIS without changing other ambient defaults", () => {
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "jarvis")).toBe("enabled");
    expect(shouldAutoProvisionAccount(DEFAULT_ADMIN_CONFIG, "JARVIS")).toBe(true);
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "context")).toBe("optional");
  });

  it("keeps an explicit admin override authoritative", () => {
    let config = {
      ...DEFAULT_ADMIN_CONFIG,
      ambientGatekeeperModes: {jarvis: "disabled" as const},
    };
    expect(ambientGatekeeperMode(config, "jarvis")).toBe("disabled");
    expect(shouldAutoProvisionAccount(config, "jarvis")).toBe(false);
  });
});
