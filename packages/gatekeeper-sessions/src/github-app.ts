const GITHUB_API_ORIGIN = "https://api.github.com";

/** GitHub App credentials accepted by the Sessions Worker. */
export interface GitHubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_PRIVATE_KEY_B64?: string;
}

/** A newly-minted, short-lived GitHub App installation token. */
export type GitHubInstallationToken = {
  token: string;
  expiresAt: number;
};

/** Mints a read-only token spanning repositories installed for the organization App. */
export function mintGitHubOrganizationToken(env: GitHubAppEnv): Promise<GitHubInstallationToken> {
  return mintGitHubInstallationToken(env, {
    permissions: { contents: "read", metadata: "read" },
  });
}

/** Mints a write token constrained to the repositories selected for one coding session. */
export function mintGitHubCodingSessionToken(
  env: GitHubAppEnv,
  repositories: string[],
): Promise<GitHubInstallationToken> {
  return mintGitHubInstallationToken(env, {
    repositories,
    permissions: { contents: "write", metadata: "read" },
  });
}

/** Mints a read-only token constrained to odie-os for autonomous feedback analysis. */
export function mintGitHubProductFeedbackReadToken(env: GitHubAppEnv): Promise<GitHubInstallationToken> {
  return mintGitHubInstallationToken(env, {
    repositories: ["odie-os"],
    permissions: { contents: "read", metadata: "read" },
  });
}

/** Mints a write token constrained to odie-os for server-owned feedback pull requests. */
export function mintGitHubProductFeedbackToken(env: GitHubAppEnv): Promise<GitHubInstallationToken> {
  return mintGitHubInstallationToken(env, {
    repositories: ["odie-os"],
    permissions: { contents: "read", metadata: "read", pull_requests: "write", issues: "write" },
  });
}

/** Returns whether all credentials required to mint a GitHub App token are configured. */
export function hasGitHubAppConfiguration(env: GitHubAppEnv): boolean {
  return Boolean(
    env.GITHUB_APP_ID?.trim() &&
    env.GITHUB_APP_INSTALLATION_ID?.trim() &&
    (env.GITHUB_APP_PRIVATE_KEY?.trim() || env.GITHUB_APP_PRIVATE_KEY_B64?.trim()),
  );
}

/** Mints an installation token constrained to the requested repositories and permissions. */
export async function mintGitHubInstallationToken(
  env: GitHubAppEnv,
  options: {
    repositories?: string[];
    permissions: Record<string, "read" | "write">;
  },
): Promise<GitHubInstallationToken> {
  const appId = required(env.GITHUB_APP_ID, "GITHUB_APP_ID");
  const installationId = required(env.GITHUB_APP_INSTALLATION_ID, "GITHUB_APP_INSTALLATION_ID");
  const jwt = await githubAppJwt(appId, githubPrivateKey(env));
  const body = {
    ...(options.repositories ? { repositories: options.repositories } : {}),
    permissions: options.permissions,
  };
  const response = await fetch(
    `${GITHUB_API_ORIGIN}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(`Bearer ${jwt}`, "odie-os-github-app"),
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error(`GitHub installation token failed (${response.status}).`);
  const result = await response.json() as { token?: string; expires_at?: string };
  if (!result.token || !result.expires_at) {
    throw new Error("GitHub returned an invalid installation token.");
  }
  return { token: result.token, expiresAt: new Date(result.expires_at).valueOf() };
}

/** Standard headers for GitHub REST requests. */
export function githubHeaders(authorization: string, userAgent: string): Headers {
  return new Headers({
    accept: "application/vnd.github+json",
    authorization,
    "content-type": "application/json",
    "user-agent": userAgent,
    "x-github-api-version": "2022-11-28",
  });
}

function githubPrivateKey(env: GitHubAppEnv): string {
  if (env.GITHUB_APP_PRIVATE_KEY?.trim()) return env.GITHUB_APP_PRIVATE_KEY;
  const encoded = required(env.GITHUB_APP_PRIVATE_KEY_B64, "GITHUB_APP_PRIVATE_KEY_B64");
  try {
    return new TextDecoder().decode(base64ToBytes(encoded));
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY_B64 is not valid base64.");
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is not configured.`);
  return value.trim();
}

async function githubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: appId });
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemBytes(value: string): ArrayBuffer {
  const pkcs1 = value.includes("-----BEGIN RSA PRIVATE KEY-----");
  const base64 = value.replace(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, "");
  const bytes = base64ToBytes(base64);
  const result = pkcs1 ? wrapPkcs1AsPkcs8(bytes) : bytes;
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  return derSequence(version, rsaAlgorithm, derValue(0x04, pkcs1));
}

function derSequence(...values: Uint8Array[]): Uint8Array {
  return derValue(0x30, concatBytes(...values));
}

function derValue(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
