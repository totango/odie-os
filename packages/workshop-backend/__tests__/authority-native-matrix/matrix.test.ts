import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { cancellationMatches, runScenario, scenarios } from "./scenarios";
import type { MatrixEnv } from "./provider";

declare global {
  namespace Cloudflare { interface Env extends MatrixEnv {} }
}

for (const scenario of scenarios) {
  it(`native matrix: ${scenario}`, async (context) => {
    const result = await runScenario(env, scenario);
    Object.assign(context.task.meta, {nativeMatrix: result});
    await context.annotate(JSON.stringify(result), "native-matrix");
    expect.soft(result.assertionFailure).toBeNull();
    expect.soft(result.cleanupFailure).toBeNull();
    expect.soft(result.unhandled).toEqual([]);
    expect.soft(cancellationMatches(result), "producer cancellation propagation expectation").toBe(true);
  });
}
