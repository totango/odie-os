import { useEffect, useRef, useState } from "react";
import type { RpcStub } from "capnweb";
import type { ChatAttachmentHandle, Overseer } from "@gadgets/workshop-shared/api";
import { reportIssue } from "../../../../errorReporting";
import { formatAttachmentSize } from "../../attachmentFormatting";
import {
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  prepareChatAttachment,
} from "./prepareChatAttachment";

export const MAX_COMPOSER_ATTACHMENTS = 5;

export type ComposerAttachment = {
  id: string;
  blob: Blob;
  name?: string;
  previewUrl?: string;
  mimeType: string;
  uploadState: "uploading" | "ready" | "error";
  ref?: ChatAttachmentHandle;
  error?: string;
};

type ComposerAttachmentsOptions = {
  authority?: object;
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
  modelId: string | null;
  onError: (message: string) => void;
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export const useComposerAttachments = ({
  authority,
  getOverseer,
  modelId,
  onError,
}: ComposerAttachmentsOptions) => {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const stagedCleanupRef = useRef(new Map<string, (sent?: boolean) => void>());
  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const getOverseerRef = useRef(getOverseer);
  const onErrorRef = useRef(onError);
  getOverseerRef.current = getOverseer;
  onErrorRef.current = onError;

  const updateAttachments = (
    update: (current: ComposerAttachment[]) => ComposerAttachment[],
  ) => {
    const next = update(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  };

  useEffect(() => {
    mountedRef.current = true;
    setAttachments(attachmentsRef.current);
    return () => {
      mountedRef.current = false;
      epochRef.current++;
      const abandoned = attachmentsRef.current;
      attachmentsRef.current = [];
      for (const attachment of abandoned) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        stagedCleanupRef.current.get(attachment.id)?.();
      }
      stagedCleanupRef.current.clear();
    };
  }, [authority]);

  const uploadAttachment = async (
    id: string,
    blob: Blob,
    mimeType: string,
    name: string | undefined,
    uploadModelId: string | null,
  ) => {
    let owner: RpcStub<Overseer> | undefined;
    try {
      const content = new Uint8Array(await blob.arrayBuffer());
      if (!mountedRef.current || !attachmentsRef.current.some((item) => item.id === id)) return;
      const overseer = (await getOverseerRef.current()).dup();
      owner = overseer;
      if (!mountedRef.current || !attachmentsRef.current.some((item) => item.id === id)) return;
      const ref = await overseer.uploadChatAttachment({ mimeType, content, name }, uploadModelId);
      const deleteUpload = (sent = false) => {
        if (sent) overseer[Symbol.dispose]();
        else void overseer.deleteChatAttachment(ref.id).catch(() => {
          // Cleanup remains best-effort when the transport itself is gone.
        }).finally(() => overseer[Symbol.dispose]());
      };
      owner = undefined; // The staged cleanup now owns this duplicate.
      if (!mountedRef.current || !attachmentsRef.current.some((item) => item.id === id)) {
        deleteUpload();
        return;
      }
      stagedCleanupRef.current.set(id, deleteUpload);
      updateAttachments((current) => current.map((item) =>
        item.id === id ? { ...item, uploadState: "ready", ref } : item));
    } catch (error) {
      if (!mountedRef.current || !attachmentsRef.current.some((item) => item.id === id)) return;
      console.error("Failed to upload chat attachment:", error);
      reportIssue("chat.attachment-upload", error);
      const message = errorMessage(error, "Upload failed");
      updateAttachments((current) => current.map((item) =>
        item.id === id ? { ...item, uploadState: "error", error: message } : item));
      onErrorRef.current(errorMessage(error, "Failed to upload attachment"));
    } finally {
      owner?.[Symbol.dispose]();
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const epoch = epochRef.current;
    const candidates = Array.from(files);
    const initialRoom = MAX_COMPOSER_ATTACHMENTS - attachmentsRef.current.length;
    if (initialRoom <= 0) {
      onErrorRef.current(`You can attach up to ${MAX_COMPOSER_ATTACHMENTS} attachments`);
      return;
    }
    const accepted = candidates.slice(0, initialRoom);
    if (candidates.length > initialRoom) {
      onErrorRef.current(initialRoom === 1
        ? "Only the first attachment was attached"
        : `Only the first ${initialRoom} attachments were attached`);
    }

    const prepared = await Promise.allSettled(accepted.map(async (file) => ({
      file,
      ...(await prepareChatAttachment(file)),
    })));
    if (!mountedRef.current || epoch !== epochRef.current) return;

    for (const result of prepared) {
      if (result.status === "rejected") {
        console.error("Failed to process chat attachment:", result.reason);
        onErrorRef.current(errorMessage(result.reason, "Failed to process attachment"));
        continue;
      }

      const { file, blob, mimeType } = result.value;
      if (attachmentsRef.current.length >= MAX_COMPOSER_ATTACHMENTS) {
        onErrorRef.current(`You can attach up to ${MAX_COMPOSER_ATTACHMENTS} attachments`);
        continue;
      }
      const totalBytes = attachmentsRef.current.reduce(
        (sum, attachment) => sum + attachment.blob.size,
        0,
      );
      if (totalBytes + blob.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
        onErrorRef.current(
          `Attached files must total ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_TOTAL_BYTES)} or less`,
        );
        continue;
      }

      const id = crypto.randomUUID();
      const previewUrl = mimeType.startsWith("image/") ? URL.createObjectURL(blob) : undefined;
      const attachment: ComposerAttachment = {
        id,
        blob,
        mimeType,
        name: file.name || undefined,
        previewUrl,
        uploadState: "uploading",
      };
      updateAttachments((current) => [...current, attachment]);
      void uploadAttachment(id, blob, mimeType, file.name || undefined, modelId);
    }
  };

  const removeAttachment = (id: string) => {
    const attachment = attachmentsRef.current.find((item) => item.id === id);
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    stagedCleanupRef.current.get(id)?.();
    stagedCleanupRef.current.delete(id);
    updateAttachments((current) => current.filter((item) => item.id !== id));
  };

  const clearSentAttachments = (sent: readonly ComposerAttachment[]) => {
    const sentIds = new Set(sent.map((attachment) => attachment.id));
    for (const attachment of sent) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      stagedCleanupRef.current.get(attachment.id)?.(true);
      stagedCleanupRef.current.delete(attachment.id);
    }
    updateAttachments((current) => current.filter((attachment) => !sentIds.has(attachment.id)));
  };

  return {
    attachments,
    addFiles,
    clearSentAttachments,
    removeAttachment,
  };
};
