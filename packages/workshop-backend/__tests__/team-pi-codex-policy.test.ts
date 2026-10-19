import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { DEFAULT_DAILY_LLM_CALL_LIMIT } from "@gadgets/workshop-shared/limits";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const TEAM_PI_MODEL_IDS = [
  "team-pi-codex/gpt-6-astra",
  "team-pi-codex/gpt-5.6-sol",
  "team-pi-codex/gpt-5.6-terra",
  "team-pi-codex/gpt-5.6-luna",
  "team-pi-codex/gpt-5.5",
  "team-pi-codex/gpt-5.4",
  "team-pi-codex/gpt-5.4-mini",
];

beforeAll(async () => {
  await env.TEST_USER.getByName(`team-pi-warmup-${crypto.randomUUID()}`).whoamiIfExists();
}, 300_000);

async function withTeamPiUser(run: (user: UserDurableObject) => Promise<void>): Promise<void> {
  const email = `team-pi-policy-${crypto.randomUUID()}@totango.com`;
  const stub = env.TEST_USER.getByName(email);
  await runInDurableObject(stub, async (user: UserDurableObject) => {
    await user.loginOrCreateViaGatekeeper(email, true);
    await run(user);
  });
}

async function withIneligibleUser(run: (user: UserDurableObject) => Promise<void>): Promise<void> {
  const email = `team-pi-policy-${crypto.randomUUID()}@example.com`;
  const stub = env.TEST_USER.getByName(email);
  await runInDurableObject(stub, async (user: UserDurableObject) => {
    await user.loginOrCreateViaGatekeeper(email, true);
    await run(user);
  });
}

describe("Team PI Codex-only policy", () => {
  it("prepares interactive Gadget AI using the verified viewer and their preferred model", async () => {
    await withTeamPiUser(async user => {
      await user.setPreferredModel(TEAM_PI_MODEL_IDS[2]);
      const context = await user.prepareGadgetAiRequest();
      expect(context.profile.id).toMatch(/@totango\.com$/);
      expect(context.aiModel?.profile.id).toBe(TEAM_PI_MODEL_IDS[2]);
      expect((await user.prepareGadgetAiRequest(TEAM_PI_MODEL_IDS[1])).aiModel?.profile.id)
        .toBe(TEAM_PI_MODEL_IDS[1]);
      await expect(user.prepareGadgetAiRequest('team-pi-codex/not-configured'))
        .rejects.toThrow('not available');
      await expect(user.prepareGadgetAiRequest('custom')).rejects.toThrow('not available');
    });
  });

  it("rejects external and password accounts for interactive Gadget AI", async () => {
    await withIneligibleUser(async user => {
      await expect(user.prepareGadgetAiRequest()).rejects.toThrow('verified internal SSO');
    });
    const email = `password-ai-${crypto.randomUUID()}@totango.com`;
    const stub = env.TEST_USER.getByName(email);
    await stub.createAccount(email, 'Password user', new Uint8Array([1, 2, 3]));
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      await expect(user.prepareGadgetAiRequest()).rejects.toThrow('verified internal SSO');
    });
  });

  it("consumes bounded daily quota for interactive Gadget AI", async () => {
    await withTeamPiUser(async user => {
      const before = await user.checkDailyLlmCount(1000);
      await user.prepareGadgetAiRequest();
      expect((await user.checkDailyLlmCount(1000)).used).toBe(before.used + 1);
      for (let i = 0; i < DEFAULT_DAILY_LLM_CALL_LIMIT; i++) {
        await user.consumeDailyLlmCall(DEFAULT_DAILY_LLM_CALL_LIMIT);
      }
      await expect(user.prepareGadgetAiRequest()).rejects.toThrow('Daily Gadget AI request limit');
    });
  });

  it("lists every configured Team PI model and no other models", async () => {
    await withTeamPiUser(async user => {
      const models = await user.listModels();
      expect(models.map(model => model.id)).toEqual(TEAM_PI_MODEL_IDS);
      expect(models[0]?.name).toBe("GPT-6 Astra");
      await expect(user.getPreferredModel()).resolves.toBe(TEAM_PI_MODEL_IDS[0]);
      await expect(user.getQuickModel()).resolves.toBe(TEAM_PI_MODEL_IDS[0]);
    });
  });

  it("rejects custom and gateway models at the user authority boundary", async () => {
    await withTeamPiUser(async user => {
      const customConfig: AiModelConfig = {
        provider: "openai",
        model: "gpt-4o",
        apiToken: "test-token",
      };

      await expect(user.addModel({type: "agent", id: "custom", name: "Custom"}, customConfig))
          .rejects.toThrow("only supports Team PI Codex models");
      await expect(user.setPreferredModel("workers-ai/@cf/moonshotai/kimi-k2.5"))
          .rejects.toThrow("No such model");
      await expect(user.setQuickModel("custom")).rejects.toThrow("No such model");
      await expect(user.getChatContext("workers-ai/@cf/zai-org/glm-4.7-flash"))
          .rejects.toThrow("No such model");
    });
  });

  it("uses only configured Team PI models for chat and quick inference", async () => {
    await withTeamPiUser(async user => {
      await user.setPreferredModel("team-pi-codex/gpt-5.6-terra");
      await user.setQuickModel("team-pi-codex/gpt-5.4-mini");

      await expect(user.getPreferredModel()).resolves.toBe("team-pi-codex/gpt-5.6-terra");
      await expect(user.getQuickModel()).resolves.toBe("team-pi-codex/gpt-5.4-mini");
      const context = await user.getChatContext("team-pi-codex/gpt-5.6-terra");
      expect(context.aiModel?.config).toEqual(expect.objectContaining({
        model: "gpt-5.6-terra",
        apiUrl: "internal:team-pi-codex",
      }));
      expect(context.quickModel).toEqual(expect.objectContaining({
        model: "gpt-5.4-mini",
        apiUrl: "internal:team-pi-codex",
      }));
    });
  });

  it("fails closed instead of falling back for an ineligible account", async () => {
    await withIneligibleUser(async user => {
      await expect(user.listModels()).resolves.toEqual([]);
      await expect(user.getPreferredModel()).resolves.toBeNull();
      await expect(user.getQuickModel()).resolves.toBeNull();
      await expect(user.addModel({type: "agent", id: "custom", name: "Custom"}, {
        provider: "openai",
        model: "gpt-4o",
        apiToken: "test-token",
      })).rejects.toThrow("only supports Team PI Codex models");
      await expect(user.setPreferredModel(TEAM_PI_MODEL_IDS[0])).rejects.toThrow("No such model");
      await expect(user.setQuickModel(TEAM_PI_MODEL_IDS[0])).rejects.toThrow("No such model");
      await expect(user.getChatContext(TEAM_PI_MODEL_IDS[0])).rejects.toThrow("No such model");
      const context = await user.getChatContext(null);
      expect(context.aiModel).toBeUndefined();
      expect(context.quickModel).toBeUndefined();
    });
  });
});
