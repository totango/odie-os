import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const moduleUrl = new URL("../packages/integration-tests/src/worker-inputs.ts", import.meta.url);
const backend = fileURLToPath(new URL("../packages/workshop-backend/", import.meta.url));

for (const variable of ["BUNDLED_BLUEPRINTS_DIR", "FEATURED_BLUEPRINTS_DIR"]) {
  test(`integration watch tracks external ${variable} inputs and deletions`, () => {
    // Fresh processes keep the module's environment-derived table isolated between cases.
    const override = "../../../polaris-external-blueprints";
    const root = resolve(backend, override).replaceAll("\\", "/");
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { WATCH_PATHS, FORCE_RERUN_TRIGGERS, isWorkerInput } from ${JSON.stringify(moduleUrl.href)};
      const root = ${JSON.stringify(root)};
      console.log(JSON.stringify({
        watched: WATCH_PATHS.includes(root),
        reruns: FORCE_RERUN_TRIGGERS.includes(root + '/**'),
        deletedInput: isWorkerInput(root + '/starter/client.js'),
        neighboringDirectory: isWorkerInput(root + '-other/starter/client.js'),
      }));
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLED_BLUEPRINTS_DIR: "",
        FEATURED_BLUEPRINTS_DIR: "",
        [variable]: override,
      },
    }));
    assert.deepEqual(result, {
      watched: true,
      reruns: true,
      deletedInput: true,
      neighboringDirectory: false,
    });
  });
}
