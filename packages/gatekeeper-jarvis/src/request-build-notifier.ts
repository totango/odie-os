import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRequestBuildNotification, type RequestBuildNotification, type RequestBuildNotificationResult, type RequestBuildNotifier, type RequestBuildNotifierReadiness } from "@gadgets/workshop-shared/coding-sessions";

/** Dedicated private notifier configuration; unrelated to personal Slack or ambient JARVIS MCP grants. */
export interface RequestBuildNotifierEnv {
  /** Dedicated bot credential, never forwarded to the backend or sandbox. */
  REQUEST_BUILD_SLACK_TOKEN?: string;
  /** Expected exact channel identity, not proof of accessibility or type. */
  REQUEST_BUILD_SLACK_CHANNEL?: string;
  /** Expected Slack workspace identity. */
  REQUEST_BUILD_SLACK_TEAM_ID?: string;
  /** Expected token bot user identity returned by auth.test. */
  REQUEST_BUILD_SLACK_BOT_USER_ID?: string;
  /** Expected token bot identity returned by auth.test. */
  REQUEST_BUILD_SLACK_BOT_ID?: string;
  /** Expected ordinary channel type; never inferred from its ID prefix. */
  REQUEST_BUILD_SLACK_CHANNEL_TYPE?: string;
  /** Operator release/credential configuration label, not a revocation or verification attestation. */
  REQUEST_BUILD_NOTIFIER_GENERATION?: string;
  /** Canonical Workshop HTTPS origin, including no path, query or fragment. */
  REQUEST_BUILD_WORKSHOP_ORIGIN?: string;
}

function configuration(env: RequestBuildNotifierEnv) {
  const token = env.REQUEST_BUILD_SLACK_TOKEN, channel = env.REQUEST_BUILD_SLACK_CHANNEL;
  const origin = env.REQUEST_BUILD_WORKSHOP_ORIGIN, generation = env.REQUEST_BUILD_NOTIFIER_GENERATION;
  const team = env.REQUEST_BUILD_SLACK_TEAM_ID, user = env.REQUEST_BUILD_SLACK_BOT_USER_ID, bot = env.REQUEST_BUILD_SLACK_BOT_ID;
  const channelType = env.REQUEST_BUILD_SLACK_CHANNEL_TYPE;
  if (!token || token.length > 4096 || /\s/.test(token) || !channel || !/^[CG][A-Z0-9]{8,20}$/.test(channel) || !origin ||
      !team || !/^T[A-Z0-9]{8,20}$/.test(team) || !user || !/^[UW][A-Z0-9]{8,20}$/.test(user) ||
      !bot || !/^B[A-Z0-9]{8,20}$/.test(bot) || !generation || !/^[A-Za-z0-9_-]{1,128}$/.test(generation) ||
      (channelType !== "public" && channelType !== "private")) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return null;
    return { token, channel, origin, generation, team, user, bot, channelType };
  } catch { return null; }
}
type Configuration = NonNullable<ReturnType<typeof configuration>>;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Shared stream bound: a provider's Content-Length is not a memory bound. No body/header is logged or persisted.
async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("NOTIFIER_RESPONSE_INVALID");
  let text = "", length = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 32_768) { await reader.cancel(); throw new Error("NOTIFIER_RESPONSE_INVALID"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  const data: unknown = JSON.parse(text);
  if (!object(data)) throw new Error("NOTIFIER_RESPONSE_INVALID");
  return data;
}

async function readSlack(config: Configuration, method: "auth.test" | "conversations.info", signal: AbortSignal) {
  const url = new URL(`https://slack.com/api/${method}`);
  if (method === "conversations.info") url.searchParams.set("channel", config.channel);
  const response = await fetch(url, { method: "GET", redirect: "manual", signal,
    headers: { Authorization: `Bearer ${config.token}` } });
  const data = await responseBody(response);
  const scopeHeader = response.headers.get("x-oauth-scopes");
  const scopes = new Set(scopeHeader?.split(",").map(scope => scope.trim()));
  if (response.status !== 200 || data.ok !== true || "error" in data || !scopeHeader || scopeHeader.length > 8192 ||
      !scopes.has("chat:write") || !scopes.has(config.channelType === "private" ? "groups:read" : "channels:read")) {
    throw new Error("NOTIFIER_DESTINATION_UNVERIFIED");
  }
  return data;
}

function destinationMatches(channel: Record<string, unknown>, config: Configuration): boolean {
  if (channel.id !== config.channel || channel.context_team_id !== config.team || channel.is_member !== true ||
      channel.is_private !== (config.channelType === "private") || channel.is_archived !== false ||
      channel.is_im !== false || channel.is_mpim !== false || channel.is_shared !== false ||
      channel.is_ext_shared !== false || channel.is_org_shared !== false) return false;
  // Slack's old private-group representation is ordinary too; do not infer privacy from C/G.
  if (!(channel.is_channel === true && channel.is_group === false) &&
      !(config.channelType === "private" && channel.is_channel === false && channel.is_group === true)) return false;
  // These flags/arrays are optional in documented ordinary conversation responses. If present,
  // they must be unambiguously safe; missing required identity/type/member fields above always deny.
  for (const field of ["is_pending_ext_shared", "is_frozen", "is_read_only", "is_thread_only"]) {
    if (field in channel && channel[field] !== false) return false;
  }
  for (const field of ["pending_shared", "pending_connected_team_ids"]) {
    if (field in channel && (!Array.isArray(channel[field]) || channel[field].length !== 0)) return false;
  }
  if ("shared_team_ids" in channel && (!Array.isArray(channel.shared_team_ids) ||
      channel.shared_team_ids.some(team => team !== config.team))) return false;
  return true;
}

async function verifyDestination(config: Configuration): Promise<RequestBuildNotifierReadiness> {
  const checkedAt = Date.now();
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 4000);
  try {
    const identity = await readSlack(config, "auth.test", controller.signal);
    if (identity.team_id !== config.team || identity.user_id !== config.user || identity.bot_id !== config.bot ||
        ("is_enterprise_install" in identity && identity.is_enterprise_install !== false)) throw new Error("NOTIFIER_IDENTITY_MISMATCH");
    const info = await readSlack(config, "conversations.info", controller.signal);
    if (!object(info.channel) || !destinationMatches(info.channel, config) || Date.now() >= checkedAt + 30_000) {
      throw new Error("NOTIFIER_DESTINATION_UNVERIFIED");
    }
    return { protocol: "request-build-slack-v1", configured: true, destinationVerified: true, posting: "unproven",
      origin: config.origin, generation: config.generation, checkedAt, expiresAt: checkedAt + 30_000 };
  } catch {
    return { protocol: "request-build-slack-v1", configured: true, destinationVerified: false, posting: "unproven" };
  } finally { clearTimeout(deadline); }
}

/** Fresh Slack-owned identity/access evidence only. No positive cache or automatic posting probe. */
export async function requestBuildNotifierReadiness(env: RequestBuildNotifierEnv): Promise<RequestBuildNotifierReadiness> {
  const config = configuration(env);
  return config ? verifyDestination(config) : { protocol: "request-build-slack-v1", configured: false, destinationVerified: false, posting: "unproven" };
}

/** Fixed Slack transport. Checks and send share one current token/config snapshot; no caller supplies evidence. */
export async function sendRequestBuildNotification(env: RequestBuildNotifierEnv, request: RequestBuildNotification, generation: string): Promise<RequestBuildNotificationResult> {
  const config = configuration(env);
  if (!config || generation !== config.generation) return { status: "blocked", notificationKey: request.notificationKey };
  validateRequestBuildNotification(request, config.origin);
  const result = (status: "ambiguous" | "blocked"): RequestBuildNotificationResult => ({ status, notificationKey: request.notificationKey });
  if (!(await verifyDestination(config)).destinationVerified) return result("blocked");
  const requestUrl = `${config.origin}/requests/${request.requestId}`;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Authorization": `Bearer ${config.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: config.channel,
        text: `Draft community-request PR created. Request: ${requestUrl}\nRun: ${requestUrl}/runs/${request.runId}\nPR: https://github.com/totango/odie-os/pull/${request.prNumber}`,
        unfurl_links: false, unfurl_media: false }),
    });
    const data = await responseBody(response);
    if (response.status === 200 && data.ok === true && data.channel === config.channel &&
        typeof data.ts === "string" && /^[0-9]{10,16}\.[0-9]{6}$/.test(data.ts) && !("error" in data)) {
      return { status: "acknowledged", notificationKey: request.notificationKey, receipt: data.ts };
    }
    // Slack documents HTTP429 + Retry-After as non-delivery. Conflicting/malformed responses do not qualify.
    const retry = response.headers.get("Retry-After");
    if (response.status === 429 && data.ok === false &&
        (data.error === "ratelimited" || data.error === "rate_limited") && !("ts" in data) &&
        retry && /^[1-9][0-9]{0,4}$/.test(retry) && Number(retry) <= 3600) {
      return { status: "retry", notificationKey: request.notificationKey, retryAfterSeconds: Number(retry) };
    }
    return result("ambiguous");
  } catch { return result("ambiguous"); }
  finally { clearTimeout(deadline); }
}

/** Backend service binding only. Not returned by JARVIS accounts, catalog, sessions or default fetch. */
export class RequestBuildNotifierEntrypoint extends WorkerEntrypoint<RequestBuildNotifierEnv> implements RequestBuildNotifier {
  /** Bounded fresh checks; never proves actual posting permission or delivery. */
  requestBuildNotifierReadiness() { return requestBuildNotifierReadiness(this.env); }
  /** Validates fixed-link intent and rechecks destination before the only write-capable HTTP call. */
  notifyRequestBuild(request: RequestBuildNotification, generation: string) { return sendRequestBuildNotification(this.env, request, generation); }
}
