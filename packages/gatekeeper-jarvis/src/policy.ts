import { DurableObject, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  JARVIS_ALLOWED_TOOLS,
  type JarvisAllowedTool,
  type JarvisToolPolicy,
  type JarvisToolPolicyInput,
} from "./policy-types.js";
export type { JarvisToolPolicy, JarvisToolPolicyInput } from "./policy-types.js";

const HISTORICAL_V1_TOOLS = [
  "query_knowledge",
  "repo_knowledge",
  "resolve_repo_group",
  "lookup_incident",
  "jarvis_answer_support_question",
  "jarvis_investigate_customer_issue",
  "jarvis_check_integration_health",
  "jarvis_get_investigation_status",
  "jarvis_get_support_answer_status",
  "jarvis_list_prod_tools",
  "jarvis_describe_prod_tool",
  "jarvis_call_prod_tool",
] as const;

/** Returns the default policy with live repository lookup removed from the chat surface. */
export function defaultJarvisToolPolicy(): JarvisToolPolicy {
  const tools = [...JARVIS_ALLOWED_TOOLS];
  return {
    revision: 3,
    chat: { tools: tools.filter(tool => tool !== "repo_knowledge") },
    code: { tools },
    syncCode: false,
  };
}

/** Upgrades only the original untouched default, preserving every administrator-authored policy. */
export function upgradeDefaultJarvisToolPolicy(policy: JarvisToolPolicy): JarvisToolPolicy {
  const historicalTools = [...HISTORICAL_V1_TOOLS];
  const untouchedV1 = policy.revision === 1 && policy.syncCode === true &&
    sameTools(policy.chat.tools, historicalTools) && sameTools(policy.code.tools, historicalTools);
  const untouchedV2 = policy.revision === 2 && policy.syncCode === false &&
    sameTools(policy.chat.tools, historicalTools.filter(tool => tool !== "repo_knowledge")) &&
    sameTools(policy.code.tools, historicalTools);
  const untouched = untouchedV1 || untouchedV2;
  return untouched ? defaultJarvisToolPolicy() : policy;
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

function sameTools(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return actual?.length === expected.length && actual.every((tool, index) => tool === expected[index]);
}

/** Deployment-global Durable Object storing the current JARVIS policy. */
export class JarvisPolicy extends DurableObject<Env> {
  /** Reads the policy, initializing or upgrading only the untouched deployment default. */
  get(): JarvisToolPolicy {
    const stored = this.ctx.storage.kv.get<JarvisToolPolicy>("policy");
    const policy = stored ? upgradeDefaultJarvisToolPolicy(stored) : defaultJarvisToolPolicy();
    if (stored === policy) return policy;
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
