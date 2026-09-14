import { cancellationMatches, runScenario, scenarios } from "./scenarios";
import type { MatrixEnv } from "./provider";
export { MatrixAuthority, MatrixService } from "./provider";

/** Standalone-only local request driver; no external fetch or capability input. */
export default {
  async fetch(request: Request, env: MatrixEnv): Promise<Response> {
    const name = new URL(request.url).pathname.slice(1);
    if (name === "ready") {
      // Preflight uses the SAME class/storage operations and actual disposer, not a timer pass.
      const key = crypto.randomUUID();
      const authority = env.MATRIX_AUTHORITY.getByName(key);
      try {
        const child = await env.MATRIX_SERVICE.child(key);
        try {
          if (await authority.write() !== 1 || (await authority.stats()).writes !== 1) {
            throw new Error("MATRIX_STORAGE_PREFLIGHT");
          }
        } finally { child[Symbol.dispose](); }
        const deadline = Date.now() + 5000;
        let stats = await authority.stats();
        while (stats.disposals !== 1 && Date.now() < deadline) {
          await new Promise<void>(resolve => setTimeout(resolve, 5));
          stats = await authority.stats();
        }
        if (stats.disposals !== 1) throw new Error("MATRIX_DISPOSAL_PREFLIGHT");
        return Response.json({ready: true, stats});
      } catch (error) {
        return Response.json({infrastructureFailure: error instanceof Error ? error.message : String(error)}, {status: 503});
      }
    }
    const scenario = scenarios.find(value => value === name);
    if (!scenario) return new Response("Unknown scenario", {status: 404});
    const result = await runScenario(env, scenario);
    const accepted = result.unhandled.length === 0 && result.assertionFailure === null
      && result.cleanupFailure === null && cancellationMatches(result);
    return Response.json(result, {status: accepted ? 200 : 500});
  },
};
