import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readRepo = (name: string) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("pi-image/package.json"));
const lock = JSON.parse(read("pi-image/package-lock.json"));
const dockerArg = (name: string) => {
  const match = new RegExp(`^ARG ${name}=([^\\n]+)$`, "m").exec(read("Dockerfile.pi"));
  expect(match, `Dockerfile.pi ARG ${name}`).not.toBeNull();
  return match![1];
};
const workflowEnv = (name: string) => {
  const match = new RegExp(`^  ${name}: "([^"]+)"$`, "m").exec(readRepo(".github/workflows/publish-coding-session-image.yml"));
  expect(match, `publish-coding-session-image env ${name}`).not.toBeNull();
  return match![1];
};

describe("repository-owned harness image pins", () => {
  it("pins the verified stable Pi SDK family without floating versions or host paths", () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
    for (const name of ["pi-agent-core", "pi-ai", "pi-client", "pi-coding-agent", "pi-protocol", "pi-telemetry", "pi-tui"]) {
      expect(manifest.dependencies[`@earendil-works/${name}`]).toBe("0.85.1");
      expect(lock.packages[`node_modules/@earendil-works/${name}`].version).toBe("0.85.1");
    }
    expect(lock.packages["node_modules/@earendil-works/pi-coding-agent"].integrity).toBe("sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==");
    for (const [path, value] of Object.entries(lock.packages)) {
      if (!path) continue;
      expect(path).toMatch(/^node_modules\//); expect(path.split("/")).not.toContain("..");
      expect(value).not.toHaveProperty("link");
    }
  });
  it("keeps the publish workflow, Dockerfile, package manifest, and lock in version correspondence", () => {
    expect(dockerArg("PI_VERSION")).toBe("0.85.1");
    expect(workflowEnv("PI_VERSION")).toBe(dockerArg("PI_VERSION"));
    for (const name of ["pi-agent-core", "pi-ai", "pi-client", "pi-coding-agent", "pi-protocol", "pi-telemetry", "pi-tui"]) {
      expect(manifest.dependencies[`@earendil-works/${name}`]).toBe(dockerArg("PI_VERSION"));
      expect(lock.packages[`node_modules/@earendil-works/${name}`].version).toBe(dockerArg("PI_VERSION"));
    }
    expect(dockerArg("OPENCODE_VERSION")).toBe("1.18.30");
    expect(workflowEnv("OPENCODE_VERSION")).toBe(dockerArg("OPENCODE_VERSION"));
    expect(manifest.dependencies["opencode-ai"]).toBe(dockerArg("OPENCODE_VERSION"));
    expect(lock.packages["node_modules/opencode-linux-x64"].version).toBe(dockerArg("OPENCODE_VERSION"));
  });
  it("selects the locked OpenCode overlay rather than the unchanged Sandbox base binary", () => {
    expect(manifest.dependencies["opencode-ai"]).toBe("1.18.30");
    expect(lock.packages["node_modules/opencode-linux-x64"].version).toBe("1.18.30");
    expect(read("Dockerfile.pi")).toContain("ln -sf /opt/odie-pi/node_modules/opencode-linux-x64/bin/opencode /usr/local/bin/opencode");
    expect(read("pi-image/smoke-image.sh")).toContain("OpenCode overlay is not selected");
    expect(read("Dockerfile.pi")).toContain("FROM docker.io/cloudflare/sandbox@sha256:6c8e082085d0861ad3b359041abd4cdc750f5b0e29e7aa82bb87a9b557dbdc60");
  });
  it("pins official Prime 0.9.4 release provenance and its MCP2/Python kernel smoke", () => {
    expect(lock.packages["node_modules/prime-agent"].version).toBe("0.9.4");
    expect(lock.packages["node_modules/prime-agent"].resolved).toBe("https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.4/prime-agent-0.9.4.tgz");
    expect(lock.packages["node_modules/prime-agent"].integrity).toBe("sha512-6FWCvTiS3+o2yX3NWTVQSlPNP0RHhatuoKsl3ZesCn8SvagSuDQ1aCiP7omzKh15AXXPa03BFkrAL+Oo5UuPEw==");
    expect(manifest.dependencies["prime-agent"]).toBe(lock.packages["node_modules/prime-agent"].resolved);
    expect(manifest).not.toHaveProperty("overrides");
    expect(manifest).not.toHaveProperty("resolutions");
    expect(dockerArg("PRIME_AGENT_VERSION")).toBe("0.9.4");
    expect(workflowEnv("PRIME_AGENT_VERSION")).toBe(dockerArg("PRIME_AGENT_VERSION"));
    expect(lock.packages[""].dependencies["prime-agent"]).toBe(manifest.dependencies["prime-agent"]);
    expect(JSON.stringify(lock.packages)).not.toContain("prime-agent-0.8.0.tgz");
    expect(read("Dockerfile.pi")).not.toContain("node /opt/odie-pi/node_modules/zeromq/script/install.js");
    expect(read("Dockerfile.pi")).toContain("python /opt/odie-pi/prime-runtime-smoke.py");
    expect(read("pi-image/smoke-image.sh")).toContain("python /opt/odie-pi/prime-runtime-smoke.py");
  });
  it("refreshes pi-mcp-adapter through its direct parent without legacy peer policy", () => {
    expect(manifest.dependencies["pi-mcp-adapter"]).toBe("2.33.0");
    expect(lock.packages["node_modules/pi-mcp-adapter"].version).toBe("2.33.0");
    expect(lock.packages["node_modules/pi-mcp-adapter"].integrity).toBe("sha512-W1wFtd8NOz9+yAZZEoyEDfz4YMUxHSitPejZo4Yvol1YXQGeYiCfoFqd2k6GulP6k+w/p+L3NU2IcA/nlTkFEQ==");
    expect(dockerArg("PI_MCP_ADAPTER_VERSION")).toBe("2.33.0");
    expect(workflowEnv("PI_MCP_ADAPTER_VERSION")).toBe(dockerArg("PI_MCP_ADAPTER_VERSION"));
    expect(lock.packages["node_modules/pi-mcp-adapter"].peerDependencies["@earendil-works/pi-ai"]).toBe("^0.84.1 || ^0.85.0");
    expect(JSON.stringify(lock.packages)).not.toContain("legacy-peer-deps");
  });
});
