import { describe, expect, it, vi } from "vitest";
import type { CodingSessionsService } from "@gadgets/workshop-shared/coding-sessions";
import { assertCurrentCodingSessionGeneration } from "../src/user.js";

const owner = { userId: "user-1", email: "user@example.com" };
const runningSession = {
  id: "session-1",
  title: "Repair",
  repositories: ["jarvis"],
  runtime: "opencode" as const,
  status: "running" as const,
  createdAt: new Date("2026-08-18T00:00:00Z"),
  lastActiveAt: new Date("2026-08-18T00:00:00Z"),
};

describe("assertCurrentCodingSessionGeneration", () => {
  it("rejects a stale sandbox generation", async () => {
    const service = {
      getSessionMetadata: vi.fn(async () => runningSession),
      isCurrentSessionGeneration: vi.fn(async () => false),
    } as unknown as Service<CodingSessionsService>;

    await expect(assertCurrentCodingSessionGeneration(
      service, owner, "session-1", "sandbox-stale",
    )).rejects.toThrow("Coding session is not running.");
    expect(service.isCurrentSessionGeneration).toHaveBeenCalledWith(
      owner, "session-1", "sandbox-stale",
    );
  });

  it("returns only a running current generation", async () => {
    const service = {
      getSessionMetadata: vi.fn(async () => runningSession),
      isCurrentSessionGeneration: vi.fn(async () => true),
    } as unknown as Service<CodingSessionsService>;

    await expect(assertCurrentCodingSessionGeneration(
      service, owner, "session-1", "sandbox-current",
    )).resolves.toBe(runningSession);
  });
});
