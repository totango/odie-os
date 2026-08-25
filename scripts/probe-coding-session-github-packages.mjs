import { createHash, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { githubPackagesAuthorityManifest } from
  "../packages/gatekeeper-sessions/src/github-packages-authority.ts";

const FIRST_ORIGIN = "https://npm.pkg.github.com";
const MAX_REDIRECTS = 3;
const RANGE_LIMIT = 64 * 1024;
const FULL_LIMIT = 32 * 1024 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADERS = 32;
export const TRANSPORT_MAX_HEADERS_COUNT = MAX_HEADERS + 1;
const HEADER_TIMEOUT_MS = 10_000;
const BODY_IDLE_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const GLOBAL_PROBE_TIMEOUT_MS = 60_000;
const CLEAN_LAUNCH_SENTINEL = "ODIE_GITHUB_PACKAGES_PROBE_CLEAN";
const OUTPUT_SCHEMA = "odie.coding-session.github-packages-transport-evidence";
const OUTPUT_SCHEMA_VERSION = 1;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HAZARDOUS_ENV = [
  "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED", "SSLKEYLOGFILE", "SSL_CERT_DIR", "SSL_CERT_FILE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
];
const ERROR_CODES = new Set([
  "ARGUMENTS_INVALID", "AUTH_INVALID", "BODY_TIMEOUT", "CLEANUP_TIMEOUT",
  "CLEAN_LAUNCH_REQUIRED", "CONTENT_ENCODING_INVALID",
  "CONTENT_LENGTH_INVALID", "CONTENT_TYPE_INVALID", "DNS_PRIVATE", "DNS_REBINDING",
  "DNS_TIMEOUT", "DNS_UNAVAILABLE", "FULL_BODY_TOO_LARGE", "FULL_LENGTH_MISMATCH", "FULL_STATUS_INVALID",
  "HEADER_LIMIT", "HEADER_TIMEOUT", "INTEGRITY_MISMATCH", "INTERNAL", "NETWORK_ERROR",
  "PROBE_TIMEOUT",
  "PROXY_ENV_UNSAFE", "RANGE_BODY_INVALID", "RANGE_HEADER_INVALID", "RANGE_STATUS_INVALID",
  "REDIRECT_HOST_NOT_ALLOWED", "REDIRECT_INVALID", "REDIRECT_LIMIT", "REDIRECT_LOOP",
  "RESPONSE_HEADER_INVALID", "STDIN_INVALID", "TOKEN_INVALID", "TOTAL_TIMEOUT",
]);

const blockedAddresses = { ipv4: new BlockList(), ipv6: new BlockList() };
for (const [network, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.31.196.0", 24, "ipv4"],
  ["192.52.193.0", 24, "ipv4"], ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"], ["192.175.48.0", 24, "ipv4"], ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"], ["100::", 64, "ipv6"], ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"], ["2002::", 16, "ipv6"], ["3ffe::", 16, "ipv6"],
  ["3fff::", 20, "ipv6"], ["5f00::", 16, "ipv6"], ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
]) blockedAddresses[family].addSubnet(network, prefix, family);

export class ProbeFailure extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ProbeFailure";
    this.code = ERROR_CODES.has(code) ? code : "INTERNAL";
    this.details = details;
  }
}

export function canonicalEvidenceJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  return `{${Object.keys(value).toSorted().map(key =>
    `${JSON.stringify(key)}:${canonicalEvidenceJson(value[key])}`).join(",")}}`;
}

function identityHash(value) {
  return createHash("sha256").update(canonicalEvidenceJson(value)).digest("hex");
}

/** Binds aggregate output to the exact private authority without listing repository/package facts. */
export function authorityEvidenceBinding() {
  const authority = githubPackagesAuthorityManifest();
  return {
    manifestSha256: identityHash(authority),
    sourceSha256: identityHash(authority.source),
    artifacts: authority.artifacts.map((artifact, index) => ({
      ordinal: index + 1,
      sha256: identityHash(artifact),
    })),
  };
}

export function parseProbeArguments(argv) {
  let authMode;
  let username;
  const allowedRedirectHosts = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new ProbeFailure("ARGUMENTS_INVALID");
    if (argument === "--auth" && !authMode) authMode = value;
    else if (argument === "--username" && !username) username = value;
    else if (argument === "--allow-redirect-host") allowedRedirectHosts.add(normalizeHostname(value));
    else throw new ProbeFailure("ARGUMENTS_INVALID");
  }
  if (authMode !== "bearer" && authMode !== "basic") throw new ProbeFailure("AUTH_INVALID");
  if (authMode === "basic") {
    if (!username || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(username)) {
      throw new ProbeFailure("AUTH_INVALID");
    }
  } else if (username !== undefined) {
    throw new ProbeFailure("AUTH_INVALID");
  }
  return { authMode, username, allowedRedirectHosts };
}

export function assertSafeEnvironment(env) {
  if (env[CLEAN_LAUNCH_SENTINEL] !== "1") throw new ProbeFailure("CLEAN_LAUNCH_REQUIRED");
  if (HAZARDOUS_ENV.some(name => typeof env[name] === "string" && env[name].trim() !== "")) {
    throw new ProbeFailure("PROXY_ENV_UNSAFE");
  }
}

export async function readTokenFromStdin(stdin) {
  if (stdin.isTTY) throw new ProbeFailure("STDIN_INVALID");
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_TOKEN_BYTES + 2) {
      bytes.fill(0);
      for (const saved of chunks) saved.fill(0);
      throw new ProbeFailure("TOKEN_INVALID");
    }
    chunks.push(bytes);
  }
  const token = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  if (token.at(-1) === 0x0a) {
    const suffixLength = token.at(-2) === 0x0d ? 2 : 1;
    const shortened = Buffer.from(token.subarray(0, token.length - suffixLength));
    token.fill(0);
    return validateToken(shortened);
  }
  return validateToken(token);
}

function validateToken(token) {
  if (token.length === 0 || token.length > MAX_TOKEN_BYTES ||
      token.some(byte => byte < 0x21 || byte > 0x7e)) {
    token.fill(0);
    throw new ProbeFailure("TOKEN_INVALID");
  }
  return token;
}

export function authorizationFor(options, token) {
  const text = token.toString("ascii");
  return options.authMode === "bearer"
    ? `Bearer ${text}`
    : `Basic ${Buffer.from(`${options.username}:${text}`, "ascii").toString("base64")}`;
}

export function normalizeHostname(value) {
  if (typeof value !== "string" || value !== value.toLowerCase() || value.endsWith(".") ||
      value.length > 253 || isIP(value) !== 0 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(value)) {
    throw new ProbeFailure("REDIRECT_INVALID");
  }
  return value;
}

export function isPublicAddress(address, family) {
  const normalizedFamily = family === 4 || family === "IPv4" ? "ipv4" :
    family === 6 || family === "IPv6" ? "ipv6" : null;
  const parsedFamily = isIP(address);
  if (normalizedFamily === null || parsedFamily !== (normalizedFamily === "ipv4" ? 4 : 6)) return false;
  if (normalizedFamily === "ipv6" && !isGlobalUnicastIpv6(address)) return false;
  return !blockedAddresses[normalizedFamily].check(address, normalizedFamily);
}

function isGlobalUnicastIpv6(address) {
  const first = address.split(":", 1)[0];
  if (!/^[0-9a-f]{1,4}$/i.test(first)) return false;
  const value = Number.parseInt(first, 16);
  return value >= 0x2000 && value <= 0x3fff;
}

function settleDnsPromise(promise) {
  return Promise.resolve(promise).then(
    addresses => ({ addresses }),
    error => ({ error }),
  );
}

function toleratedEmptyDnsFamily(error) {
  return error && typeof error === "object" &&
    (error.code === "ENODATA" || error.code === "ENOTFOUND");
}

/** Resolves both address families and cancels the native Resolver when the signal aborts. */
export async function resolveDnsRecords(hostname, {
  signal = /** @type {AbortSignal | undefined} */ (undefined),
  resolverFactory = /** @type {() => any} */ (() => new Resolver()),
} = {}) {
  const resolver = resolverFactory();
  const ipv4 = settleDnsPromise(Promise.resolve().then(() => resolver.resolve4(hostname)));
  const ipv6 = settleDnsPromise(Promise.resolve().then(() => resolver.resolve6(hostname)));
  const onAbort = () => {
    try { resolver.cancel(); } catch { /* cancellation is best-effort and errors stay fixed */ }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const [result4, result6] = await Promise.all([ipv4, ipv6]);
    for (const result of [result4, result6]) {
      if (result.error && !toleratedEmptyDnsFamily(result.error)) throw result.error;
    }
    return [
      ...(result4.addresses ?? []).map(address => ({ address, family: 4 })),
      ...(result6.addresses ?? []).map(address => ({ address, family: 6 })),
    ];
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function systemResolver(hostname, options) {
  return resolveDnsRecords(hostname, options);
}

export async function resolvePinnedHost(
  hostname,
  resolver = systemResolver,
  timeoutMs = DNS_TIMEOUT_MS,
  globalSignal = /** @type {AbortSignal | undefined} */ (undefined),
) {
  const controller = new AbortController();
  let timer;
  let onGlobalAbort;
  let records;
  try {
    const resolution = Promise.resolve().then(() => resolver(hostname, { signal: controller.signal }));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProbeFailure("DNS_TIMEOUT", { host: hostname }));
      }, timeoutMs);
    });
    const globalAbort = new Promise((_, reject) => {
      onGlobalAbort = () => {
        controller.abort();
        reject(new ProbeFailure("PROBE_TIMEOUT"));
      };
      globalSignal?.addEventListener("abort", onGlobalAbort, { once: true });
      if (globalSignal?.aborted) onGlobalAbort();
    });
    records = await Promise.race([resolution, timeout, globalAbort]);
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure("DNS_UNAVAILABLE", { host: hostname });
  } finally {
    clearTimeout(timer);
    if (onGlobalAbort) globalSignal?.removeEventListener("abort", onGlobalAbort);
    controller.abort();
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new ProbeFailure("DNS_UNAVAILABLE", { host: hostname });
  }
  if (records.some(record => !isPublicAddress(record.address, record.family))) {
    throw new ProbeFailure("DNS_PRIVATE", { host: hostname });
  }
  const first = records[0];
  return { hostname, address: first.address, family: first.family === 6 || first.family === "IPv6" ? 6 : 4 };
}

export async function requestFollowingRedirects({
  initialUrl,
  authorization,
  allowedRedirectHosts,
  resolver = systemResolver,
  requester = httpsRequestOnce,
  requestHeaders,
  signal = undefined,
}) {
  const pins = new Map();
  const visited = new Set([initialUrl.href]);
  const hops = [];
  let current = initialUrl;
  let redirects = 0;
  let authAllowed = true;
  while (true) {
    const hostname = normalizeHostname(current.hostname);
    let pin = pins.get(hostname);
    if (!pin) {
      pin = await resolvePinnedHost(hostname, resolver, DNS_TIMEOUT_MS, signal);
      pins.set(hostname, pin);
    }
    const headers = { ...requestHeaders };
    if (authAllowed) headers.authorization = authorization;
    const response = await requester({ url: current, headers, pin, signal });
    hops.push({ host: hostname, status: response.status });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, hops };
    response.cancel();
    if (redirects++ >= MAX_REDIRECTS) throw new ProbeFailure("REDIRECT_LIMIT");
    const location = singleHeader(response.headers, "location");
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new ProbeFailure("REDIRECT_INVALID");
    }
    if (next.protocol !== "https:" || next.port !== "" || next.username || next.password || next.hash) {
      throw new ProbeFailure("REDIRECT_INVALID");
    }
    const nextHost = normalizeHostname(next.hostname);
    if (next.origin !== current.origin) {
      authAllowed = false;
      if (!allowedRedirectHosts.has(nextHost)) {
        throw new ProbeFailure("REDIRECT_HOST_NOT_ALLOWED", { host: nextHost, status: response.status });
      }
    }
    if (visited.has(next.href)) throw new ProbeFailure("REDIRECT_LOOP");
    visited.add(next.href);
    current = next;
  }
}

export async function readBoundedBody(
  response,
  limit,
  { hash = false, idleMs = BODY_IDLE_TIMEOUT_MS, cleanupMs = CLEANUP_TIMEOUT_MS } = {},
) {
  let iterator;
  try {
    const declared = optionalContentLength(response.headers);
    if (declared !== null && declared > limit) {
      throw new ProbeFailure(limit === FULL_LIMIT ? "FULL_BODY_TOO_LARGE" : "RANGE_BODY_INVALID");
    }
    const digest = hash ? createHash("sha512") : null;
    iterator = response.body[Symbol.asyncIterator]();
    let bytes = 0;
    try {
      while (true) {
        const result = await nextWithTimeout(iterator.next(), idleMs);
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        bytes += chunk.length;
        if (bytes > limit) {
          throw new ProbeFailure(limit === FULL_LIMIT ? "FULL_BODY_TOO_LARGE" : "RANGE_BODY_INVALID");
        }
        digest?.update(chunk);
      }
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure("NETWORK_ERROR");
    }
    if (declared !== null && declared !== bytes) throw new ProbeFailure("FULL_LENGTH_MISMATCH");
    return { bytes, digest: digest?.digest() ?? null };
  } finally {
    response.cancel();
    await cleanupIterator(iterator, cleanupMs);
  }
}

async function readBodyPrefix(response, limit, idleMs = BODY_IDLE_TIMEOUT_MS) {
  let iterator;
  try {
    const declared = optionalContentLength(response.headers);
    if (declared !== null && declared > limit) return { bytes: 0, truncated: true };
    iterator = response.body[Symbol.asyncIterator]();
    let bytes = 0;
    try {
      while (true) {
        const result = await nextWithTimeout(iterator.next(), idleMs);
        if (result.done) return { bytes, truncated: false };
        bytes += Buffer.byteLength(result.value);
        if (bytes >= limit) return { bytes: limit, truncated: bytes > limit || declared !== limit };
      }
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure("NETWORK_ERROR");
    }
  } finally {
    response.cancel();
    await cleanupIterator(iterator);
  }
}

async function cleanupIterator(iterator, timeoutMs = CLEANUP_TIMEOUT_MS) {
  if (!iterator?.return) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => iterator.return()).catch(() => undefined),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure("CLEANUP_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextWithTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure("BODY_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeArtifact(artifact, ordinal, options) {
  const initialUrl = new URL(artifact.tarballPath, `${FIRST_ORIGIN}/`);
  if (initialUrl.origin !== FIRST_ORIGIN || initialUrl.search || initialUrl.hash) {
    throw new ProbeFailure("INTERNAL");
  }
  const base = {
    initialUrl,
    authorization: options.authorization,
    allowedRedirectHosts: options.allowedRedirectHosts,
    resolver: options.resolver,
    requester: options.requester,
    signal: options.signal,
  };
  const rangeResult = await requestFollowingRedirects({
    ...base,
    requestHeaders: fixedHeaders({ range: "bytes=0-0" }),
  });
  const rangeResponse = rangeResult.response;
  let rangeBehavior;
  let rangeBytes;
  let rangeTruncated;
  let rangeTotalBytes = null;
  let rangeType;
  try {
    assertIdentityEncoding(rangeResponse.headers);
    rangeType = normalizedContentType(rangeResponse.headers);
    if (rangeResponse.status === 206) {
      const contentRange = singleHeader(rangeResponse.headers, "content-range");
      const match = /^bytes 0-0\/(\d+)$/.exec(contentRange);
      if (!match) throw new ProbeFailure("RANGE_HEADER_INVALID", { ordinal });
      rangeTotalBytes = Number(match[1]);
      if (!Number.isSafeInteger(rangeTotalBytes) || rangeTotalBytes < 1) {
        throw new ProbeFailure("RANGE_HEADER_INVALID", { ordinal });
      }
      if (rangeTotalBytes > FULL_LIMIT) throw new ProbeFailure("FULL_BODY_TOO_LARGE", { ordinal });
      const rangeBody = await readBoundedBody(rangeResponse, RANGE_LIMIT);
      if (rangeBody.bytes !== 1) throw new ProbeFailure("RANGE_BODY_INVALID", { ordinal });
      rangeBehavior = "supported";
      rangeBytes = rangeBody.bytes;
      rangeTruncated = false;
    } else if (rangeResponse.status === 200) {
      const prefix = await readBodyPrefix(rangeResponse, RANGE_LIMIT);
      rangeBehavior = "ignored";
      rangeBytes = prefix.bytes;
      rangeTruncated = prefix.truncated;
    } else {
      throw new ProbeFailure("RANGE_STATUS_INVALID", { ordinal, status: rangeResponse.status });
    }
  } finally {
    rangeResponse.cancel();
  }

  const fullResult = await requestFollowingRedirects({ ...base, requestHeaders: fixedHeaders() });
  const fullResponse = fullResult.response;
  let fullBody;
  let fullType;
  try {
    assertIdentityEncoding(fullResponse.headers);
    fullType = normalizedContentType(fullResponse.headers);
    if (fullResponse.status !== 200) {
      throw new ProbeFailure("FULL_STATUS_INVALID", { ordinal, status: fullResponse.status });
    }
    fullBody = await readBoundedBody(fullResponse, FULL_LIMIT, { hash: true });
    if (rangeTotalBytes !== null && fullBody.bytes !== rangeTotalBytes) {
      throw new ProbeFailure("FULL_LENGTH_MISMATCH", { ordinal });
    }
    const expected = Buffer.from(artifact.integrity.slice("sha512-".length), "base64");
    if (!fullBody.digest || expected.length !== fullBody.digest.length ||
        !timingSafeEqual(expected, fullBody.digest)) {
      throw new ProbeFailure("INTEGRITY_MISMATCH", { ordinal });
    }
  } finally {
    fullResponse.cancel();
  }
  return {
    ordinal,
    range: {
      hops: rangeResult.hops,
      behavior: rangeBehavior,
      supported: rangeBehavior === "supported",
      truncated: rangeTruncated,
      bytes: rangeBytes,
      totalBytes: fullBody.bytes,
      type: rangeType,
    },
    full: {
      hops: fullResult.hops,
      bytes: fullBody.bytes,
      type: fullType,
      integrity: "match",
    },
  };
}

export async function runEvidenceProbe(options) {
  const authority = githubPackagesAuthorityManifest();
  if (authority.complete !== false || authority.available !== false || authority.artifacts.length !== 2) {
    throw new ProbeFailure("INTERNAL");
  }
  const controller = new AbortController();
  const timeoutMs = options.probeTimeoutMs ?? GLOBAL_PROBE_TIMEOUT_MS;
  let timer;
  const work = (async () => {
    const artifacts = [];
    for (const [index, artifact] of authority.artifacts.entries()) {
      artifacts.push(await probeArtifact(artifact, index + 1, { ...options, signal: controller.signal }));
    }
    return { ok: true, authMode: options.authMode, artifacts };
  })();
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProbeFailure("PROBE_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function main(dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  let token;
  try {
    const argv = dependencies.argv ?? process.argv.slice(2);
    const env = dependencies.env ?? process.env;
    const stdin = dependencies.stdin ?? process.stdin;
    assertSafeEnvironment(env);
    const parsed = parseProbeArguments(argv);
    token = await readTokenFromStdin(stdin);
    const authorization = authorizationFor(parsed, token);
    token.fill(0);
    token = undefined;
    const run = dependencies.runProbe ?? runEvidenceProbe;
    const result = await run({
      ...parsed,
      authorization,
      resolver: dependencies.resolver,
      requester: dependencies.requester,
    });
    stdout.write(`${JSON.stringify({
      schema: OUTPUT_SCHEMA,
      schemaVersion: OUTPUT_SCHEMA_VERSION,
      authority: authorityEvidenceBinding(),
      ...result,
    })}\n`);
    return 0;
  } catch (error) {
    token?.fill(0);
    const failure = sanitizedFailure(error);
    stdout.write(`${JSON.stringify(failure)}\n`);
    return 1;
  }
}

function sanitizedFailure(error) {
  const failure = error instanceof ProbeFailure ? error : new ProbeFailure("INTERNAL");
  const details = {};
  if (Number.isInteger(failure.details.ordinal)) details.ordinal = failure.details.ordinal;
  if (Number.isInteger(failure.details.status) && failure.details.status >= 100 && failure.details.status <= 599) {
    details.status = failure.details.status;
  }
  if (typeof failure.details.host === "string") {
    try { details.host = normalizeHostname(failure.details.host); } catch { /* omit */ }
  }
  return {
    schema: OUTPUT_SCHEMA,
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    authority: safeAuthorityEvidenceBinding(),
    ok: false,
    error: { code: failure.code, ...details },
  };
}

function safeAuthorityEvidenceBinding() {
  try {
    return authorityEvidenceBinding();
  } catch {
    return { manifestSha256: null, sourceSha256: null, artifacts: [] };
  }
}

function fixedHeaders(extra = {}) {
  return {
    accept: "application/octet-stream",
    "accept-encoding": "identity",
    "user-agent": "odie-os-github-packages-evidence-probe",
    ...extra,
  };
}

const CRITICAL_RESPONSE_HEADERS = new Set([
  "location", "content-length", "content-range", "content-encoding", "content-type",
]);

/** Returns only strict critical headers from the raw wire list and rejects duplicates. */
export function parseCriticalResponseHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0 || rawHeaders.length / 2 > MAX_HEADERS ||
      rawHeaders.some(value => typeof value !== "string") ||
      rawHeaders.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > MAX_HEADER_BYTES) {
    throw new ProbeFailure("HEADER_LIMIT");
  }
  const normalized = Object.create(null);
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (!CRITICAL_RESPONSE_HEADERS.has(name)) continue;
    if (Object.hasOwn(normalized, name)) throw new ProbeFailure("RESPONSE_HEADER_INVALID");
    const value = rawHeaders[index + 1];
    if (/[\r\n]/.test(value)) throw new ProbeFailure("RESPONSE_HEADER_INVALID");
    normalized[name] = value;
  }
  return normalized;
}

/** Parses critical wire headers and destroys ownership immediately on rejection. */
export function parseOwnedResponseHeaders(response) {
  try {
    return parseCriticalResponseHeaders(response.rawHeaders ?? []);
  } catch (error) {
    response.destroy();
    throw error;
  }
}

function headerValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) throw new ProbeFailure("RESPONSE_HEADER_INVALID");
  return value === undefined ? null : String(value);
}

function singleHeader(headers, name) {
  const value = headerValue(headers, name);
  if (value === null || value.length === 0 || value.length > 8 * 1024 || /[\r\n]/.test(value)) {
    throw new ProbeFailure("RESPONSE_HEADER_INVALID");
  }
  return value;
}

function optionalContentLength(headers) {
  const value = headerValue(headers, "content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new ProbeFailure("CONTENT_LENGTH_INVALID");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new ProbeFailure("CONTENT_LENGTH_INVALID");
  return length;
}

function assertIdentityEncoding(headers) {
  const value = headerValue(headers, "content-encoding");
  if (value !== null && value.toLowerCase() !== "identity") {
    throw new ProbeFailure("CONTENT_ENCODING_INVALID");
  }
}

function normalizedContentType(headers) {
  const value = headerValue(headers, "content-type");
  if (value === null) return "missing";
  const type = value.split(";", 1)[0].trim().toLowerCase();
  if (type.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    throw new ProbeFailure("CONTENT_TYPE_INVALID");
  }
  return type;
}

export function httpsRequestOnce({ url, headers, pin, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProbeFailure("PROBE_TIMEOUT"));
      return;
    }
    let failureCode = "NETWORK_ERROR";
    let settled = false;
    let onAbort;
    const totalTimer = setTimeout(() => {
      failureCode = "TOTAL_TIMEOUT";
      request.destroy();
    }, TOTAL_TIMEOUT_MS);
    const headerTimer = setTimeout(() => {
      failureCode = "HEADER_TIMEOUT";
      request.destroy();
    }, HEADER_TIMEOUT_MS);
    const cleanupTimers = () => {
      clearTimeout(totalTimer);
      clearTimeout(headerTimer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    };
    const request = https.request(url, {
      method: "GET",
      headers,
      servername: url.hostname,
      maxHeaderSize: MAX_HEADER_BYTES,
      agent: false,
      autoSelectFamily: false,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, [{ address: pin.address, family: pin.family }]);
        else callback(null, pin.address, pin.family);
      },
    }, response => {
      clearTimeout(headerTimer);
      let normalizedHeaders;
      try {
        normalizedHeaders = parseOwnedResponseHeaders(response);
      } catch (error) {
        failureCode = error instanceof ProbeFailure ? error.code : "HEADER_LIMIT";
        response.destroy();
        cleanupTimers();
        if (!settled) reject(new ProbeFailure(failureCode));
        settled = true;
        return;
      }
      response.setTimeout(BODY_IDLE_TIMEOUT_MS, () => {
        failureCode = "BODY_TIMEOUT";
        response.destroy();
      });
      response.once("end", cleanupTimers);
      response.once("close", cleanupTimers);
      settled = true;
      resolve({
        status: response.statusCode ?? 0,
        headers: normalizedHeaders,
        body: sanitizedBody(response, () => failureCode),
        cancel() {
          response.destroy();
          cleanupTimers();
        },
        pinnedAddress: pin.address,
      });
    });
    onAbort = () => {
      failureCode = "PROBE_TIMEOUT";
      request.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Preserve one overflow header so the strict raw-header parser can detect > MAX_HEADERS.
    request.maxHeadersCount = TRANSPORT_MAX_HEADERS_COUNT;
    request.once("error", () => {
      cleanupTimers();
      if (!settled) reject(new ProbeFailure(failureCode));
      settled = true;
    });
    request.end();
  });
}

async function* sanitizedBody(body, failureCode) {
  try {
    for await (const chunk of body) yield chunk;
  } catch {
    throw new ProbeFailure(failureCode());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { process.exitCode = code; });
}
