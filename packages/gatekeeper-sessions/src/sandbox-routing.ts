import { getSandbox } from "@cloudflare/sandbox";
import type { CodingSessionInstanceTier } from "@gadgets/workshop-shared/api";
import type {
  CodingSessionSandbox,
  CodingSessionSandboxStandard2,
  CodingSessionSandboxStandard3,
  CodingSessionSandboxStandard4,
} from "./sessions.js";

/** Sandbox namespaces needed to route a generation to its fixed capacity tier. */
export interface CodingSessionSandboxEnv {
  SESSION_SANDBOX: DurableObjectNamespace<CodingSessionSandbox>;
  SESSION_SANDBOX_STANDARD_2: DurableObjectNamespace<CodingSessionSandboxStandard2>;
  SESSION_SANDBOX_STANDARD_3: DurableObjectNamespace<CodingSessionSandboxStandard3>;
  SESSION_SANDBOX_STANDARD_4: DurableObjectNamespace<CodingSessionSandboxStandard4>;
}

/** Returns the Sandbox-next client for one exact session generation and capacity tier. */
export function sandboxFor(
  env: CodingSessionSandboxEnv,
  tier: CodingSessionInstanceTier,
  sandboxId: string,
) {
  if (tier === "standard-2") return getSandbox(env.SESSION_SANDBOX_STANDARD_2, sandboxId);
  if (tier === "standard-3") return getSandbox(env.SESSION_SANDBOX_STANDARD_3, sandboxId);
  if (tier === "standard-4") return getSandbox(env.SESSION_SANDBOX_STANDARD_4, sandboxId);
  return getSandbox(env.SESSION_SANDBOX, sandboxId);
}

/** Returns the namespace-derived Durable Object ID used by Sandbox-next for one tier. */
export function sandboxObjectId(
  env: CodingSessionSandboxEnv,
  tier: CodingSessionInstanceTier,
  sandboxId: string,
): DurableObjectId {
  if (tier === "standard-2") return env.SESSION_SANDBOX_STANDARD_2.idFromName(sandboxId);
  if (tier === "standard-3") return env.SESSION_SANDBOX_STANDARD_3.idFromName(sandboxId);
  if (tier === "standard-4") return env.SESSION_SANDBOX_STANDARD_4.idFromName(sandboxId);
  return env.SESSION_SANDBOX.idFromName(sandboxId);
}
