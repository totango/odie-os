import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  getProvisionalWorkspaceOriginErrorCode,
  isDeploymentHubId,
  PROVISIONAL_WORKSPACE_ORIGIN_ERROR_CODES,
  type AiChatAuthorInfo,
  type BlueprintOutput,
} from "@gadgets/workshop-shared/api";
import type { UserDurableObject, WorkspaceOutputEntry } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

async function withUser(name: string, fn: (user: UserDurableObject) => Promise<void>) {
  const stub = env.TEST_USER.getByName(name);
  await runInDurableObject(stub, async (user: UserDurableObject) => {
    await user.createAccount(`${name}@example.com`, name, new Uint8Array([1, 2, 3]));
    await fn(user);
  });
}

const output: BlueprintOutput = {
  id: "document",
  noun: "Document",
  plural: "Documents",
  icon: "fileText",
};

describe("workspace origin hub persistence", () => {
  it("rejects unknown deployment hub identifiers", () => {
    expect(isDeploymentHubId("support")).toBe(true);
    expect(isDeploymentHubId("sales")).toBe(false);
    expect(isDeploymentHubId(123)).toBe(false);
  });

  it("stores the origin when a workspace is created", async () => {
    await withUser("origin-created", async (user) => {
      await user.newGadget("workspace-1", "Support workspace", "support");
      await user.setGadgetLastActive("workspace-1", new Date("2026-08-20T10:00:00Z"), undefined);

      expect(await user.listGadgets()).toEqual([
        expect.objectContaining({ id: "workspace-1", originHubId: "support" }),
      ]);
    });
  });

  it("updates a provisional workspace origin idempotently and rejects non-provisional workspaces", async () => {
    await withUser("origin-provisional", async (user) => {
      await user.newGadget("draft", "Draft");

      await user.updateProvisionalWorkspaceOrigin("draft", "revenue");
      await user.updateProvisionalWorkspaceOrigin("draft", "revenue");
      expect(await user.getGadget("draft")).toEqual(
        expect.objectContaining({ id: "draft", originHubId: "revenue" }),
      );

      await user.setGadgetLastActive("draft", new Date("2026-08-20T11:00:00Z"), undefined);
      await expect(user.updateProvisionalWorkspaceOrigin("draft", "support")).rejects.toSatisfy(
        (err: unknown) => getProvisionalWorkspaceOriginErrorCode(err) ===
          PROVISIONAL_WORKSPACE_ORIGIN_ERROR_CODES.workspaceAlreadyActive,
      );
    });
  });

  it("reports not-found when updating a missing provisional workspace origin", async () => {
    await withUser("origin-missing", async (user) => {
      await expect(user.updateProvisionalWorkspaceOrigin("missing", "support")).rejects.toSatisfy(
        (err: unknown) => getProvisionalWorkspaceOriginErrorCode(err) ===
          PROVISIONAL_WORKSPACE_ORIGIN_ERROR_CODES.workspaceNotFound,
      );
    });
  });

  it("propagates shared workspace origin to output listings while preserving output format", async () => {
    await withUser("origin-shared-output", async (user) => {
      const owner: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
      await user.recordSharedGadgetOpen(
        "shared-workspace",
        "Shared support workspace",
        owner,
        "use",
        "support",
      );
      user.syncWorkspaceOutputs("shared-workspace", [{
        workpieceId: 1,
        title: "Resolution plan",
        created: new Date("2026-08-20T12:00:00Z"),
        output,
      } satisfies WorkspaceOutputEntry]);

      (user as unknown as { storage: { outputsBackfilled: { put(value: boolean): void } } })
        .storage.outputsBackfilled.put(true);

      await expect(user.listOutputs()).resolves.toEqual({
        catchingUp: false,
        outputs: [expect.objectContaining({
          workspaceId: "shared-workspace",
          workpieceId: 1,
          originHubId: "support",
          owner,
          role: "use",
          output,
        })],
      });
    });
  });
});
