export class RpcTarget {}
export class RpcStub<T = unknown> {
  constructor(private readonly target?: T) {}
  dup(): this { return this; }
  [Symbol.dispose](): void {}
}
export class WorkerEntrypoint<Env = unknown, _Props = unknown> { ctx!: unknown; env!: Env; }
export class DurableObject<Env = unknown, _Props = unknown> { ctx!: unknown; env!: Env; }
