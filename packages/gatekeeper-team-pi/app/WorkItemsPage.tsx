import {
  ArrowClockwise,
  ArrowLeft,
  ChatCircleText,
  CheckCircle,
  GitBranch,
  LinkSimple,
  MagnifyingGlass,
  PencilSimple,
  Ticket,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type {
  WorkItemDetail,
  WorkItemFieldPatch,
  WorkItemManagementApi,
  WorkItemProviderKind,
  WorkItemProviderRef,
  WorkItemRead,
  WorkItemSearchPage,
  WorkItemSearchSource,
  WorkItemSourceStatuses,
  WorkItemSummary,
  WorkItemsManagementApi,
} from "../src/types";
import { useWorkItemsApi, useWorkItemsRouteState, type WorkItemsRouteStateHost } from "./bridge";

type DisposableItemApi = WorkItemManagementApi & { [Symbol.dispose]?: () => void };
type Selected = { stub: DisposableItemApi; ref: WorkItemProviderRef };
type MutationContext = { stub: DisposableItemApi; ref: WorkItemProviderRef; epoch: number };
type Filters = { status: string; priority: string; type: string; person: string };
type Tab = "comments" | "activity";
type StatusLoadResult = { ok: true; statuses: WorkItemSourceStatuses } | { ok: false };

const EMPTY_FILTERS: Filters = { status: "", priority: "", type: "", person: "" };
const STORE_KEY = "team-pi-work-items:v1";
const LIMIT = 40;
const DETAIL_WIDTH = { min: 360, default: 520, max: 760, margin: 32 };
const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, node: _node, ...props }) {
    const safeHref = safeLinkHref(href);
    if (!safeHref) return <>{children}</>;
    return <a {...props} href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  img({ alt }) {
    return alt ? <span>{alt}</span> : null;
  },
};
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => tag !== "img"),
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    img: [],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
  },
};

export default function WorkItemsPage({
  api: apiProp,
  routeStateHost: routeStateHostProp,
}: {
  api?: WorkItemsManagementApi;
  routeStateHost?: WorkItemsRouteStateHost;
}) {
  const contextApi = useWorkItemsApi();
  const contextRouteStateHost = useWorkItemsRouteState();
  const api = apiProp ?? contextApi;
  const routeStateHost = routeStateHostProp ?? contextRouteStateHost;
  if (!api) throw new Error("WorkItemsPage requires a Work Items API capability.");
  const initial = useMemo(() => readInitialState(routeStateHost?.initialRouteState), [routeStateHost?.initialRouteState]);
  const [statuses, setStatuses] = useState<WorkItemSourceStatuses>();
  const [source, setSource] = useState<WorkItemSearchSource>(initial.source);
  const [query, setQuery] = useState(initial.query);
  const [debouncedQuery, setDebouncedQuery] = useState(initial.query);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [page, setPage] = useState<WorkItemSearchPage>({ items: [], cursors: {}, hasMore: {} });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [selectedRead, setSelectedRead] = useState<WorkItemRead | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [tab, setTab] = useState<Tab>("comments");
  const [notice, setNotice] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastSelectedRowKey = useRef<string | null>(null);
  const searchEpoch = useRef(0);
  const selectEpoch = useRef(0);
  const statusEpoch = useRef(0);
  const pageRef = useRef(page);
  const selectedRef = useRef<Selected | null>(null);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const loadStatuses = useCallback(async (): Promise<StatusLoadResult> => {
    const epoch = ++statusEpoch.current;
    try {
      const next = await api.getSourceStatuses();
      if (epoch !== statusEpoch.current) return { ok: false };
      setStatuses(next);
      setError(undefined);
      return { ok: true, statuses: next };
    } catch (caught) {
      if (epoch === statusEpoch.current) {
        setError(safeMessage(caught));
        setLoading(false);
      }
      return { ok: false };
    }
  }, [api]);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const search = useCallback(
    async (opts?: { cursor?: Partial<Record<WorkItemProviderKind, string>>; append?: boolean; statuses?: WorkItemSourceStatuses }) => {
      const statusSnapshot = opts?.statuses ?? statuses;
      if (!statusSnapshot) return;
      const effectiveSource = opts?.append ? getAppendSource(source, statusSnapshot, pageRef.current.hasMore) : getEffectiveSource(source, statusSnapshot);
      const epoch = ++searchEpoch.current;
      if (opts?.append) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      if (!effectiveSource) {
        setPage({ items: [], cursors: {}, hasMore: {} });
        setActiveIndex(0);
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      try {
        const result = await api.search({
          source: effectiveSource,
          query: debouncedQuery || undefined,
          limit: LIMIT,
          cursors: opts?.cursor,
        });
        if (epoch !== searchEpoch.current) return;
        setPage((current) => ({
          ...current,
          ...result,
          cursors: opts?.append ? { ...current.cursors, ...result.cursors } : result.cursors,
          hasMore: opts?.append ? { ...current.hasMore, ...result.hasMore } : result.hasMore,
          errors: opts?.append ? mergeProviderErrors(current.errors, result.errors) : result.errors,
          items: opts?.append ? [...current.items, ...result.items] : result.items,
        }));
        if (!opts?.append) setActiveIndex(0);
      } catch (caught) {
        if (epoch === searchEpoch.current) setError(safeMessage(caught));
      } finally {
        if (epoch === searchEpoch.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, debouncedQuery, source, statuses],
  );

  useEffect(() => {
    void search();
  }, [search]);

  const filteredItems = useMemo(() => applyFilters(page.items, filters), [page.items, filters]);
  const filterOptions = useMemo(() => collectFilterOptions(page.items), [page.items]);

  const persist = useCallback(
    (nextSelected = selected?.ref) => {
      const state = { query, source, filters, selected: nextSelected ?? null };
      safeSetStoredState(state);
      if (routeStateHost?.setRouteState) routeStateHost.setRouteState(encodeStoredState(state));
      else safeReplaceHash(state);
    },
    [filters, query, routeStateHost, selected?.ref, source],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => persist(), 220);
    return () => window.clearTimeout(timer);
  }, [persist]);

  const disposeSelected = useCallback((item: Selected | null) => {
    try {
      item?.stub[Symbol.dispose]?.();
    } catch {
      // Best-effort cleanup; never break UI teardown.
    }
  }, []);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => () => disposeSelected(selectedRef.current), [disposeSelected]);

  const isCurrentSelection = useCallback((ctx: MutationContext) => {
    const current = selectedRef.current;
    return !!current && current.stub === ctx.stub && sameRef(current.ref, ctx.ref) && ctx.epoch === selectEpoch.current;
  }, []);

  const readSelected = useCallback(async (stub: DisposableItemApi, epoch: number, ref?: WorkItemProviderRef) => {
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const read = await stub.read();
      if (epoch !== selectEpoch.current) return;
      if (ref && (!selectedRef.current || selectedRef.current.stub !== stub || !sameRef(selectedRef.current.ref, ref))) return;
      setSelectedRead(read);
      setTab("comments");
    } catch (caught) {
      if (epoch === selectEpoch.current) setDetailError(safeMessage(caught));
    } finally {
      if (epoch === selectEpoch.current) setDetailLoading(false);
    }
  }, []);

  const selectItem = useCallback(
    async (ref: WorkItemProviderRef) => {
      const epoch = ++selectEpoch.current;
      setDetailLoading(true);
      setDetailError(undefined);
      setSelectedRead(null);
      setNotice(undefined);
      try {
        const stub = (await api.item(ref)) as DisposableItemApi;
        if (epoch !== selectEpoch.current) {
          stub[Symbol.dispose]?.();
          return;
        }
        const nextSelection = { stub, ref };
        selectedRef.current = nextSelection;
        setSelected((current) => {
          disposeSelected(current);
          return nextSelection;
        });
        persist(ref);
        await readSelected(stub, epoch, ref);
      } catch (caught) {
        if (epoch === selectEpoch.current) {
          setDetailLoading(false);
          setDetailError(safeMessage(caught));
        }
      }
    },
    [api, disposeSelected, persist, readSelected],
  );

  useEffect(() => {
    if (!initial.selected) return;
    void selectItem(initial.selected);
    // Initial selected ref should be consumed once; selectItem is intentionally omitted to avoid
    // reselecting when query/filter state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeDetail = useCallback(() => {
    ++selectEpoch.current;
    selectedRef.current = null;
    setSelected((current) => {
      disposeSelected(current);
      return null;
    });
    setSelectedRead(null);
    setDetailError(undefined);
    setDetailLoading(false);
    setNotice(undefined);
    window.setTimeout(() => {
      const key = lastSelectedRowKey.current;
      (key ? rowRefs.current.get(key) : null)?.focus({ preventScroll: true });
      if (!document.activeElement || document.activeElement === document.body) listRef.current?.focus({ preventScroll: true });
    }, 0);
  }, [disposeSelected]);

  const refreshAll = useCallback(async () => {
    const nextStatuses = await loadStatuses();
    if (!nextStatuses.ok) return;
    await search({ statuses: nextStatuses.statuses });
    if (selected?.stub) await readSelected(selected.stub, selectEpoch.current, selected.ref);
  }, [loadStatuses, readSelected, search, selected]);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((value) => {
        const next = Math.min(filteredItems.length - 1, value + 1);
        scrollRowIntoView(filteredItems[next], rowRefs.current);
        return next;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((value) => {
        const next = Math.max(0, value - 1);
        scrollRowIntoView(filteredItems[next], rowRefs.current);
        return next;
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filteredItems[activeIndex];
      if (item) void selectItem(item);
    } else if (event.key === "Escape") {
      closeDetail();
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!selected && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === "Escape") {
        if (isEditableTarget(event.target)) return;
        else closeDetail();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDetail, selected]);

  const hasMore = Object.values(page.hasMore).some(Boolean);
  useEffect(() => {
    if (!selected) return;
    lastSelectedRowKey.current = rowKey(selected.ref);
    if (isMobileLayout()) window.setTimeout(() => backButtonRef.current?.focus({ preventScroll: true }), 0);
  }, [selected]);

  const handleMutated = useCallback((detail: WorkItemDetail, ctx: MutationContext) => {
    if (!isCurrentSelection(ctx)) return;
    setSelectedRead((current) => current ? { ...current, detail } : current);
    setNotice("Saved. Refreshing authoritative data…");
    void readSelected(ctx.stub, ctx.epoch, ctx.ref).then(() => {
      if (isCurrentSelection(ctx)) void search();
    });
  }, [isCurrentSelection, readSelected, search]);

  return (
    <main className="team-shell" data-has-selection={selected ? "true" : "false"}>
      <header className="topbar">
        <div className="topbar-title">
          <h1>Work Items</h1>
          <SourceStatusPills statuses={statuses} />
        </div>
        <div className="topbar-actions">
          <SourceSegment value={source} onChange={setSource} />
          <label className="search-box">
            <MagnifyingGlass size={15} />
            <span className="sr-only">Search work items</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search Jira or Zendesk…"
              onChange={(event) => setQuery(event.currentTarget.value)}
              maxLength={240}
            />
            <kbd>⌘K</kbd>
          </label>
          <button className="icon-button" type="button" aria-label="Refresh work items" onClick={() => void refreshAll()}>
            <ArrowClockwise size={16} />
          </button>
        </div>
      </header>

      <section className="filters" aria-label="Work item filters">
        <FilterSelect label="Status" value={filters.status} options={filterOptions.status} onChange={(status) => setFilters((f) => ({ ...f, status }))} />
        <FilterSelect label="Priority" value={filters.priority} options={filterOptions.priority} onChange={(priority) => setFilters((f) => ({ ...f, priority }))} />
        <FilterSelect label="Type" value={filters.type} options={filterOptions.type} onChange={(type) => setFilters((f) => ({ ...f, type }))} />
        <FilterSelect label="Assignee/requester" value={filters.person} options={filterOptions.person} onChange={(person) => setFilters((f) => ({ ...f, person }))} />
        {hasFilters(filters) && (
          <button className="clear-button" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear
          </button>
        )}
      </section>

      {statuses && (!statuses.jira.configured || !statuses.jira.connected || !statuses.zendesk.configured || !statuses.zendesk.connected) && (
        <Banner tone="neutral" title="Provider setup" message="Disconnected or unconfigured providers stay visible here so admins know what Team PI needs before searching." />
      )}
      {page.errors?.map((providerError) => (
        <Banner key={providerError.source} tone="warning" title={`${labelSource(providerError.source)} search failed`} message={providerError.message} />
      ))}
      {error && <Banner tone="danger" title="Couldn’t load work items" message={error} action={<button onClick={() => void refreshAll()}>Retry</button>} />}

      <div className="content-grid">
        <section className="list-pane" aria-label="Work item results">
          <div className="list-head" role="row">
            <span>Source</span><span>Key</span><span>Title</span><span>Status</span><span>Priority</span><span>Owner</span><span>Updated</span>
          </div>
          <div
            ref={listRef}
            className="work-list"
            role="list"
            tabIndex={0}
            aria-label="Work items. Use arrow keys to move and Enter to open."
            onKeyDown={onListKeyDown}
            aria-busy={loading}
            aria-live="polite"
          >
            {loading ? <SkeletonRows /> : filteredItems.length === 0 ? <EmptyState query={debouncedQuery} /> : filteredItems.map((item, index) => (
              <WorkItemRow
                key={`${item.source}:${item.id}`}
                item={item}
                active={index === activeIndex}
                selected={sameRef(item, selected?.ref)}
                rowRef={(node) => setRowRef(item, node, rowRefs.current)}
                onFocus={() => setActiveIndex(index)}
                onOpen={() => void selectItem(item)}
              />
            ))}
          </div>
          {hasMore && !loading && (
            <div className="load-more">
              <button type="button" disabled={loadingMore} onClick={() => void search({ cursor: page.cursors, append: true })}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </section>

      </div>
      <DetailPanel
        selected={selected}
        read={selectedRead}
        loading={detailLoading}
        error={detailError}
        tab={tab}
        setTab={setTab}
        notice={notice}
        backButtonRef={backButtonRef}
        onClose={closeDetail}
        onRetry={() => selected && void readSelected(selected.stub, selectEpoch.current, selected.ref)}
        mutationEpoch={selectEpoch.current}
        onMutated={handleMutated}
      />
    </main>
  );
}

function SourceStatusPills({ statuses }: { statuses?: WorkItemSourceStatuses }) {
  return <div className="source-pills" aria-label="Provider connection status">
    {(["jira", "zendesk"] as const).map((source) => {
      const status = statuses?.[source];
      if (!status) return <span key={source} className={`source-pill ${source} checking`} title="Checking connection">{labelSource(source)} checking</span>;
      const ok = status?.configured && status.connected;
      return <span key={source} className={`source-pill ${source} ${ok ? "ok" : "warn"}`} title={status?.reason ?? (ok ? "Connected" : "Checking connection")}>{labelSource(source)} {ok ? "connected" : "needs setup"}</span>;
    })}
  </div>;
}

function SourceSegment({ value, onChange }: { value: WorkItemSearchSource; onChange: (value: WorkItemSearchSource) => void }) {
  return <fieldset className="segment"><legend className="sr-only">Search source</legend>
    {(["both", "jira", "zendesk"] as const).map((source) => <label key={source} data-active={value === source}><input type="radio" name="work-item-source" value={source} checked={value === source} onChange={() => onChange(source)} />{source === "both" ? "Both" : labelSource(source)}</label>)}
  </fieldset>;
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="filter-select"><span>{label}</span><select value={value} onChange={(event) => onChange(event.currentTarget.value)}><option value="">Any</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function Banner({ tone, title, message, action }: { tone: "neutral" | "warning" | "danger"; title: string; message: string; action?: ReactNode }) {
  return <div className={`banner ${tone}`} role={tone === "danger" ? "alert" : "status"}><WarningCircle size={16} /><strong>{title}</strong><span>{message}</span>{action}</div>;
}

function WorkItemRow({ item, active, selected, rowRef, onFocus, onOpen }: { item: WorkItemSummary; active: boolean; selected: boolean; rowRef: (node: HTMLButtonElement | null) => void; onFocus: () => void; onOpen: () => void }) {
  return <button ref={rowRef} id={rowId(item)} data-row-key={rowKey(item)} type="button" role="listitem" aria-current={selected ? "true" : undefined} aria-selected={selected} data-active={active} className="work-row" onFocus={onFocus} onMouseEnter={onFocus} onClick={onOpen}>
    <span><SourceBadge source={item.source} /></span>
    <span className="mono">{item.key ?? item.id}</span>
    <span className="title-cell">{item.title}</span>
    <span>{item.status || "—"}</span>
    <span>{item.priority || "—"}</span>
    <span>{item.assignee || item.requester || "Unassigned"}</span>
    <time dateTime={item.updatedAt} title={fullDate(item.updatedAt)}>{relativeDate(item.updatedAt)}</time>
  </button>;
}

function DetailPanel(props: {
  selected: Selected | null;
  read: WorkItemRead | null;
  loading: boolean;
  error?: string;
  tab: Tab;
  setTab: (tab: Tab) => void;
  notice?: string;
  backButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onRetry: () => void;
  mutationEpoch: number;
  onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void;
}) {
  const { selected, read, loading, error, tab, setTab, notice, backButtonRef, onClose, onRetry, mutationEpoch, onMutated } = props;
  const [width, setWidth] = useState(DETAIL_WIDTH.default);
  const dragStart = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const clampWidth = useCallback((value: number) => clampDetailWidth(value), []);
  const resizeBy = useCallback((delta: number) => setWidth((current) => clampWidth(current + delta)), [clampWidth]);
  const startResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (isMobileLayout()) return;
    event.preventDefault();
    dragStart.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [width]);
  const moveResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setWidth(clampWidth(start.startWidth + start.startX - event.clientX));
  }, [clampWidth]);
  const stopResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current?.pointerId === event.pointerId) dragStart.current = null;
  }, []);
  const onResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeBy(24);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeBy(-24);
    }
  }, [resizeBy]);
  const onDialogKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = getFocusableElements(detailRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);
  useEffect(() => {
    if (!selected) return;
    window.setTimeout(() => backButtonRef.current?.focus({ preventScroll: true }), 0);
  }, [backButtonRef, selected]);
  useEffect(() => {
    if (!selected) return;
    const onResize = () => setWidth((current) => clampWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampWidth, selected]);
  if (!selected) return null;
  const item = read?.detail.item;
  return <div className="detail-overlay" role="presentation">
    <button className="detail-backdrop" type="button" aria-label="Close detail" onClick={onClose} />
    <aside ref={detailRef} className="detail-pane" role="dialog" aria-modal="true" aria-labelledby={item ? "work-item-detail-title" : undefined} aria-label={item ? undefined : "Selected work item detail"} style={{ "--detail-width": `${width}px` } as CSSProperties} onKeyDown={onDialogKeyDown}>
    <div
      className="detail-resize-handle"
      role="separator"
      aria-label="Resize detail panel"
      aria-orientation="vertical"
      aria-valuemin={DETAIL_WIDTH.min}
      aria-valuemax={Math.min(DETAIL_WIDTH.max, Math.max(DETAIL_WIDTH.min, window.innerWidth - DETAIL_WIDTH.margin))}
      aria-valuenow={clampWidth(width)}
      tabIndex={0}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={onResizeKeyDown}
    />
    <div className="detail-toolbar">
      <button ref={backButtonRef} data-detail-back className="back-button" type="button" onClick={onClose}><ArrowLeft size={16} /> Back</button>
      <button className="icon-button" type="button" aria-label="Close detail" onClick={onClose}><X size={16} /></button>
    </div>
    {loading && !read ? <DetailSkeleton /> : error ? <div className="detail-error" role="alert"><WarningCircle size={18} /><p>{error}</p><button onClick={onRetry}>Retry</button></div> : item && read ? <>
      <header className="detail-header">
        <div className="detail-kicker"><SourceBadge source={item.source} /><span className="mono">{item.key ?? item.id}</span>{item.url && <a href={item.url} target="_blank" rel="noreferrer">Open trusted URL</a>}</div>
        <h2 id="work-item-detail-title">{item.title}</h2>
      </header>
      <dl className="field-grid">
        <Field label="Status" value={item.status} /><Field label="Priority" value={item.priority} /><Field label="Type" value={item.type} />
        <Field label={item.source === "zendesk" ? "Requester" : "Assignee"} value={item.assignee || item.requester} />
        <Field label="Updated" value={fullDate(item.updatedAt)} />
        {Object.entries(item.fields).slice(0, 8).map(([key, value]) => <Field key={key} label={key} value={String(value ?? "—")} />)}
      </dl>
      {notice && <p className="success-note" role="status"><CheckCircle size={15} />{notice}</p>}
      <CommentComposer item={item} api={selected.stub} mutationEpoch={mutationEpoch} onMutated={onMutated} />
      <FieldEditor read={read} api={selected.stub} mutationEpoch={mutationEpoch} onMutated={onMutated} />
      {item.source === "jira" && <TransitionEditor item={item} transitions={read.transitions} api={selected.stub} mutationEpoch={mutationEpoch} onMutated={onMutated} />}
      <LinkEditor item={item} api={selected.stub} />
      <div className="tabs" role="tablist" aria-label="Detail timeline"><button role="tab" aria-selected={tab === "comments"} onClick={() => setTab("comments")}>Comments</button><button role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity</button></div>
      {tab === "comments" ? <TimelineEmptyAware emptyText="No comments returned by the provider.">{read.comments.map((comment) => <article className="timeline-entry" key={comment.id}><div><strong>{comment.author || "Unknown"}</strong><time title={fullDate(comment.createdAt)}>{relativeDate(comment.createdAt)}</time><span className={`visibility ${comment.public ? "public" : "internal"}`}>{comment.public ? "Public" : "Internal"}</span></div><RichText value={comment.body} /></article>)}</TimelineEmptyAware> : <TimelineEmptyAware emptyText="No activity returned by the provider.">{read.activity.map((entry) => <article className="timeline-entry" key={entry.id}><div><strong>{entry.author || entry.type}</strong><time title={fullDate(entry.createdAt)}>{relativeDate(entry.createdAt)}</time></div><RichText value={entry.summary} /></article>)}</TimelineEmptyAware>}
    </> : null}
  </aside>
  </div>;
}

function RichText({ value }: { value: string }) {
  return <div className="rich-text"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]} components={MARKDOWN_COMPONENTS}>{normalizeProviderText(value)}</ReactMarkdown></div>;
}

function CommentComposer({ item, api, mutationEpoch, onMutated }: { item: WorkItemSummary; api: DisposableItemApi; mutationEpoch: number; onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void }) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"internal" | "public">(item.source === "zendesk" ? "internal" : "public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setVisibility(item.source === "zendesk" ? "internal" : "public"), [item.source, item.id]);
  async function submit() {
    setBusy(true); setError(undefined);
    try {
      const detail = await api.addComment({ body, visibility });
      setBody("");
      onMutated(detail, { stub: api, ref: item, epoch: mutationEpoch });
    } catch (caught) { setError(safeMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="editor-block" aria-label="Add comment"><h3><ChatCircleText size={15} /> Comment</h3><label className="sr-only" htmlFor="work-item-comment">Comment body</label><textarea id="work-item-comment" aria-label="Comment body" value={body} onChange={(event) => setBody(event.currentTarget.value)} placeholder={item.source === "zendesk" ? "Add an internal note…" : "Add a public Jira comment…"} />{item.source === "zendesk" ? <fieldset className="radio-row"><legend className="sr-only">Zendesk comment visibility</legend><label><input type="radio" checked={visibility === "internal"} onChange={() => setVisibility("internal")} /> Internal note (default)</label><label><input type="radio" checked={visibility === "public"} onChange={() => setVisibility("public")} /> Public reply</label>{visibility === "public" && <span className="confirm-copy">This will be visible to the requester.</span>}</fieldset> : <p className="hint">Jira comments are public to users with issue access.</p>}{error && <p className="mutation-error" role="alert">{error}</p>}<button type="button" aria-label="Post work item comment" disabled={busy || !body.trim()} onClick={() => void submit()}>{busy ? "Posting…" : "Post comment"}</button></section>;
}

function FieldEditor({ read, api, mutationEpoch, onMutated }: { read: WorkItemRead; api: DisposableItemApi; mutationEpoch: number; onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void }) {
  const fields = read.updateOptions.allowedFields;
  const [field, setField] = useState(fields[0] ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setField(fields[0] ?? ""), [fields.join("\0")]);
  if (fields.length === 0) return null;
  async function submit() {
    setBusy(true); setError(undefined);
    try {
      const patch: WorkItemFieldPatch = { fields: { [field]: parseFieldValue(value) } };
      onMutated(await api.updateFields(patch), { stub: api, ref: read.detail.item, epoch: mutationEpoch });
      setValue("");
    } catch (caught) { setError(safeMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="editor-block" aria-label="Edit allowlisted field"><h3><PencilSimple size={15} /> Edit allowlisted field</h3><div className="inline-editor"><label className="sr-only" htmlFor="work-item-field-name">Field to update</label><select id="work-item-field-name" aria-label="Field to update" value={field} onChange={(event) => setField(event.currentTarget.value)}>{fields.map((name) => <option key={name} value={name}>{name}</option>)}</select><label className="sr-only" htmlFor="work-item-field-value">New field value</label><input id="work-item-field-value" aria-label="New field value" value={value} onChange={(event) => setValue(event.currentTarget.value)} placeholder="value, true/false, number, or CSV" /><button aria-label="Save work item field" disabled={busy || !field} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button></div>{read.updateOptions.providerOptions?.length ? <p className="hint">Provider options: {read.updateOptions.providerOptions.join(", ")}</p> : null}{error && <p className="mutation-error" role="alert">{error}</p>}</section>;
}

function TransitionEditor({ item, transitions, api, mutationEpoch, onMutated }: { item: WorkItemSummary; transitions: WorkItemRead["transitions"]; api: DisposableItemApi; mutationEpoch: number; onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (transitions.length === 0) return null;
  async function apply(id: string) {
    setBusy(id); setError(undefined);
    try { onMutated(await api.transition(id), { stub: api, ref: item, epoch: mutationEpoch }); } catch (caught) { setError(safeMessage(caught)); } finally { setBusy(undefined); }
  }
  return <section className="editor-block" aria-label="Apply Jira transition"><h3><GitBranch size={15} /> Jira transition</h3><div className="transition-row">{transitions.map((transition) => <button key={transition.id} aria-label={`Apply Jira transition ${transition.name}`} disabled={!!busy} onClick={() => void apply(transition.id)}>{busy === transition.id ? "Applying…" : `${transition.name}${transition.toStatus ? ` → ${transition.toStatus}` : ""}`}</button>)}</div>{error && <p className="mutation-error" role="alert">{error}</p>}</section>;
}

function LinkEditor({ item, api }: { item: WorkItemSummary; api: DisposableItemApi }) {
  const [source, setSource] = useState<WorkItemProviderKind>(item.source === "jira" ? "zendesk" : "jira");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { setSource(item.source === "jira" ? "zendesk" : "jira"); setId(""); setResult(undefined); setError(undefined); }, [item.source, item.id]);
  async function submit() {
    setBusy(true); setError(undefined); setResult(undefined);
    try {
      const link = await api.linkTo({ source, id: id.trim(), key: source === "jira" ? id.trim() : undefined });
      setResult(`Created Jira remote backlink ${link.globalId}.`);
    } catch (caught) { setError(safeMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="editor-block" aria-label="Link Jira and Zendesk"><h3><LinkSimple size={15} /> Link Jira ↔ Zendesk</h3><p className="hint">Creates the supported Jira remote backlink first. Unlinking is not supported by this provider.</p><div className="inline-editor"><label className="sr-only" htmlFor="work-item-link-source">Item source to link</label><select id="work-item-link-source" aria-label="Item source to link" value={source} onChange={(event) => setSource(event.currentTarget.value as WorkItemProviderKind)}><option value="jira">Jira issue</option><option value="zendesk">Zendesk ticket</option></select><label className="sr-only" htmlFor="work-item-link-id">Item ID or key to link</label><input id="work-item-link-id" aria-label="Item ID or key to link" value={id} onChange={(event) => setId(event.currentTarget.value)} placeholder="ID or key" /><button aria-label="Create Jira remote backlink" disabled={busy || !id.trim()} onClick={() => void submit()}>{busy ? "Linking…" : "Create link"}</button></div>{result && <p className="success-note" role="status"><CheckCircle size={15} />{result}</p>}{error && <p className="mutation-error" role="alert">{error}</p>}</section>;
}

function TimelineEmptyAware({ children, emptyText }: { children: ReactNode[]; emptyText: string }) {
  return <div className="timeline">{children.length ? children : <p className="timeline-empty">{emptyText}</p>}</div>;
}

function Field({ label, value }: { label: string; value?: string }) { return <div><dt>{label}</dt><dd>{value || "—"}</dd></div>; }
function SourceBadge({ source }: { source: WorkItemProviderKind }) { return <span className={`source-badge ${source}`} aria-label={labelSource(source)}>{source === "jira" ? "J" : "Z"}</span>; }
function SkeletonRows() { return <div className="skeleton-wrap">{Array.from({ length: 9 }, (_, i) => <div key={i} className="skeleton-row" />)}</div>; }
function DetailSkeleton() { return <div className="detail-skeleton"><div /><div /><div /></div>; }
function EmptyState({ query }: { query: string }) { return <div className="empty-state"><Ticket size={24} /><p>{query ? "No work items match this search and filters." : "No work items returned yet."}</p></div>; }

function collectFilterOptions(items: WorkItemSummary[]) {
  const options = { status: new Set<string>(), priority: new Set<string>(), type: new Set<string>(), person: new Set<string>() };
  for (const item of items) {
    if (item.status) options.status.add(item.status);
    if (item.priority) options.priority.add(item.priority);
    if (item.type) options.type.add(item.type);
    if (item.assignee) options.person.add(item.assignee);
    if (item.requester) options.person.add(item.requester);
  }
  return Object.fromEntries(Object.entries(options).map(([key, set]) => [key, [...set].toSorted((a, b) => a.localeCompare(b))])) as Record<keyof Filters, string[]>;
}

function applyFilters(items: WorkItemSummary[], filters: Filters): WorkItemSummary[] {
  return items.filter((item) => (!filters.status || item.status === filters.status) && (!filters.priority || item.priority === filters.priority) && (!filters.type || item.type === filters.type) && (!filters.person || item.assignee === filters.person || item.requester === filters.person));
}
function getEffectiveSource(source: WorkItemSearchSource, statuses: WorkItemSourceStatuses): WorkItemSearchSource | null {
  const available = (["jira", "zendesk"] as const).filter((candidate) => statuses[candidate].configured && statuses[candidate].connected);
  if (source !== "both") return available.includes(source) ? source : null;
  if (available.length === 2) return "both";
  return available[0] ?? null;
}
function getAppendSource(source: WorkItemSearchSource, statuses: WorkItemSourceStatuses, hasMore: WorkItemSearchPage["hasMore"]): WorkItemSearchSource | null {
  const effective = getEffectiveSource(source, statuses);
  if (!effective) return null;
  if (effective !== "both") return hasMore[effective] ? effective : null;
  const nextSources = (["jira", "zendesk"] as const).filter((candidate) => hasMore[candidate] && statuses[candidate].configured && statuses[candidate].connected);
  if (nextSources.length === 2) return "both";
  return nextSources[0] ?? null;
}
function mergeProviderErrors(current: WorkItemSearchPage["errors"], next: WorkItemSearchPage["errors"]): WorkItemSearchPage["errors"] {
  if (!current?.length) return next;
  if (!next?.length) return current;
  const bySource = new Map(current.map((error) => [error.source, error]));
  for (const error of next) bySource.set(error.source, error);
  return [...bySource.values()];
}
function hasFilters(filters: Filters) { return Object.values(filters).some(Boolean); }
function sameRef(a: WorkItemProviderRef, b?: WorkItemProviderRef) { return !!b && a.source === b.source && a.id === b.id; }
function rowKey(item: WorkItemProviderRef) { return `${item.source}:${item.id}`; }
function rowId(item: WorkItemProviderRef) { return `row-${item.source}-${cssEscape(item.id)}`; }
function cssEscape(value: string) { return value.replace(/[^a-zA-Z0-9_-]/g, "-"); }
function labelSource(source: WorkItemProviderKind) { return source === "jira" ? "Jira" : "Zendesk"; }
function encodeRef(ref: WorkItemProviderRef) { return `${ref.source}:${encodeURIComponent(ref.id)}${ref.key ? `:${encodeURIComponent(ref.key)}` : ""}`; }
function decodeRef(value: string | null): WorkItemProviderRef | null {
  try {
    if (!value) return null;
    const [source, id, key] = value.split(":");
    if (source !== "jira" && source !== "zendesk") return null;
    if (!id) return null;
    return { source, id: decodeURIComponent(id), key: key ? decodeURIComponent(key) : undefined };
  } catch { return null; }
}
type StoredState = { query: string; source: WorkItemSearchSource; filters: Filters; selected: WorkItemProviderRef | null };
function readInitialState(routeState?: string): { query: string; source: WorkItemSearchSource; filters: Filters; selected: WorkItemProviderRef | null } {
  const host = routeState ? new URLSearchParams(routeState) : null;
  const stored = safeJson(safeSessionGet(STORE_KEY));
  const hash = host ?? safeHashParams();
  const source = hash.get("source") ?? stored?.source;
  return {
    query: hash.get("q") ?? stored?.query ?? "",
    source: source === "jira" || source === "zendesk" || source === "both" ? source : "both",
    filters: {
      status: hash.get("status") ?? stored?.filters?.status ?? "",
      priority: hash.get("priority") ?? stored?.filters?.priority ?? "",
      type: hash.get("type") ?? stored?.filters?.type ?? "",
      person: hash.get("person") ?? stored?.filters?.person ?? "",
    },
    selected: decodeRef(hash.get("selected")) ?? stored?.selected ?? null,
  };
}
function safeSessionGet(key: string): string | null { try { return sessionStorage.getItem(key); } catch { return null; } }
function safeSetStoredState(state: StoredState): void { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} }
function safeHashParams(): URLSearchParams { try { return new URLSearchParams(location.hash.replace(/^#/, "")); } catch { return new URLSearchParams(); } }
function encodeStoredState(state: StoredState): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.source !== "both") params.set("source", state.source);
  for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
  if (state.selected) params.set("selected", encodeRef(state.selected));
  return params.toString();
}
function safeReplaceHash(state: StoredState): void {
  try {
    const params = encodeStoredState(state);
    history.replaceState(null, "", `${location.pathname}${location.search}${params ? `#${params}` : ""}`);
  } catch {}
}
function safeJson(value: string | null): any { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!target.closest("[contenteditable='true'],[role='textbox']");
}
function isMobileLayout(): boolean { try { return window.matchMedia("(max-width: 900px)").matches; } catch { return false; } }
function clampDetailWidth(value: number): number {
  const viewportMax = typeof window === "undefined" ? DETAIL_WIDTH.max : Math.max(DETAIL_WIDTH.min, window.innerWidth - DETAIL_WIDTH.margin);
  return Math.min(Math.max(value, DETAIL_WIDTH.min), Math.min(DETAIL_WIDTH.max, viewportMax));
}
function normalizeProviderText(value: string): string {
  return value.replace(/&nbsp;/gi, "\u00a0").replace(/\u00a0{2,}/g, (spaces) => " ".repeat(spaces.length));
}
function safeLinkHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : undefined;
  } catch { return undefined; }
}
function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true");
}
function setRowRef(item: WorkItemProviderRef, node: HTMLButtonElement | null, refs: Map<string, HTMLButtonElement>): void {
  const key = rowKey(item);
  if (node) refs.set(key, node); else refs.delete(key);
}
function scrollRowIntoView(item: WorkItemSummary | undefined, refs: Map<string, HTMLButtonElement>): void {
  const node = item ? refs.get(rowKey(item)) : undefined;
  if (typeof node?.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
}
function safeMessage(caught: unknown): string { return (caught instanceof Error ? caught.message : String(caught || "Unknown error")).slice(0, 300); }
function fullDate(value?: string) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function relativeDate(value?: string) { if (!value) return "—"; const date = new Date(value).valueOf(); if (Number.isNaN(date)) return value; const diff = Date.now() - date; const abs = Math.abs(diff); const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); if (abs < 60_000) return "just now"; if (abs < 3_600_000) return rtf.format(Math.round(-diff / 60_000), "minute"); if (abs < 86_400_000) return rtf.format(Math.round(-diff / 3_600_000), "hour"); return rtf.format(Math.round(-diff / 86_400_000), "day"); }
function parseFieldValue(input: string): string | number | boolean | null | string[] { const value = input.trim(); if (value === "null") return null; if (value === "true") return true; if (value === "false") return false; if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value); if (value.includes(",")) return value.split(",").map((part) => part.trim()).filter(Boolean); return value; }
