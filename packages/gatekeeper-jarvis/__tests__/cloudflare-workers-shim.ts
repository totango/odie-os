export class DurableObject<Env = unknown, Props = unknown> {
  env!: Env;
  ctx!: ExecutionContext<Props>;
}

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  env!: Env;
  ctx!: ExecutionContext<Props>;
}

export class RpcTarget {
  readonly __rpcTarget = true;
}

export class RpcStub<T = unknown> {
  constructor(readonly value?: T) {}
  dup(): RpcStub<T> { return new RpcStub(this.value); }
  [Symbol.dispose](): void {}
}
