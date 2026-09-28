import {
  COMMUNITY_REQUEST_ATTACHMENT_TYPES,
  COMMUNITY_REQUEST_LIMITS as LIMITS,
} from "@gadgets/workshop-shared/community-requests";
import type { AddCommunityRequestAttachment } from "@gadgets/workshop-shared/community-requests";

/** Private R2 namespace; object names never contain user-provided filenames. */
export const COMMUNITY_ATTACHMENT_R2_PREFIX = ".community-request-attachments/v1/";

const MIME_EXTENSIONS = new Map<string, readonly string[]>(Object.entries(COMMUNITY_REQUEST_ATTACHMENT_TYPES));

const PREFIXES = new Map<string, readonly (number | null)[]>([
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/webp", [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ["video/webm", [0x1a, 0x45, 0xdf, 0xa3]],
]);

/** Canonical attachment metadata and bytes accepted by the public board. */
export type ValidatedCommunityAttachment = {
  name: string;
  mimeType: string;
  content: Uint8Array;
  byteLength: number;
  sha256: string;
  extension: string;
};

function normalizedMimeType(value: string): string {
  if (typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Invalid attachment type.");
  const mimeType = value.split(";", 1)[0].trim().toLowerCase();
  if (!MIME_EXTENSIONS.has(mimeType)) throw new Error("Unsupported attachment type.");
  return mimeType;
}

function sanitizedName(value: string, mimeType: string): { name: string; extension: string } {
  if (typeof value !== "string") throw new Error("Invalid attachment name.");
  const name = value.replace(/[\p{Cc}\p{Cf}/\\]/gu, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > LIMITS.attachmentName) throw new Error("Invalid attachment name.");
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const allowed = MIME_EXTENSIONS.get(mimeType)!;
  if (!allowed.includes(extension)) throw new Error("Attachment name does not match its type.");
  return { name, extension: allowed[0] };
}

function assertPrefix(content: Uint8Array, prefix: readonly (number | null)[]): void {
  for (const [index, expected] of prefix.entries()) {
    if (expected !== null && content[index] !== expected) throw new Error("Attachment content does not match its type.");
  }
}

function assertText(content: Uint8Array): void {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(content); }
  catch { throw new Error("Attachment text must be valid UTF-8."); }
  if (decoded.includes("\0")) throw new Error("Attachment text contains unsupported content.");
}

function assertIsoMedia(content: Uint8Array): void {
  if (content.length < 12 || String.fromCharCode(...content.subarray(4, 8)) !== "ftyp") {
    throw new Error("Attachment content does not match its type.");
  }
}

/** Validates and hashes one public attachment before any durable metadata references it. */
export async function validateCommunityAttachment(
  input: AddCommunityRequestAttachment,
): Promise<ValidatedCommunityAttachment> {
  if (!(input.content instanceof Uint8Array)) throw new Error("Invalid attachment content.");
  if (input.content.byteLength < 1) throw new Error("Attachment must not be empty.");
  if (input.content.byteLength > LIMITS.attachmentBytes) throw new Error("Attachment is too large.");
  const mimeType = normalizedMimeType(input.mimeType);
  const { name, extension } = sanitizedName(input.name, mimeType);
  const prefix = PREFIXES.get(mimeType);
  if (prefix) assertPrefix(input.content, prefix);
  if (mimeType.startsWith("text/") || mimeType === "application/json") assertText(input.content);
  if (mimeType === "video/mp4" || mimeType === "video/quicktime") assertIsoMedia(input.content);
  const digest = await crypto.subtle.digest("SHA-256", input.content);
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { name, mimeType, content: input.content, byteLength: input.content.byteLength, sha256, extension };
}

/** Returns a backend-owned relative sandbox filename for one validated MIME type. */
export function communityAttachmentSandboxName(index: number, id: string, mimeType: string): string {
  const extension = MIME_EXTENSIONS.get(mimeType)?.[0];
  if (!Number.isSafeInteger(index) || index < 1 || !extension) throw new Error("Invalid attachment manifest.");
  return `${String(index).padStart(2, "0")}-${id}.${extension}`;
}
