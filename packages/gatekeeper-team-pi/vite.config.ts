import gatekeeperConfiguratorConfig from "../../scripts/gatekeeper-configurator-vite-config.js";
import { vitestTask } from "../../scripts/vitest-task-vite-config.js";

const sharedTasks = gatekeeperConfiguratorConfig.run.tasks;

export default {
  run: {
    tasks: {
      ...sharedTasks,
      "build:app": {
        command: "node build-app.mjs",
        dependsOn: ["clean:error-reporting-artifacts"],
        input: [
          { auto: true },
          { pattern: "!**/src/generated/**", base: "workspace" },
          { pattern: "!**/dist-app/**", base: "workspace" },
          { pattern: "!**/.wrangler/**", base: "workspace" },
        ],
        output: ["src/generated/app.txt", "dist-app/**"],
        env: ["VITE_FRONTEND_ERROR_REPORTING"],
      },
      "typecheck:app": {
        command: "tsc -p tsconfig.app.json && tsc -p tsconfig.vite.json",
        dependsOn: ["build:app"],
      },
      build: {
        command: "tsc",
        dependsOn: ["build:configurator", "build:app", "typecheck:app"],
      },
      test: vitestTask(["vitest run", "vitest run -c vitest.app.config.ts"]),
    },
  },
};
