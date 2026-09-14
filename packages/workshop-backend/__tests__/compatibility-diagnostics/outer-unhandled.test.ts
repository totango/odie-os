import { RpcTarget, newHttpBatchRpcResponse, newHttpBatchRpcSession } from "capnweb";
import { it, vi } from "vitest";

it("DIAGNOSTIC EXPECTED FAILURE: unobserved caller-owned promise remains unhandled", async () => {
  class Root extends RpcTarget { fail(): never { throw new Error("UNOBSERVED_OUTER_CALLER_FAILURE"); } }
  const localFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://compatibility.test/") throw new Error("Unexpected diagnostic URL.");
    return newHttpBatchRpcResponse(request, new Root());
  });
  try {
    using batch = newHttpBatchRpcSession<Root>("https://compatibility.test/");
    // Intentionally left unobserved only in this explicitly selected diagnostic, never the default suite.
    void Promise.resolve(batch.fail());
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally { localFetch.mockRestore(); }
});
