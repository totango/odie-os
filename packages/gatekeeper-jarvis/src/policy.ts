import { DurableObject, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  JARVIS_ALLOWED_TOOLS,
  type JarvisAllowedTool,
  type JarvisToolPolicy,
  type JarvisToolPolicyInput,
} from "./policy-types.js";
export type { JarvisToolPolicy, JarvisToolPolicyInput } from "./policy-types.js";

/** Returns the default policy, preserving the historical full allowlist on both surfaces. */
export function defaultJarvisToolPolicy(): JarvisToolPolicy {
  const tools = [...JARVIS_ALLOWED_TOOLS];
  return { revision: 1, chat: { tools }, code: { tools: [...tools] }, syncCode: true };
}

/** Normalizes policy input to the fixed JARVIS allowlist and deterministic allowlist order. */
export function normalizeJarvisToolPolicy(
  input: JarvisToolPolicyInput,
  revision: number,
): JarvisToolPolicy {
  if (!input || !Array.isArray(input.chatTools) || typeof input.syncCode !== "boolean") {
    throw new TypeError("Invalid JARVIS tool policy.");
  }
  const chat = normalizeTools(input.chatTools);
  const code = input.syncCode ? [...chat] : normalizeTools(input.codeTools ?? []);
  return {
    revision,
    chat: { tools: chat },
    code: { tools: code },
    syncCode: input.syncCode,
  };
}

function normalizeTools(tools: string[]): JarvisAllowedTool[] {
  if (!Array.isArray(tools) || tools.some(name => typeof name !== "string")) {
    throw new TypeError("JARVIS tool scopes must be arrays of tool names.");
  }
  const selected = new Set(tools);
  for (const name of selected) {
    if (!(JARVIS_ALLOWED_TOOLS as readonly string[]).includes(name)) {
      throw new TypeError(`JARVIS tool "${name}" is not allowed by this deployment.`);
    }
  }
  return JARVIS_ALLOWED_TOOLS.filter(name => selected.has(name));
}

/** Deployment-global Durable Object storing the current JARVIS policy. */
export class JarvisPolicy extends DurableObject<Env> {
  /** Reads the current policy, initializing the historical default when absent. */
  get(): JarvisToolPolicy {
    const stored = this.ctx.storage.kv.get<JarvisToolPolicy>("policy");
    if (stored) return stored;
    const policy = defaultJarvisToolPolicy();
    this.ctx.storage.kv.put("policy", policy);
    return policy;
  }

  /** Replaces the policy and rotates its immutable authority revision. */
  update(input: JarvisToolPolicyInput): JarvisToolPolicy {
    const policy = normalizeJarvisToolPolicy(input, this.get().revision + 1);
    this.ctx.storage.kv.put("policy", policy);
    return policy;
  }
}

/** Narrow RPC capability used by the JARVIS management application. */
@validateRpc()
export class JarvisPolicyApi extends RpcTarget {
  constructor(
    private readonly policy: {
      get(): JarvisToolPolicy | Promise<JarvisToolPolicy>;
      update(input: JarvisToolPolicyInput): JarvisToolPolicy | Promise<JarvisToolPolicy>;
    },
    private readonly isAdmin: boolean,
  ) {
    super();
  }

  /** Reads the deployment-global policy for display. */
  async get(): Promise<JarvisToolPolicy> {
    if (!this.isAdmin) throw new Error("Only a deployment administrator can view JARVIS policy.");
    return this.policy.get();
  }

  /** Updates policy only for a deployment administrator. */
  async update(input: JarvisToolPolicyInput): Promise<JarvisToolPolicy> {
    if (!this.isAdmin) throw new Error("Only a deployment administrator can update JARVIS policy.");
    return this.policy.update(input);
  }
}
