import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  ProbeFailure,
  TRANSPORT_MAX_HEADERS_COUNT,
  assertSafeEnvironment,
  authorityEvidenceBinding,
  canonicalEvidenceJson,
  isPublicAddress,
  main,
  parseCriticalResponseHeaders,
  parseOwnedResponseHeaders,
  parseProbeArguments,
  probeArtifact,
  readBoundedBody,
  readTokenFromStdin,
  requestFollowingRedirects,
  resolveDnsRecords,
  resolvePinnedHost,
  runEvidenceProbe,
} from "./probe-coding-session-github-packages.mjs";
import { githubPackagesAuthorityManifest } from
  "../packages/gatekeeper-sessions/src/github-packages-authority.ts";

const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
const cleanEnv = { ODIE_GITHUB_PACKAGES_PROBE_CLEAN: "1" };

function bodyResponse(status: number, headers: Record<string, string> = {}, chunks: Array<string | Buffer> = []) {
  let cancelled = false;
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    cancel() { cancelled = true; },
    get cancelled() { return cancelled; },
  };
}

function delayedResponse(delayMs: number) {
  let cancelled = false;
  return {
    status: 200,
    headers: {},
    body: (async function* () {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      yield Buffer.from("late");
    })(),
    cancel() { cancelled = true; },
    get cancelled() { return cancelled; },
  };
}

function assertFailure(error: unknown, code: string) {
  assert.ok(error instanceof ProbeFailure);
  assert.equal(error.code, code);
  return true;
}

function canonicalForTest(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).toSorted().map(key =>
    `${JSON.stringify(key)}:${canonicalForTest(record[key])}`).join(",")}}`;
}

function sha256ForTest(value: unknown): string {
  return createHash("sha256").update(canonicalForTest(value)).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

describe("GitHub Packages probe argument and secret boundary", () => {
  it("requires one explicit auth mode and validates exact redirect hosts", () => {
    const bearer = parseProbeArguments([
      "--auth", "bearer", "--allow-redirect-host", "objects.example.com",
    ]);
    assert.equal(bearer.authMode, "bearer");
    assert.deepEqual([...bearer.allowedRedirectHosts], ["objects.example.com"]);
    assert.equal(parseProbeArguments(["--auth", "basic", "--username", "github-user"]).username,
      "github-user");
    assert.throws(() => parseProbeArguments([]), error => assertFailure(error, "AUTH_INVALID"));
    assert.throws(() => parseProbeArguments(["--auth", "bearer", "--token", "secret"]),
      error => assertFailure(error, "ARGUMENTS_INVALID"));
    assert.throws(() => parseProbeArguments([
      "--auth", "bearer", "--allow-redirect-host", "127.0.0.1",
    ]), error => assertFailure(error, "REDIRECT_INVALID"));
  });

  it("reads a bounded ASCII token only from non-TTY stdin", async () => {
    const stdin = Readable.from([Buffer.from("stdin-token\r\n")]);
    Object.assign(stdin, { isTTY: false });
    const token = await readTokenFromStdin(stdin);
    assert.equal(token.toString("ascii"), "stdin-token");
    token.fill(0);

    const tty = Readable.from(["token"]);
    Object.assign(tty, { isTTY: true });
    await assert.rejects(readTokenFromStdin(tty), error => assertFailure(error, "STDIN_INVALID"));
    const multiline = Readable.from(["first\nsecond"]);
    Object.assign(multiline, { isTTY: false });
    await assert.rejects(readTokenFromStdin(multiline), error => assertFailure(error, "TOKEN_INVALID"));
    const oversized = Readable.from([Buffer.alloc(4_100, 0x61)]);
    Object.assign(oversized, { isTTY: false });
    await assert.rejects(readTokenFromStdin(oversized), error => assertFailure(error, "TOKEN_INVALID"));
  });

  it("rejects debug and proxy environments without inspecting their values", () => {
    assert.doesNotThrow(() => assertSafeEnvironment({ ...cleanEnv, PATH: "/bin" }));
    assert.throws(() => assertSafeEnvironment({ PATH: "/bin" }),
      error => assertFailure(error, "CLEAN_LAUNCH_REQUIRED"));
    for (const name of ["NODE_DEBUG", "NODE_OPTIONS", "HTTPS_PROXY", "http_proxy", "LD_PRELOAD", "LD_AUDIT",
      "DYLD_INSERT_LIBRARIES"]) {
      assert.throws(() => assertSafeEnvironment({ ...cleanEnv, [name]: "unsafe" }),
        error => assertFailure(error, "PROXY_ENV_UNSAFE"));
    }
  });

  it("prints only bounded fixed JSON when an internal error contains secrets and URLs", async () => {
    const stdin = Readable.from(["super-secret-token"]);
    Object.assign(stdin, { isTTY: false });
    let output = "";
    const code = await main({
      argv: ["--auth", "bearer"],
      env: cleanEnv,
      stdin,
      stdout: { write(value: string) { output += value; } },
      runProbe: async () => {
        throw new Error("super-secret-token https://npm.pkg.github.com/private?signature=secret");
      },
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(output);
    assert.equal(parsed.schema, "odie.coding-session.github-packages-transport-evidence");
    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(parsed.authority, authorityEvidenceBinding());
    assert.deepEqual(parsed.error, { code: "INTERNAL" });
    assert.equal(parsed.ok, false);
    assert.doesNotMatch(output, /secret|https|private|signature/i);
  });

  it("does not echo a token on successful aggregate output", async () => {
    const stdin = Readable.from(["another-secret-token"]);
    Object.assign(stdin, { isTTY: false });
    let output = "";
    const code = await main({
      argv: ["--auth", "bearer"], env: cleanEnv, stdin,
      stdout: { write(value: string) { output += value; } },
      runProbe: async ({ authorization }: { authorization: string }) => {
        assert.equal(authorization, "Bearer another-secret-token");
        return { ok: true, authMode: "bearer", artifacts: [] };
      },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.authority, authorityEvidenceBinding());
    assert.doesNotMatch(output, /another-secret-token|totango|posthog|unison-core|download/i);
  });

  it("binds output to independently recomputed exact private authority hashes", () => {
    const authority = githubPackagesAuthorityManifest();
    const expected = {
      manifestSha256: sha256ForTest(authority),
      sourceSha256: sha256ForTest(authority.source),
      artifacts: authority.artifacts.map((artifact, index) => ({
        ordinal: index + 1, sha256: sha256ForTest(artifact),
      })),
    };
    assert.equal(canonicalEvidenceJson(authority), canonicalForTest(authority));
    assert.deepEqual(authorityEvidenceBinding(), expected);
  });

  it("trusted launcher uses only the explicitly reviewed Node path and digest", async () => {
    const launcher = fileURLToPath(new URL("./probe-coding-session-github-packages", import.meta.url));
    const digest = await sha256File(process.execPath);
    const temporary = mkdtempSync(join(tmpdir(), "odie-probe-fake-node-"));
    const fakeNode = join(temporary, "node");
    const marker = join(temporary, "fake-node-ran");
    writeFileSync(fakeNode, `#!/bin/sh\nprintf fake >${JSON.stringify(marker)}\n`);
    chmodSync(fakeNode, 0o755);
    try {
      const result = spawnSync(launcher, [
        "--node", process.execPath, "--node-sha256", digest, "--invalid",
      ], {
        input: "must-not-appear",
        encoding: "utf8",
        env: {
          PATH: `${temporary}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          NODE_OPTIONS: "--definitely-invalid",
        },
      });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.error.code, "ARGUMENTS_INVALID");
      assert.deepEqual(output.authority, authorityEvidenceBinding());
      assert.equal(existsSync(marker), false);
      assert.equal(result.stdout.includes(process.execPath), false);
      assert.doesNotMatch(result.stdout,
        new RegExp(`must-not-appear|definitely-invalid|NODE_OPTIONS|${digest}`));

      const wrongDigest = spawnSync(launcher, [
        "--node", process.execPath, "--node-sha256", "0".repeat(64), "--auth", "bearer",
      ], {
        input: "token-must-not-be-read", encoding: "utf8",
        env: { PATH: `${temporary}:/usr/bin:/bin` },
      });
      assert.equal(wrongDigest.status, 1);
      assert.equal(JSON.parse(wrongDigest.stdout).error.code, "NODE_DIGEST_MISMATCH");
      assert.doesNotMatch(wrongDigest.stdout, /token-must-not-be-read/);
      assert.equal(existsSync(marker), false);

      const traced = spawnSync("/bin/sh", ["-x", launcher], {
        input: "must-not-appear", encoding: "utf8",
        env: { PATH: `${temporary}:/usr/bin:/bin` },
      });
      assert.equal(traced.status, 1);
      assert.equal(JSON.parse(traced.stdout).error.code, "XTRACE_UNSAFE");
      assert.doesNotMatch(`${traced.stdout}${traced.stderr}`, /must-not-appear/);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("GitHub Packages probe SSRF and DNS pinning", () => {
  it("rejects private, special, mapped, and documentation ranges", () => {
    for (const address of [
      "0.0.0.1", "10.1.2.3", "100.64.1.1", "127.0.0.1", "169.254.1.1",
      "172.16.0.1", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.168.1.1",
      "192.175.48.1", "198.18.0.1", "198.51.100.1",
      "203.0.113.1", "224.0.0.1", "255.255.255.255",
    ]) assert.equal(isPublicAddress(address, 4), false, address);
    for (const address of [
      "::", "::1", "::192.0.2.1", "::ffff:127.0.0.1", "64:ff9b::1", "2001:db8::1",
      "2002:7f00:1::", "3ffe::1", "3fff::1", "4000::1", "5f00::1", "fc00::1",
      "fe80::1", "ff00::1",
    ]) {
      assert.equal(isPublicAddress(address, 6), false, address);
    }
    assert.equal(isPublicAddress("8.8.8.8", 4), true);
    assert.equal(isPublicAddress("2606:4700:4700::1111", 6), true);
  });

  it("rejects a host when any DNS answer is private", async () => {
    await assert.rejects(resolvePinnedHost("cdn.example.com", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]), error => assertFailure(error, "DNS_PRIVATE"));
  });

  it("resolves once and passes the same pinned address through same-host redirects", async () => {
    let resolutions = 0;
    const pins: string[] = [];
    const responses = [
      bodyResponse(302, { location: "/next" }),
      bodyResponse(200, {}, ["ok"]),
    ];
    const result = await requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/locked"),
      authorization: "Bearer test",
      allowedRedirectHosts: new Set(),
      resolver: async () => {
        resolutions++;
        return [{ address: resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
      },
      requester: async ({ pin }: { pin: { address: string } }) => {
        pins.push(pin.address);
        return responses.shift()!;
      },
      requestHeaders: {},
    });
    assert.equal(result.response.status, 200);
    result.response.cancel();
    assert.equal(result.response.cancelled, true);
    assert.equal(resolutions, 1);
    assert.deepEqual(pins, ["8.8.8.8", "8.8.8.8"]);
  });

  it("resolves A and AAAA independently and cancels the native-style resolver", async () => {
    const noData = Object.assign(new Error("no A records"), { code: "ENODATA" });
    const records = await resolveDnsRecords("cdn.example.com", {
      resolverFactory: () => ({
        resolve4: async () => { throw noData; },
        resolve6: async () => ["2606:4700:4700::1111"],
        cancel() {},
      }),
    });
    assert.deepEqual(records, [{ address: "2606:4700:4700::1111", family: 6 }]);

    let cancelCalls = 0;
    let reject4!: (error: Error) => void;
    let reject6!: (error: Error) => void;
    const pendingResolver = {
      resolve4: () => new Promise<string[]>((_resolve, reject) => { reject4 = reject; }),
      resolve6: () => new Promise<string[]>((_resolve, reject) => { reject6 = reject; }),
      cancel() {
        cancelCalls++;
        const cancelled = Object.assign(new Error("cancelled"), { code: "ECANCELLED" });
        reject4(cancelled);
        reject6(cancelled);
      },
    };
    const global = new AbortController();
    const pending = resolvePinnedHost(
      "cdn.example.com",
      (hostname: string, { signal }: { signal: AbortSignal }) =>
        resolveDnsRecords(hostname, { signal, resolverFactory: () => pendingResolver }),
      5_000,
      global.signal,
    );
    await new Promise(resolve => setImmediate(resolve));
    global.abort();
    await assert.rejects(pending, error => assertFailure(error, "PROBE_TIMEOUT"));
    assert.equal(cancelCalls, 1);

    let timeoutCancelCalls = 0;
    let timeoutReject4!: (error: Error) => void;
    let timeoutReject6!: (error: Error) => void;
    const timeoutResolver = {
      resolve4: () => new Promise<string[]>((_resolve, reject) => { timeoutReject4 = reject; }),
      resolve6: () => new Promise<string[]>((_resolve, reject) => { timeoutReject6 = reject; }),
      cancel() {
        timeoutCancelCalls++;
        const cancelled = Object.assign(new Error("cancelled"), { code: "ECANCELLED" });
        timeoutReject4(cancelled);
        timeoutReject6(cancelled);
      },
    };
    await assert.rejects(resolvePinnedHost(
      "cdn.example.com",
      (hostname: string, { signal }: { signal: AbortSignal }) =>
        resolveDnsRecords(hostname, { signal, resolverFactory: () => timeoutResolver }),
      1,
    ), error => assertFailure(error, "DNS_TIMEOUT"));
    assert.equal(timeoutCancelCalls, 1);
  });

  it("bounds DNS resolution and observes a later resolver rejection", async () => {
    let unhandled = false;
    const handler = () => { unhandled = true; };
    process.once("unhandledRejection", handler);
    try {
      await assert.rejects(resolvePinnedHost("cdn.example.com", () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("late secret")), 10)), 1),
      error => assertFailure(error, "DNS_TIMEOUT"));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(unhandled, false);
    } finally {
      process.removeListener("unhandledRejection", handler);
    }
  });
});

describe("GitHub Packages probe redirect policy", () => {
  it("strips auth permanently after a cross-host redirect, including after returning", async () => {
    const seen: Array<{ host: string; authorization?: string }> = [];
    const allResponses = [
      bodyResponse(302, { location: "https://objects.example.com/signed?hidden=yes" }),
      bodyResponse(302, { location: "https://npm.pkg.github.com/returned" }),
      bodyResponse(200, {}, ["ok"]),
    ];
    const responses = [...allResponses];
    const result = await requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/locked"),
      authorization: "Bearer never-log-this",
      allowedRedirectHosts: new Set(["objects.example.com", "npm.pkg.github.com"]),
      resolver: publicDns,
      requester: async ({ url, headers }: { url: URL; headers: Record<string, string> }) => {
        seen.push({ host: url.hostname, authorization: headers.authorization });
        return responses.shift()!;
      },
      requestHeaders: {},
    });
    result.response.cancel();
    assert.ok(allResponses.every(response => response.cancelled));
    assert.deepEqual(seen, [
      { host: "npm.pkg.github.com", authorization: "Bearer never-log-this" },
      { host: "objects.example.com", authorization: undefined },
      { host: "npm.pkg.github.com", authorization: undefined },
    ]);
  });

  it("blocks unapproved hosts, unsafe schemes, loops, and more than three redirects", async () => {
    await assert.rejects(requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/locked"), authorization: "Bearer x",
      allowedRedirectHosts: new Set(), resolver: publicDns, requestHeaders: {},
      requester: async () => bodyResponse(302, { location: "https://objects.example.com/signed" }),
    }), error => assertFailure(error, "REDIRECT_HOST_NOT_ALLOWED"));

    await assert.rejects(requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/locked"), authorization: "Bearer x",
      allowedRedirectHosts: new Set(), resolver: publicDns, requestHeaders: {},
      requester: async () => bodyResponse(302, { location: "http://npm.pkg.github.com/plain" }),
    }), error => assertFailure(error, "REDIRECT_INVALID"));

    await assert.rejects(requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/locked"), authorization: "Bearer x",
      allowedRedirectHosts: new Set(), resolver: publicDns, requestHeaders: {},
      requester: async () => bodyResponse(302, { location: "/locked" }),
    }), error => assertFailure(error, "REDIRECT_LOOP"));

    let count = 0;
    await assert.rejects(requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/0"), authorization: "Bearer x",
      allowedRedirectHosts: new Set(), resolver: publicDns, requestHeaders: {},
      requester: async () => bodyResponse(302, { location: `/${++count}` }),
    }), error => assertFailure(error, "REDIRECT_LIMIT"));
    assert.equal(count, 4);
  });

  it("propagates fixed request timeout codes and rejects duplicate redirect headers", async () => {
    await assert.rejects(requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/locked"), authorization: "Bearer x",
      allowedRedirectHosts: new Set(), resolver: publicDns, requestHeaders: {},
      requester: async () => { throw new ProbeFailure("HEADER_TIMEOUT"); },
    }), error => assertFailure(error, "HEADER_TIMEOUT"));

    await assert.rejects(requestFollowingRedirects({
      initialUrl: new URL("https://npm.pkg.github.com/locked"), authorization: "Bearer x",
      allowedRedirectHosts: new Set(), resolver: publicDns, requestHeaders: {},
      requester: async () => bodyResponse(302, { location: ["/one", "/two"] } as never),
    }), error => assertFailure(error, "RESPONSE_HEADER_INVALID"));
  });
});

describe("GitHub Packages probe raw response header parsing", () => {
  it("rejects duplicate critical raw headers even when IncomingMessage.headers hides them", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, [["Location", "/one"], ["location", "/two"]]);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        get(`http://127.0.0.1:${address.port}/`, resolve).once("error", reject);
      });
      assert.equal(typeof incoming.headers.location, "string");
      assert.equal(incoming.rawHeaders.filter((value, index) =>
        index % 2 === 0 && value.toLowerCase() === "location").length, 2);
      assert.throws(() => parseCriticalResponseHeaders(incoming.rawHeaders),
        error => assertFailure(error, "RESPONSE_HEADER_INVALID"));
      incoming.resume();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("preserves one bounded overflow header so late critical headers cannot be hidden", async () => {
    const headers = [
      ...Array.from({ length: 31 }, (_, index) => `X-Filler-${index}: value`),
      "Content-Type: application/octet-stream",
      "Location: /late-reviewed-location",
      ...Array.from({ length: 7 }, (_, index) => `X-Overflow-${index}: must-trigger-the-limit`),
    ];
    const server = createNetServer(socket => {
      socket.once("data", () => {
        socket.end(`HTTP/1.1 302 Found\r\n${headers.join("\r\n")}\r\n\r\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const clientRequest = request({ host: "127.0.0.1", port: address.port, path: "/" }, resolve);
        assert.equal(TRANSPORT_MAX_HEADERS_COUNT, 33);
        clientRequest.maxHeadersCount = TRANSPORT_MAX_HEADERS_COUNT;
        clientRequest.once("error", reject);
        clientRequest.end();
      });
      assert.equal(incoming.rawHeaders.length / 2, 33);
      const names = incoming.rawHeaders.filter((_value, index) => index % 2 === 0)
        .map(value => value.toLowerCase());
      assert.ok(names.includes("content-type"));
      assert.ok(names.includes("location"));
      assert.throws(() => parseOwnedResponseHeaders(incoming),
        error => assertFailure(error, "HEADER_LIMIT"));
      assert.equal(incoming.destroyed, true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("returns only a strict normalized critical subset", () => {
    const parsed = parseCriticalResponseHeaders([
      "Server", "private-value", "Content-Type", "Application/Octet-Stream",
      "CONTENT-LENGTH", "7",
    ]);
    assert.deepEqual({ ...parsed }, {
      "content-type": "Application/Octet-Stream", "content-length": "7",
    });
    assert.equal(Object.hasOwn(parsed, "server"), false);
    for (const name of [
      "location", "content-length", "content-range", "content-encoding", "content-type",
    ]) {
      assert.throws(() => parseCriticalResponseHeaders([name, "one", name.toUpperCase(), "two"]),
        error => assertFailure(error, "RESPONSE_HEADER_INVALID"), name);
    }
  });
});

describe("GitHub Packages probe body bounds and integrity", () => {
  it("enforces declared and streamed byte caps", async () => {
    const declared = bodyResponse(200, { "content-length": "33554433" });
    await assert.rejects(readBoundedBody(declared, 32 * 1024 * 1024),
      error => assertFailure(error, "FULL_BODY_TOO_LARGE"));
    assert.equal(declared.cancelled, true);

    const streamed = bodyResponse(200, {}, [Buffer.alloc(65_536), Buffer.from("x")]);
    await assert.rejects(readBoundedBody(streamed, 65_536),
      error => assertFailure(error, "RANGE_BODY_INVALID"));
    assert.equal(streamed.cancelled, true);

    const malformed = bodyResponse(200, { "content-length": "7, 7" });
    await assert.rejects(readBoundedBody(malformed, 64),
      error => assertFailure(error, "CONTENT_LENGTH_INVALID"));
    assert.equal(malformed.cancelled, true);
  });

  it("enforces idle body timeouts and bounded iterator cleanup", async () => {
    const delayed = delayedResponse(30);
    await assert.rejects(readBoundedBody(delayed, 64, { idleMs: 2 }),
      error => assertFailure(error, "BODY_TIMEOUT"));
    assert.equal(delayed.cancelled, true);

    let cancelled = false;
    const hangingCleanup = {
      headers: {},
      body: {
        [Symbol.asyncIterator]() {
          return { next: async () => ({ done: true }), return: () => new Promise(() => {}) };
        },
      },
      cancel() { cancelled = true; },
    };
    await assert.rejects(readBoundedBody(hangingCleanup, 64, { cleanupMs: 2 }),
      error => assertFailure(error, "CLEANUP_TIMEOUT"));
    assert.equal(cancelled, true);
  });

  it("rejects encoded transport bodies and malformed response metadata", async () => {
    const artifact = {
      tarballPath: "/download/@totango/example/1.0.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      integrity: `sha512-${createHash("sha512").update("x").digest("base64")}`,
    };
    const encoded = bodyResponse(206, {
      "content-encoding": "gzip", "content-range": "bytes 0-0/1", "content-length": "1",
    }, ["x"]);
    await assert.rejects(probeArtifact(artifact, 1, {
      authorization: "Bearer test", allowedRedirectHosts: new Set(), resolver: publicDns,
      requester: async () => encoded,
    }), error => assertFailure(error, "CONTENT_ENCODING_INVALID"));
    assert.equal(encoded.cancelled, true);

    const malformedType = bodyResponse(206, {
      "content-range": "bytes 0-0/1", "content-length": "1",
      "content-type": "text/plain\r\nunsafe: yes",
    }, ["x"]);
    await assert.rejects(probeArtifact(artifact, 1, {
      authorization: "Bearer test", allowedRedirectHosts: new Set(), resolver: publicDns,
      requester: async () => malformedType,
    }), error => assertFailure(error, "CONTENT_TYPE_INVALID"));
    assert.equal(malformedType.cancelled, true);
  });

  it("bounds a server that ignores Range, then verifies the independent full response", async () => {
    const body = Buffer.from("small verified body");
    const artifact = {
      tarballPath: "/download/@totango/example/1.0.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`,
    };
    const ignored = bodyResponse(200, {
      "content-length": "999999",
      "content-type": "application/octet-stream",
    });
    const full = bodyResponse(200, {
      "content-length": String(body.length),
      "content-type": "application/octet-stream",
    }, [body]);
    const responses = [ignored, full];
    const result = await probeArtifact(artifact, 1, {
      authorization: "Bearer test", allowedRedirectHosts: new Set(), resolver: publicDns,
      requester: async () => responses.shift()!,
    });
    assert.equal(ignored.cancelled, true);
    assert.equal(result.range.behavior, "ignored");
    assert.equal(result.range.supported, false);
    assert.equal(result.range.truncated, true);
    assert.equal(result.range.bytes, 0);
    assert.equal(result.range.totalBytes, body.length);
    assert.equal(result.full.integrity, "match");
    assert.equal(full.cancelled, true);
  });

  it("fails before a full request when a supported Range total exceeds 32 MiB", async () => {
    const artifact = {
      tarballPath: "/download/@totango/example/1.0.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      integrity: `sha512-${createHash("sha512").update("x").digest("base64")}`,
    };
    const range = bodyResponse(206, {
      "content-range": `bytes 0-0/${32 * 1024 * 1024 + 1}`,
      "content-length": "1",
    }, ["x"]);
    let requests = 0;
    await assert.rejects(probeArtifact(artifact, 1, {
      authorization: "Bearer test", allowedRedirectHosts: new Set(), resolver: publicDns,
      requester: async () => { requests++; return range; },
    }), error => assertFailure(error, "FULL_BODY_TOO_LARGE"));
    assert.equal(requests, 1);
    assert.equal(range.cancelled, true);
  });

  it("enforces one global probe deadline and aborts the active chain", async () => {
    let observedAbort = false;
    await assert.rejects(runEvidenceProbe({
      authorization: "Bearer test", authMode: "bearer", allowedRedirectHosts: new Set(),
      resolver: publicDns, probeTimeoutMs: 2,
      requester: async ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new ProbeFailure("PROBE_TIMEOUT"));
        }, { once: true });
      }),
    }), error => assertFailure(error, "PROBE_TIMEOUT"));
    assert.equal(observedAbort, true);
  });

  it("accepts only a matching streaming SHA-512 and consistent Range total", async () => {
    const body = Buffer.from("audited tarball bytes");
    const integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`;
    const artifact = {
      tarballPath: "/download/@totango/example/1.0.0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      integrity,
    };
    const makeRequester = (fullBody: Buffer) => {
      const responses = [
        bodyResponse(206, {
          "content-range": `bytes 0-0/${body.length}`,
          "content-length": "1",
          "content-type": "application/octet-stream; charset=binary",
        }, [body.subarray(0, 1)]),
        bodyResponse(200, {
          "content-length": String(fullBody.length),
          "content-type": "application/octet-stream",
        }, [fullBody]),
      ];
      return async () => responses.shift()!;
    };
    const result = await probeArtifact(artifact, 1, {
      authorization: "Bearer test", allowedRedirectHosts: new Set(), resolver: publicDns,
      requester: makeRequester(body),
    });
    assert.equal(result.full.integrity, "match");
    assert.equal(result.full.bytes, body.length);
    assert.equal(result.range.totalBytes, body.length);
    assert.equal(result.range.type, "application/octet-stream");
    assert.equal(result.range.supported, true);
    assert.equal(result.range.truncated, false);

    await assert.rejects(probeArtifact(artifact, 1, {
      authorization: "Bearer test", allowedRedirectHosts: new Set(), resolver: publicDns,
      requester: makeRequester(Buffer.from("tampered tarball byte")),
    }), error => assertFailure(error, "INTEGRITY_MISMATCH"));
  });
});
