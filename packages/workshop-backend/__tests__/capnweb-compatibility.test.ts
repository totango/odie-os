import { RpcTarget, newHttpBatchRpcResponse, newHttpBatchRpcSession } from "capnweb";
import { expect, it, vi } from "vitest";

it("propagates missing-method and programmer failures over a local HTTP batch without orphaned futures", async () => {
  class Root extends RpcTarget {
    fail(): never { throw new Error("deliberate-programmer-failure"); }
    async number(): Promise<number> { return 7; }
    add(value: number): number { return value + 1; }
  }
  const localFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://compatibility.test/") throw new Error("Unexpected test fetch URL.");
    return newHttpBatchRpcResponse(request, new Root());
  });
  try {
    // Deliberately adversarial client interface: the method does not exist on the actual root.
    using missing = newHttpBatchRpcSession<{ missing(): Promise<void> }>("https://compatibility.test/");
    const denied = missing.missing();
    let missingError: unknown;
    try { await denied; } catch (error) { missingError = error; }
    expect(missingError).toBeInstanceOf(TypeError);
    if (!(missingError instanceof Error)) throw new Error("Expected the original denial.");
    expect(missingError.message).toContain("not a function");
    // Re-observation and an application-owned forwarding promise retain the exact error object.
    const forwarded = (async () => {
      try { await denied; } catch (error) {
        expect(error).toBe(missingError);
        throw error;
      }
    })();
    await expect(forwarded).rejects.toBe(missingError);
    using failure = newHttpBatchRpcSession<Root>("https://compatibility.test/");
    let programmerError: unknown;
    try { await failure.fail(); } catch (error) { programmerError = error; }
    expect(programmerError).toBeInstanceOf(Error);
    if (!(programmerError instanceof Error)) throw new Error("Expected the programmer failure.");
    expect(programmerError.message).toBe("deliberate-programmer-failure");
    using pipeline = newHttpBatchRpcSession<Root>("https://compatibility.test/");
    expect(await pipeline.add(pipeline.number())).toBe(8);
    expect(localFetch).toHaveBeenCalledTimes(3);
  } finally {
    localFetch.mockRestore();
  }
});
