import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CheckSquare,
  Code,
  Eye,
  LinkSimple,
  ListBullets,
  ListNumbers,
  MarkdownLogo,
  Paperclip,
  Quotes,
  TextB,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextItalic,
  TextStrikethrough,
} from "@phosphor-icons/react";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type WorkItemEditorAttachment = {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
};

type EditorMode = "rich" | "markdown" | "preview";
type ToolbarControl = {
  label: string;
  tooltip: string;
  icon: ReactNode;
  active?: string;
  attrs?: Record<string, unknown>;
  run: () => void;
};

export type WorkItemEditorUpload = {
  enabled: boolean;
  acceptedContentTypes: string[];
  maxBytes: number;
  busy: boolean;
  mode: "immediate-issue" | "staged-comment";
  onFiles: (files: File[]) => Promise<void>;
};

export type WorkItemEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  ariaLabel: string;
  placeholder: string;
  maxLength: number;
  preview: (markdown: string) => ReactNode;
  autoFocus?: boolean;
  dirty?: boolean;
  attachments?: WorkItemEditorAttachment[];
  upload?: WorkItemEditorUpload;
};

const MODES: EditorMode[] = ["rich", "markdown", "preview"];
const UPLOADS_UNAVAILABLE = "Uploads unavailable: selected provider exposes attachment reads only.";
const INLINE_MEDIA_NOTE = "Images are omitted unless attached through Work Items. Provider-native inline media insertion is not exposed yet.";

/** Markdown-first rich text editor tailored to provider-backed work item fields. */
export function WorkItemEditor({
  value,
  onChange,
  ariaLabel,
  placeholder,
  maxLength,
  preview,
  autoFocus = false,
  dirty = false,
  attachments = [],
  upload,
}: WorkItemEditorProps) {
  const [mode, setMode] = useState<EditorMode>("rich");
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkText, setLinkText] = useState("");
  const [status, setStatus] = useState<string>();
  const [, refreshToolbar] = useState(0);
  const ids = {
    root: useId(),
    hint: useId(),
    status: useId(),
  };
  const markdownRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { autolink: true, defaultProtocol: "https", openOnClick: false },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content: value,
    contentType: "markdown",
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        "aria-describedby": `${ids.hint} ${ids.status}`,
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        class: "work-item-editor-content",
        role: "textbox",
      },
    },
    onUpdate: ({ editor: updated }) => onChange(updated.getMarkdown()),
    onSelectionUpdate: () => refreshToolbar((version) => version + 1),
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed || mode !== "rich") return;
    if (editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: "markdown" });
  }, [editor, mode, value]);

  function switchMode(next: EditorMode) {
    if (next === mode) return;
    if (next === "rich" && editor && editor.getMarkdown() !== value) {
      editor.commands.setContent(value, { contentType: "markdown" });
    }
    setLinkEditorOpen(false);
    setAttachmentPickerOpen(false);
    setMode(next);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: EditorMode) {
    const index = MODES.indexOf(current);
    const nextIndex = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? MODES.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = MODES[(nextIndex + MODES.length) % MODES.length];
    switchMode(next);
    document.getElementById(tabId(ids.root, next))?.focus();
  }

  function openLinkEditor() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    setLinkText(editor.state.doc.textBetween(from, to, " "));
    setLinkValue(editor.getAttributes("link").href ?? "");
    setAttachmentPickerOpen(false);
    setLinkEditorOpen((open) => !open);
  }

  function applyLink() {
    if (!editor) return;
    const href = safeEditorLink(linkValue);
    if (!href) return;
    const text = linkText.trim();
    if (editor.state.selection.empty && text) editor.chain().focus().insertContent(`[${text}](${href})`).run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setLinkEditorOpen(false);
    setLinkValue("");
    setLinkText("");
  }

  function insertAttachmentReference(attachment: WorkItemEditorAttachment) {
    const reference = attachmentMarkdownReference(attachment);
    if (mode === "markdown") {
      const textarea = markdownRef.current;
      const start = textarea?.selectionStart ?? value.length;
      const end = textarea?.selectionEnd ?? value.length;
      const prefix = start > 0 && !value.slice(0, start).endsWith("\n") ? "\n" : "";
      const suffix = end < value.length && !value.slice(end).startsWith("\n") ? "\n" : "";
      onChange(`${value.slice(0, start)}${prefix}${reference}${suffix}${value.slice(end)}`);
    } else {
      editor?.chain().focus().insertContent(`${reference}\n`).run();
    }
    setAttachmentPickerOpen(false);
    setStatus(`Inserted ${attachment.name} as a Work Items attachment reference. Provider-native inline media is unavailable.`);
  }

  async function uploadFiles(files: File[]) {
    if (!upload?.enabled) {
      setStatus(UPLOADS_UNAVAILABLE);
      return;
    }
    const invalid = files.find((file) => !upload.acceptedContentTypes.includes(file.type) || file.size <= 0 || file.size > upload.maxBytes);
    if (invalid) {
      setStatus(`${invalid.name} is not an accepted file or exceeds ${formatFileSize(upload.maxBytes)}.`);
      return;
    }
    setStatus(upload.mode === "staged-comment" ? "Staging attachment for this comment…" : "Uploading attachment to this issue…");
    try {
      await upload.onFiles(files);
      setStatus(upload.mode === "staged-comment" ? "Attachment staged. It will be attached when the comment posts." : "Attachment uploaded to this issue.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Attachment upload failed.");
    }
  }

  function blockUnsafeInput(event: { clipboardData?: DataTransfer | null; dataTransfer?: DataTransfer | null; preventDefault: () => void }) {
    const transfer = event.clipboardData ?? event.dataTransfer;
    if (transfer?.files.length) {
      event.preventDefault();
      void uploadFiles([...transfer.files]);
      return;
    }
    const textLength = transfer?.getData("text/plain").length ?? 0;
    const htmlLength = transfer?.getData("text/html").length ?? 0;
    if (value.length + Math.max(textLength, htmlLength) <= maxLength) return;
    event.preventDefault();
    setStatus(`Paste blocked: this editor accepts at most ${maxLength.toLocaleString()} characters.`);
  }

  const overLimit = value.length > maxLength;
  const tabLabels: Record<EditorMode, string> = { rich: "Write", markdown: "Markdown", preview: "Preview" };
  return (
    <div className={`work-item-editor ${overLimit ? "invalid" : ""}`} onPasteCapture={blockUnsafeInput} onDropCapture={blockUnsafeInput}>
      <p id={ids.hint} className="sr-only">Markdown editor. Attachments are uploaded through the selected work item's Work Items capability; provider-native inline media is not available.</p>
      <input ref={fileInputRef} className="sr-only" type="file" aria-label="Upload work item attachments" multiple disabled={!upload?.enabled || upload.busy} accept={upload?.acceptedContentTypes.join(",")} onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (files.length) void uploadFiles(files);
      }} />
      <div className="work-item-editor-tabs" role="tablist" aria-label={`${ariaLabel} editor mode`}>
        {MODES.map((candidate) => <button
          key={candidate}
          id={tabId(ids.root, candidate)}
          type="button"
          role="tab"
          aria-controls={panelId(ids.root, candidate)}
          aria-selected={mode === candidate}
          tabIndex={mode === candidate ? 0 : -1}
          onKeyDown={(event) => onTabKeyDown(event, candidate)}
          onClick={() => switchMode(candidate)}
        >
          {candidate === "markdown" && <MarkdownLogo size={14} />}
          {candidate === "preview" && <Eye size={14} />}
          {tabLabels[candidate]}{dirty && <span className="dirty-dot" aria-label="Unsaved edits" />}
        </button>)}
      </div>
      {mode === "rich" && <div id={panelId(ids.root, "rich")} role="tabpanel" aria-labelledby={tabId(ids.root, "rich")}>
        <EditorToolbar editor={editor} attachments={attachments} upload={upload} onEditLink={openLinkEditor} onAttachmentPicker={() => { setLinkEditorOpen(false); setAttachmentPickerOpen((open) => !open); }} onUploadRequest={() => {
          if (upload?.enabled) fileInputRef.current?.click();
          else setStatus(UPLOADS_UNAVAILABLE);
        }} />
        {linkEditorOpen && <div className="work-item-link-editor" role="dialog" aria-label="Edit Markdown link">
          <label><span>Text</span><input aria-label="Link text" value={linkText} onChange={(event) => setLinkText(event.currentTarget.value)} placeholder="Selected text" /></label>
          <label><span>URL or email</span><input aria-label="Link URL" value={linkValue} onChange={(event) => setLinkValue(event.currentTarget.value)} placeholder="https://…" onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); applyLink(); }
            if (event.key === "Escape") setLinkEditorOpen(false);
          }} /></label>
          <button type="button" disabled={!safeEditorLink(linkValue)} onClick={applyLink}>Apply link</button>
          <button type="button" onClick={() => { editor?.chain().focus().unsetLink().run(); setLinkEditorOpen(false); }}>Remove link</button>
          <button type="button" onClick={() => setLinkEditorOpen(false)}>Cancel</button>
        </div>}
        {attachmentPickerOpen && <AttachmentReferencePicker attachments={attachments} onInsert={insertAttachmentReference} />}
        <EditorContent editor={editor} />
      </div>}
      {mode === "markdown" && <div id={panelId(ids.root, "markdown")} role="tabpanel" aria-labelledby={tabId(ids.root, "markdown")}>
        {attachments.length > 0 && <AttachmentReferencePicker attachments={attachments} onInsert={insertAttachmentReference} />}
        <textarea ref={markdownRef} className="work-item-markdown-source" aria-label={ariaLabel} aria-describedby={`${ids.hint} ${ids.status}`} value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={placeholder} autoFocus />
      </div>}
      {mode === "preview" && <div id={panelId(ids.root, "preview")} role="tabpanel" aria-labelledby={tabId(ids.root, "preview")} className="work-item-editor-preview"><p className="preview-note">{INLINE_MEDIA_NOTE}</p>{value.trim() ? preview(value) : <p className="hint">Nothing to preview yet.</p>}</div>}
      <div className="work-item-editor-footer">
        <span>{status ?? (upload?.enabled ? upload.mode === "staged-comment" ? "Markdown · uploads attach when the comment posts" : "Markdown · uploads attach to this issue immediately" : "Markdown · attachment reads only")}</span>
        <span id={ids.status} className={overLimit ? "limit-error" : ""} aria-live="polite">{value.length.toLocaleString()} / {maxLength.toLocaleString()}</span>
      </div>
    </div>
  );
}

function EditorToolbar({ editor, attachments, upload, onEditLink, onAttachmentPicker, onUploadRequest }: { editor: Editor | null; attachments: WorkItemEditorAttachment[]; upload?: WorkItemEditorUpload; onEditLink: () => void; onAttachmentPicker: () => void; onUploadRequest: () => void }) {
  const groups: Array<{ label: string; controls: ToolbarControl[] }> = [
    { label: "Format", controls: [
      { label: "Bold", tooltip: "Bold · ⌘B", icon: <TextB />, active: "bold", run: () => editor?.chain().focus().toggleBold().run() },
      { label: "Italic", tooltip: "Italic · ⌘I", icon: <TextItalic />, active: "italic", run: () => editor?.chain().focus().toggleItalic().run() },
      { label: "Strikethrough", tooltip: "Strikethrough", icon: <TextStrikethrough />, active: "strike", run: () => editor?.chain().focus().toggleStrike().run() },
      { label: "Inline code", tooltip: "Inline code", icon: <Code />, active: "code", run: () => editor?.chain().focus().toggleCode().run() },
    ] },
    { label: "Structure", controls: [
      { label: "Heading 1", tooltip: "Heading 1", icon: <TextHOne />, active: "heading", attrs: { level: 1 }, run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run() },
      { label: "Heading 2", tooltip: "Heading 2", icon: <TextHTwo />, active: "heading", attrs: { level: 2 }, run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
      { label: "Heading 3", tooltip: "Heading 3", icon: <TextHThree />, active: "heading", attrs: { level: 3 }, run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
      { label: "Quote", tooltip: "Quote", icon: <Quotes />, active: "blockquote", run: () => editor?.chain().focus().toggleBlockquote().run() },
    ] },
    { label: "Lists", controls: [
      { label: "Bulleted list", tooltip: "Bulleted list", icon: <ListBullets />, active: "bulletList", run: () => editor?.chain().focus().toggleBulletList().run() },
      { label: "Numbered list", tooltip: "Numbered list", icon: <ListNumbers />, active: "orderedList", run: () => editor?.chain().focus().toggleOrderedList().run() },
      { label: "Task list", tooltip: "Task list", icon: <CheckSquare />, active: "taskList", run: () => editor?.chain().focus().toggleTaskList().run() },
    ] },
  ];
  return <div className="work-item-editor-toolbar" role="toolbar" aria-label="Formatting toolbar">
    {groups.map((group) => <div key={group.label} className="toolbar-group" role="group" aria-label={group.label}>
      <span className="toolbar-group-label" aria-hidden="true">{group.label}</span>
      {group.controls.map((control) => <button key={control.label} type="button" title={control.tooltip} aria-label={control.label} aria-pressed={control.active ? editor?.isActive(control.active, control.attrs) ?? false : undefined} disabled={!editor} onClick={control.run}>{control.icon}</button>)}
    </div>)}
    <div className="toolbar-group" role="group" aria-label="Insert">
      <span className="toolbar-group-label" aria-hidden="true">Insert</span>
      <button type="button" title="Link · ⌘K" aria-label="Edit link" aria-pressed={editor?.isActive("link") ?? false} disabled={!editor} onClick={onEditLink}><LinkSimple /></button>
      <button type="button" title={upload?.enabled ? upload.mode === "staged-comment" ? "Upload and attach when this comment posts" : "Upload to this issue" : UPLOADS_UNAVAILABLE} aria-label="Upload attachment" disabled={upload?.busy} aria-disabled={!upload?.enabled || upload.busy} onClick={onUploadRequest}><Paperclip /></button>
      <button type="button" title={attachments.length ? "Insert existing attachment reference" : "No existing attachments returned by provider"} aria-label="Existing attachment references" disabled={!editor || attachments.length === 0} onClick={onAttachmentPicker}><Paperclip weight="fill" /></button>
    </div>
    <div className="toolbar-group history" role="group" aria-label="History">
      <span className="toolbar-group-label" aria-hidden="true">History</span>
      <button type="button" title="Undo · ⌘Z" aria-label="Undo" disabled={!editor?.can().chain().focus().undo().run()} onClick={() => editor?.chain().focus().undo().run()}><ArrowCounterClockwise /></button>
      <button type="button" title="Redo · ⇧⌘Z" aria-label="Redo" disabled={!editor?.can().chain().focus().redo().run()} onClick={() => editor?.chain().focus().redo().run()}><ArrowClockwise /></button>
    </div>
  </div>;
}

function AttachmentReferencePicker({ attachments, onInsert }: { attachments: WorkItemEditorAttachment[]; onInsert: (attachment: WorkItemEditorAttachment) => void }) {
  return <div className="attachment-reference-picker" role="region" aria-label="Existing attachments">
    <div><strong>Existing attachments</strong><span>Read-only provider assets; insertion creates a Work Items reference, not an upload.</span></div>
    {attachments.map((attachment) => <button key={attachment.id} type="button" onClick={() => onInsert(attachment)}>Insert {attachment.name}</button>)}
  </div>;
}

export function attachmentMarkdownReference(attachment: WorkItemEditorAttachment): string {
  return `[Attachment: ${attachment.name.replace(/[[\]]/g, "") || "file"}](work-items-attachment://${encodeURIComponent(attachment.id)})`;
}

function tabId(root: string, mode: EditorMode) { return `${root}-${mode}-tab`; }
function panelId(root: string, mode: EditorMode) { return `${root}-${mode}-panel`; }

function formatFileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function safeEditorLink(raw: string): string | undefined {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const normalized = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
