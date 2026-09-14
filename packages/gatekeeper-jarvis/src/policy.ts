import { validateAdminFenceChallenge, type AdminAuthorization, type AdminFenceChallenge, type AdminFenceEvidence } from "@gadgets/workshop-shared/gatekeeper";
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

const HISTORICAL_V4_TOOLS = JARVIS_ALLOWED_TOOLS.filter(
  tool => tool !== "jarvis_describe_wren_tool" && tool !== "jarvis_call_wren_tool"
);
const HISTORICAL_V4_VISIBLE_CHAT_TOOLS = HISTORICAL_V4_TOOLS.filter(
  tool => tool !== "repo_knowledge" && tool !== "jarvis_call_prod_tool"
);
const HISTORICAL_VISIBLE_CHAT_TOOLS = JARVIS_ALLOWED_TOOLS.filter(
  tool => tool !== "repo_knowledge" && tool !== "jarvis_call_prod_tool"
);

/** Returns the default policy without the internal repository tool in chat. */
export function defaultJarvisToolPolicy(): JarvisToolPolicy {
  const tools = [...JARVIS_ALLOWED_TOOLS];
  return {
    revision: 6,
    chat: {
      tools: tools.filter(tool => tool !== "repo_knowledge"),
    },
    code: { tools },
    syncCode: false,
  };
}

/** Upgrades defaults and preserves an administrator's previous "all visible tools" selection. */
export function upgradeDefaultJarvisToolPolicy(policy: JarvisToolPolicy): JarvisToolPolicy {
  const historicalTools = [...HISTORICAL_V1_TOOLS];
  const untouchedV1 = policy.revision === 1 && policy.syncCode === true &&
    sameTools(policy.chat.tools, historicalTools) && sameTools(policy.code.tools, historicalTools);
  const untouchedV2 = policy.revision === 2 && policy.syncCode === false &&
    sameTools(policy.chat.tools, historicalTools.filter(tool => tool !== "repo_knowledge")) &&
    sameTools(policy.code.tools, historicalTools);
  const untouchedV3 = policy.revision === 3 && policy.syncCode === false &&
    sameTools(policy.chat.tools, HISTORICAL_V4_TOOLS.filter(tool => tool !== "repo_knowledge")) &&
    sameTools(policy.code.tools, HISTORICAL_V4_TOOLS);
  const untouchedV4 = policy.revision === 4 && policy.syncCode === false &&
    sameTools(policy.chat.tools, HISTORICAL_V4_VISIBLE_CHAT_TOOLS) &&
    sameTools(policy.code.tools, HISTORICAL_V4_TOOLS);
  const untouchedV5 = policy.revision === 5 && policy.syncCode === false &&
    sameTools(policy.chat.tools, HISTORICAL_VISIBLE_CHAT_TOOLS) &&
    sameTools(policy.code.tools, JARVIS_ALLOWED_TOOLS);
  const untouched = untouchedV1 || untouchedV2 || untouchedV3 || untouchedV4 || untouchedV5;
  if (untouched) return defaultJarvisToolPolicy();
  const selectedEveryPreviouslyVisibleChatTool =
    policy.revision <= 5 &&
    !policy.chat.tools?.includes("jarvis_call_prod_tool") &&
    (sameTools(policy.chat.tools, HISTORICAL_V4_VISIBLE_CHAT_TOOLS) ||
      HISTORICAL_VISIBLE_CHAT_TOOLS.every(tool => policy.chat.tools?.includes(tool)));
  const normalizeChat = policy.chat.tools === undefined || selectedEveryPreviouslyVisibleChatTool;
  const normalizeCode = policy.code.tools === undefined;
  if (!normalizeChat && !normalizeCode) return policy;
  const chatTools = policy.chat.tools === undefined
    ? defaultJarvisToolPolicy().chat.tools
    : JARVIS_ALLOWED_TOOLS.filter(tool =>
      policy.chat.tools?.includes(tool) || tool === "jarvis_call_prod_tool");
  return {
    ...policy,
    chat: normalizeChat ? { tools: chatTools } : policy.chat,
    code: normalizeCode ? { tools: [...JARVIS_ALLOWED_TOOLS] } : policy.code,
  };
}

/** Normalizes policy input to the deployment's fixed read-only allowlist. */
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
  /** Private attestation from the policy mutation owner, not an old account/UI wrapper. */
  adminFenceReadiness(challenge: AdminFenceChallenge): AdminFenceEvidence {
    validateAdminFenceChallenge(challenge);
    return {...challenge, provider: "jarvis", domain: "global", fenceVersion: 1,
      registryRevision: 0, ownerCount: 1, inventory: "global-policy"};
  }
  /**
   * Ordinary provider read: tool scopes/revision already appear in singleton authority keys;
   * syncCode is nonsensitive UI metadata. This value-only read conveys no mutation authority.
   * Keep the old wire shape for ordinary retained account wrappers.
   */
  get(): JarvisToolPolicy {
    const stored = this.ctx.storage.kv.get<JarvisToolPolicy>("policy");
    const policy = stored ? upgradeDefaultJarvisToolPolicy(stored) : defaultJarvisToolPolicy();
    if (stored === policy) return policy;
    this.ctx.storage.kv.put("policy", policy);
    return policy;
  }

  /** Replaces the policy and rotates its immutable authority revision. */
  async update(input: JarvisToolPolicyInput, authorization?: Service<AdminAuthorization>): Promise<JarvisToolPolicy> {
    // An old boolean UI child sends only input. It must fail here, even on old wrapper code.
    if (!authorization) throw new Error("Admin access required.");
    await authorization.assertCurrent("jarvis-policy");
    const policy = normalizeJarvisToolPolicy(input, this.get().revision + 1);
    this.ctx.storage.kv.put("policy", policy);
    return policy;
  }
}

/** Narrow RPC capability used by the JARVIS management application. */
@validateRpc()
export class JarvisPolicyApi extends RpcTarget {
  constructor(
    private readonly policy: Pick<JarvisPolicy, "get" | "update"> | DurableObjectStub<JarvisPolicy>,
    private readonly isAdmin: boolean,
    private readonly authorization?: Service<AdminAuthorization>,
  ) {
    super();
  }

  /** Reads the deployment-global policy for display. */
  async get(): Promise<JarvisToolPolicy> {
    if (this.authorization) await this.authorization.assertCurrent("jarvis-policy");
    else if (!this.isAdmin) throw new Error("Only a deployment administrator can view JARVIS policy.");
    return this.policy.get();
  }

  /** Updates policy only for a deployment administrator. */
  async update(input: JarvisToolPolicyInput): Promise<JarvisToolPolicy> {
    if (this.authorization) await this.authorization.assertCurrent("jarvis-policy");
    else throw new Error("Only a deployment administrator can update JARVIS policy.");
    return this.policy.update(input, this.authorization);
  }
}
