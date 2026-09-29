import { DurableObject } from "cloudflare:workers";
import { hashPresentedSecret } from "../connect-handoff";

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
  /** Private rendezvous for ticket-confirmed login; never returned to the browser or app. */
  pendingLoginId?: string;
  /** Private user-DO nonce, redeemable only after the native verifier and ticket arrive together. */
  accountNonce?: string;
  /** Proof retained while the user DO's activation outcome is being reconciled. */
  accountTicketHash?: string;
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
  pendingLoginId?: string;
  accountNonce?: string;
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
    pendingLoginId: input.pendingLoginId,
    accountNonce: input.accountNonce,
    createdAt: now,
    expiresAt: now + NATIVE_BROWSER_FLOW_TTL_MS,
    status: "pending",
  };
}

export function nativeBrowserFlowStatus(record: NativeBrowserFlowRecord, now = Date.now()): NativeBrowserFlowStatus {
  // Once activation was dispatched, expiry is not proof that it failed. Keep the verifier until
  // the private outcome can be reconciled; never tell a client to discard an ambiguous result.
  if (record.status === "pending" && record.accountTicketHash) return "pending";
  if ((record.status === "pending" || record.status === "completed") && now >= record.expiresAt) return "expired";
  return record.status;
}

export class NativeBrowserFlow extends DurableObject<Cloudflare.Env> {
  #accountRedemption: Promise<void> = Promise.resolve();
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
    throw new Error("Native login requires a completion ticket. Start a new flow.");
  }

  async completeAccount(): Promise<void> {
    throw new Error("Native account completion requires a ticket. Start a new flow.");
  }

  async fail(message: string): Promise<void> {
    const record = await this.#record();
    if (record.status === "consumed" || record.status === "completed" || record.accountTicketHash) return;
    record.status = "failed";
    record.errorMessage = message;
    delete record.loginToken;
    await this.#put(record);
  }

  async consumeLoginResult(clientVerifierHash: string, ticket?: string): Promise<NativeLoginConsumeResult> {
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
    // Pre-cutover callbacks delivered directly to this object. Never release those results through
    // verifier-only polling: that would let the initiator of a phished launch URL sign in as its victim.
    if (!record.pendingLoginId) {
      delete record.loginToken;
      record.status = "failed";
      record.errorMessage = "Native login requires an upgraded provider. Start a new flow.";
      await this.#put(record);
      return {status: "failed", message: record.errorMessage};
    }
    if (!ticket) return {status: "pending"};
    const pending = this.ctx.exports.PendingLogin.get(
        this.ctx.exports.PendingLogin.idFromString(record.pendingLoginId));
    await pending.confirm(ticket);
    const token = await pending.receive();
    if (!token) return {status: "pending"};
    if (Date.now() >= record.expiresAt) {
      record.status = "expired";
      await this.#put(record);
      return {status: "expired"};
    }
    record.status = "consumed";
    delete record.loginToken;
    await this.#put(record);
    return { status: "completed", token };
  }

  /** Native account activation still redeems through the initiating user's ordinary ticket store. */
  async completeAccountHandoff(clientVerifierHash: string, ticket: string, userId: string): Promise<void> {
    const operation = this.#accountRedemption.then(() => this.#completeAccountHandoff(clientVerifierHash, ticket, userId));
    this.#accountRedemption = operation.catch(() => {});
    return operation;
  }

  async #completeAccountHandoff(clientVerifierHash: string, ticket: string, userId: string): Promise<void> {
    const record = await this.#record();
    this.#assertVerifier(record, clientVerifierHash);
    await this.#assertNotExpired(record);
    if (record.kind === "login" || record.userId !== userId || record.status !== "pending" || !record.accountNonce) {
      throw new Error("Native account flow is not redeemable.");
    }
    const ticketHash = await hashPresentedSecret(ticket);
    if (!ticketHash || (record.accountTicketHash && record.accountTicketHash !== ticketHash)) {
      throw new Error("Native handoff ticket mismatch.");
    }
    const users = this.ctx.exports.UserDurableObject;
    const user = users.get(users.idFromString(userId));
    if (record.accountTicketHash) {
      const outcome = await user.nativeHandoffOutcome(record.flowHandle, ticketHash);
      if (outcome === "completed") {
        record.status = "completed";
        delete record.accountNonce;
        await this.#put(record);
        return;
      }
      if (outcome === "pending") throw new Error("NATIVE_HANDOFF_OUTCOME_PENDING");
    }
    const nonce = record.accountNonce;
    record.accountTicketHash = ticketHash;
    await this.#put(record);
    try {
      await user.completeConnectHandoff(ticket, nonce);
    } catch (error) {
      // A lost acknowledgement may follow successful activation. Query durable evidence, never
      // replay a pending activation. If delivery never began, the caller can retry the same proof.
      if (await user.nativeHandoffOutcome(record.flowHandle, ticketHash) !== "completed") throw error;
    }
    record.status = "completed";
    delete record.accountNonce;
    await this.#put(record);
  }

  async getAccountStatus(clientVerifierHash: string, userId?: string): Promise<NativeAccountFlowStatusResult> {
    const record = await this.#record();
    this.#assertVerifier(record, clientVerifierHash);
    if (record.userId && record.userId !== userId) throw new Error("Native browser flow belongs to a different user.");
    if (record.status === "pending" && record.accountTicketHash && record.userId) {
      const users = this.ctx.exports.UserDurableObject;
      if (await users.get(users.idFromString(record.userId)).nativeHandoffOutcome(
          record.flowHandle, record.accountTicketHash) === "completed") {
        record.status = "completed";
        delete record.accountNonce;
        await this.#put(record);
      }
    }
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
