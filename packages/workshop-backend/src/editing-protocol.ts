import { WORKSHOP_EDITING_PROTOCOL, type EditingProtocolStatus } from "@gadgets/workshop-shared/api";

/** Deployment-owned pause fences editing and agent work, without disabling gadget runtime reads. */
export function assertEditingAvailable(env: {WORKSHOP_EDITING_PAUSED?: string}): void {
  if (env.WORKSHOP_EDITING_PAUSED === "true") throw new Error("EDITING_CUTOVER_PAUSED");
}

/** A fresh transport capability starts unnegotiated, including capabilities retained by old clients. */
export class EditingProtocolSession {
  #protocol: string | undefined;
  constructor(private paused: () => boolean) {}

  status(): EditingProtocolStatus {
    return {protocol: WORKSHOP_EDITING_PROTOCOL, state: this.paused() ? "paused"
      : this.#protocol === WORKSHOP_EDITING_PROTOCOL ? "ready" : "upgrade-required"};
  }

  negotiate(protocol: string): EditingProtocolStatus {
    this.#protocol = protocol;
    return this.status();
  }

  assertWritable(): void {
    const {state} = this.status();
    if (state !== "ready") throw new Error(state === "paused"
        ? "EDITING_CUTOVER_PAUSED" : "EDITING_PROTOCOL_UPGRADE_REQUIRED");
  }

  assertCompatible(): void {
    if (this.#protocol !== WORKSHOP_EDITING_PROTOCOL) throw new Error("EDITING_PROTOCOL_UPGRADE_REQUIRED");
  }
}
