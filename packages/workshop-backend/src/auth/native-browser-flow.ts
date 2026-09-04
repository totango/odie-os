import { DurableObject } from "cloudflare:workers";

export const NATIVE_BROWSER_FLOW_TTL_MS = 10 * 60 * 1000;

export type NativeBrowserFlowKind = "login" | "connect" | "reconnect" | "grant";
export type NativeBrowserFlowStatus = "pending" | "completed" | "failed" | "expired" | "consumed";

const RECORD_KEY = "record";

export interface NativeBrowserFlowRecord {
  version: 1;
  kind: NativeBrowserFlowKind;
  flowHandle: string;
  launchTicket: string;
  launchConsumed?: boolean;
  clientVerifierHash: string;
  providerInitiationUrl: string;
  userId?: string;
  createdAt: number;
  expiresAt: number;
  status: NativeBrowserFlowStatus;
  loginToken?: string;
  errorMessage?: string;
}

export type NativeAccountFlowStatusResult =
  | { status: "pending" | "completed" | "expired" | "consumed" }
  | { status: "failed"; message: string };

export type NativeLoginConsumeResult =
  | { status: "completed"; token: string }
  | { status: "pending" }
  | { status: "expired" | "consumed" | "verifier-mismatch" }
  | { status: "failed"; message: string };

export function createNativeBrowserFlowRecord(input: {
  kind: NativeBrowserFlowKind;
  flowHandle: string;
  launchTicket: string;
  clientVerifierHash: string;
  providerInitiationUrl: string;
  userId?: string;
  now?: number;
}): NativeBrowserFlowRecord {
  const now = input.now ?? Date.now();
  const providerUrl = new URL(input.providerInitiationUrl);
  if (providerUrl.protocol !== "https:") throw new Error("provider initiation URL must be https");
  return {
    version: 1,
    kind: input.kind,
    flowHandle: input.flowHandle,
    launchTicket: input.launchTicket,
    clientVerifierHash: input.clientVerifierHash,
    providerInitiationUrl: providerUrl.toString(),
    userId: input.userId,
    createdAt: now,
    expiresAt: now + NATIVE_BROWSER_FLOW_TTL_MS,
    status: "pending",
  };
}

export function nativeBrowserFlowStatus(record: NativeBrowserFlowRecord, now = Date.now()): NativeBrowserFlowStatus {
  if ((record.status === "pending" || record.status === "completed") && now >= record.expiresAt) return "expired";
  return record.status;
}

export class NativeBrowserFlow extends DurableObject<Cloudflare.Env> {
  async initialize(record: NativeBrowserFlowRecord): Promise<void> {
    const existing = await this.ctx.storage.get<NativeBrowserFlowRecord>(RECORD_KEY);
    if (existing) throw new Error("Native browser flow already initialized.");
    await this.ctx.storage.put(RECORD_KEY, record);
    this.ctx.storage.setAlarm(record.expiresAt);
  }

  async launch(launchTicket: string): Promise<string> {
    const record = await this.#record();
    await this.#assertNotExpired(record);
    if (record.launchConsumed || !constantTimeEqual(record.launchTicket, launchTicket)) {
      throw new Error("Native browser flow launch link is invalid or already used.");
    }
    record.launchConsumed = true;
    await this.#put(record);
    return record.providerInitiationUrl;
  }

  async completeLogin(token: string): Promise<void> {
    const record = await this.#record();
    await this.#assertNotExpired(record);
    if (record.kind !== "login") throw new Error("Native browser flow is not a login flow.");
    if (record.status !== "pending") return;
    record.status = "completed";
    record.loginToken = token;
    await this.#put(record);
  }

  async completeAccount(): Promise<void> {
    const record = await this.#record();
    await this.#assertNotExpired(record);
    if (record.kind === "login") throw new Error("Native browser flow is not an account flow.");
    if (record.status !== "pending") return;
    record.status = "completed";
    await this.#put(record);
  }

  async fail(message: string): Promise<void> {
    const record = await this.#record();
    if (record.status === "consumed") return;
    record.status = "failed";
    record.errorMessage = message;
    delete record.loginToken;
    await this.#put(record);
  }

  async consumeLoginResult(clientVerifierHash: string): Promise<NativeLoginConsumeResult> {
    const record = await this.#record();
    if (!constantTimeEqual(record.clientVerifierHash, clientVerifierHash)) return { status: "verifier-mismatch" };
    if (record.kind !== "login") throw new Error("Native browser flow is not a login flow.");
    const status = nativeBrowserFlowStatus(record);
    if (status === "expired") {
      record.status = "expired";
      delete record.loginToken;
      await this.#put(record);
      return { status: "expired" };
    }
    if (status === "failed") return { status: "failed", message: record.errorMessage ?? "Native login failed." };
    if (status === "consumed") return { status: "consumed" };
    if (status !== "completed" || !record.loginToken) return { status: "pending" };
    const token = record.loginToken;
    record.status = "consumed";
    delete record.loginToken;
    await this.#put(record);
    return { status: "completed", token };
  }

  async getAccountStatus(clientVerifierHash: string, userId?: string): Promise<NativeAccountFlowStatusResult> {
    const record = await this.#record();
    this.#assertVerifier(record, clientVerifierHash);
    if (record.userId && record.userId !== userId) throw new Error("Native browser flow belongs to a different user.");
    const status = nativeBrowserFlowStatus(record);
    if (status === "expired" && record.status !== "expired") {
      record.status = "expired";
      delete record.loginToken;
      await this.#put(record);
    }
    if (status === "failed") return { status, message: record.errorMessage ?? "Native browser flow failed." };
    return { status };
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<NativeBrowserFlowRecord>(RECORD_KEY);
    if (!record) return;
    if (nativeBrowserFlowStatus(record) === "expired") {
      record.status = "expired";
      delete record.loginToken;
      await this.#put(record);
    }
  }

  async #record(): Promise<NativeBrowserFlowRecord> {
    const record = await this.ctx.storage.get<NativeBrowserFlowRecord>(RECORD_KEY);
    if (!record) throw new Error("Native browser flow not found.");
    return record;
  }

  async #put(record: NativeBrowserFlowRecord): Promise<void> {
    await this.ctx.storage.put(RECORD_KEY, record);
  }

  async #assertNotExpired(record: NativeBrowserFlowRecord): Promise<void> {
    if (nativeBrowserFlowStatus(record) === "expired") {
      record.status = "expired";
      delete record.loginToken;
      await this.#put(record);
      throw new Error("Native browser flow has expired.");
    }
  }

  #assertVerifier(record: NativeBrowserFlowRecord, verifierHash: string): void {
    if (!constantTimeEqual(record.clientVerifierHash, verifierHash)) throw new Error("Native browser flow verifier mismatch.");
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}
