import { vi } from "vitest";
import type { ConnectHandoffProtocol } from "@gadgets/workshop-shared/gatekeeper";

export const HANDOFF = { targetOrigin: "https://workshop.example", ticket: "1".repeat(64) };

export function connectCallback(protocol: ConnectHandoffProtocol = "browser-bound-v1") {
  const handoff = { ...HANDOFF, ...(protocol === "native-verifier-v1" ? { nativeFlowHandle: "n".repeat(43) } : {}) };
  return {
    getHandoffProtocol: vi.fn(async () => protocol),
    complete: vi.fn(async (_account: unknown, _expiresAt?: Date) => handoff),
    reconnectComplete: vi.fn(async (_stageId: string, _expiresAt?: Date) => handoff),
    credentialsRestored: vi.fn(async (_expiresAt?: Date) => {}),
    credentialsExpired: vi.fn(async () => {}),
  };
}
