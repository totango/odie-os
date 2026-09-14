import type { RequestBuildIntent, RequestBuildPolicy, RequestBuildReadiness } from "@gadgets/workshop-shared/coding-sessions";

/** Exact SDK ABI used by the restricted runner, independent of personal runtime selection. */
export const REQUEST_BUILD_RUNTIME_VERSION = "0.85.1";
/** Only these public package mirrors can be selected by private deployment policy. */
export const REQUEST_BUILD_DEPENDENCY_HOSTS = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "sum.golang.org"];
/** Fixed relay destination already used by ordinary Sessions; arbitrary model endpoints are not policy inputs. */
export const REQUEST_BUILD_MODEL_URL = "https://team-pi-proxy.unison.totango.com/api/odie/codex/responses";

const numericLimits = {
  wallTimeMs: 3_600_000, modelCalls: 1000, spendMicros: 1_000_000_000, callChargeMicros: 1_000_000_000,
  modelInputBytes: 8 * 1024 * 1024, modelOutputTokens: 100_000, outputBytes: 8 * 1024 * 1024,
  diffBytes: 1024 * 1024, diffFiles: 100, concurrency: 1,
};

/** Closed syntax for backend-generated correlation IDs (not titles or branch input). */
export function assertRequestBuildKey(key: string): void {
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new Error("INVALID_BUILD_KEY");
}

import { canonicalBuildJson, buildHash } from "@gadgets/workshop-shared/coding-sessions";
export { canonicalBuildJson, buildHash };

/** Parses mandatory numeric policy with no unbounded/default-on interpretation. */
export function parseRequestBuildPolicy(raw: string | undefined): RequestBuildReadiness {
  if (!raw) return { ready: false, reasons: ["BUILD_POLICY_MISSING"] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ready: false, reasons: ["BUILD_POLICY_INVALID"] }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ready: false, reasons: ["BUILD_POLICY_INVALID"] };
  const fields = new Set(["version", "runtimeVersion", "model", "dependencyHosts", ...Object.keys(numericLimits)]);
  const reasons: string[] = [];
  if (Object.keys(value).some(k => !fields.has(k))) reasons.push("BUILD_POLICY_UNKNOWN_FIELD");
  for (const [name, max] of Object.entries(numericLimits)) {
    const n = Reflect.get(value, name);
    if (!Number.isSafeInteger(n) || n <= 0 || n > max) reasons.push(`BUILD_POLICY_${name.toUpperCase()}_INVALID`);
  }
  if (!("version" in value) || typeof value.version !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(value.version)) reasons.push("BUILD_POLICY_VERSION_INVALID");
  if (!("runtimeVersion" in value) || value.runtimeVersion !== REQUEST_BUILD_RUNTIME_VERSION) reasons.push("BUILD_RUNTIME_UNSUPPORTED");
  if (!("model" in value) || typeof value.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.model)) reasons.push("BUILD_MODEL_MISSING");
  if (!("dependencyHosts" in value) || !Array.isArray(value.dependencyHosts) ||
      value.dependencyHosts.length > REQUEST_BUILD_DEPENDENCY_HOSTS.length ||
      value.dependencyHosts.some(h => !REQUEST_BUILD_DEPENDENCY_HOSTS.includes(h)) ||
      new Set(value.dependencyHosts).size !== value.dependencyHosts.length) reasons.push("BUILD_DEPENDENCY_POLICY_INVALID");
  if (reasons.length) return { ready: false, reasons };
  // Each property is validated above; this is a data parser, not an RPC-interface mirror.
  const policy = value as RequestBuildPolicy;
  if (policy.callChargeMicros > policy.spendMicros) return { ready: false, reasons: ["BUILD_SPEND_BELOW_CALL_RESERVATION"] };
  return { ready: true, reasons: [], policy };
}

/** Validates fixed repository/base and independently computes all immutable hashes. */
export async function validateRequestBuildIntent(intent: RequestBuildIntent, policy: RequestBuildPolicy): Promise<string> {
  assertRequestBuildKey(intent.dispatchKey); assertRequestBuildKey(intent.runId);
  if (!Number.isSafeInteger(intent.attempt) || intent.attempt < 1 || intent.attempt > 100 ||
      intent.repository !== "totango/odie-os" || intent.baseBranch !== "main" || !/^[a-f0-9]{40}$/.test(intent.baseSha) ||
      typeof intent.specification !== "string" || !intent.specification.trim() || new TextEncoder().encode(intent.specification).length > 32768) throw new Error("INVALID_BUILD_INTENT");
  if (canonicalBuildJson(intent.policy) !== canonicalBuildJson(policy) ||
      await buildHash(canonicalBuildJson(policy)) !== intent.policyHash ||
      await buildHash(intent.specification) !== intent.specificationHash) throw new Error("BUILD_IMMUTABLE_HASH_MISMATCH");
  return buildHash(canonicalBuildJson(intent));
}

/** Rejects protocol features that can escape the single synchronous bounded Responses request. */
export function boundedBuildModelPayload(bytes: Uint8Array, policy: RequestBuildPolicy): string {
  if (bytes.byteLength > policy.modelInputBytes) throw new Error("BUILD_MODEL_INPUT_LIMIT");
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("BUILD_MODEL_PAYLOAD_INVALID");
  const allowed = ["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "stream", "store", "max_output_tokens", "include", "prompt_cache_key"];
  if (Object.keys(payload).some(k => !allowed.includes(k)) || !("model" in payload) || payload.model !== policy.model ||
      !("input" in payload) || !Array.isArray(payload.input) ||
      "tools" in payload && (!Array.isArray(payload.tools) || payload.tools.some(t => !t || typeof t !== "object" || t.type !== "function"))) throw new Error("BUILD_MODEL_PAYLOAD_INVALID");
  return JSON.stringify({ ...payload, store: false, max_output_tokens: policy.modelOutputTokens });
}
