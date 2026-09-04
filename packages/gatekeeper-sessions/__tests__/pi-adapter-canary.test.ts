import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("pinned pi-mcp-adapter iframe fail-closed canary", () => {
  it("runs against the exact 2.26 package source during image build", () => {
    const lock = JSON.parse(readFileSync(join(root, "pi-image/package-lock.json"), "utf8"));
    expect(lock.packages["node_modules/pi-mcp-adapter"].version).toBe("2.26.0");

    const canary = readFileSync(
      join(root, "pi-image/verify-mcp-app-fail-closed.mjs"), "utf8");
    expect(canary).toContain('isUiToolCallableByApp(["model"])');
    expect(canary).toContain('indexOf("connection.client.callTool")');

    const dockerfile = readFileSync(join(root, "Dockerfile.pi"), "utf8");
    expect(dockerfile).toContain("pi-image/verify-mcp-app-fail-closed.mjs");
    expect(dockerfile).toContain("/opt/odie-pi/verify-mcp-app-fail-closed.mjs");
  });
});
