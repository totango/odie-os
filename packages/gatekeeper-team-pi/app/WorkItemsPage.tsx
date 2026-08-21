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
  Trash,
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
  WorkItemSavedView,
  WorkItemSearchPage,
  WorkItemSearchSource,
  WorkItemSourceStatuses,
  WorkItemSummary,
  WorkItemsCurrentUser,
  WorkItemsManagementApi,
} from "../src/types";
import { useWorkItemsApi, useWorkItemsRouteState, type WorkItemsRouteStateHost } from "./bridge";

type DisposableItemApi = WorkItemManagementApi & { [Symbol.dispose]?: () => void };
type Selected = { stub: DisposableItemApi; ref: WorkItemProviderRef };
type MutationContext = { stub: DisposableItemApi; ref: WorkItemProviderRef; epoch: number };
type Filters = { status: string; priority: string; type: string; person: string };
type Tab = "comments" | "activity";
type StatusLoadResult = { ok: true; statuses: WorkItemSourceStatuses } | { ok: false };
type ViewMode = "list" | "kanban";

const EMPTY_FILTERS: Filters = { status: "", priority: "", type: "", person: "" };
const STORE_KEY = "team-pi-work-items:v1";
const BUILTIN_MY_WORK = "builtin:my-work";
const BUILTIN_ALL = "builtin:all";
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
  const [currentUser, setCurrentUser] = useState<WorkItemsCurrentUser | null>(null);
  const [savedViews, setSavedViews] = useState<WorkItemSavedView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState(initial.viewId);
  const [viewMode, setViewMode] = useState<ViewMode>(initial.view);
  const [hiddenStatuses, setHiddenStatuses] = useState<string[]>(initial.hiddenStatuses);
  const [newViewName, setNewViewName] = useState("");
  const [viewsBusy, setViewsBusy] = useState(false);
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
  const defaultedUserFilter = useRef(false);

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
    let cancelled = false;
    void (async () => {
      try {
        const [user, views] = await Promise.all([
          api.getCurrentUser().catch(() => null),
          api.listSavedViews().catch(() => []),
        ]);
        if (cancelled) return;
        setCurrentUser(user);
        setSavedViews(views);
        if (initial.viewId && !isBuiltinView(initial.viewId)) {
          const saved = views.find((view) => view.id === initial.viewId);
          if (saved) applySavedView(saved, { setQuery, setSource, setFilters, setViewMode, setHiddenStatuses, setSelectedViewId });
        }
      } catch {
        // Optional convenience metadata must not block work item search.
      }
    })();
    return () => { cancelled = true; };
    // Initial route selection is consumed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (defaultedUserFilter.current || initial.explicitPersonOrView || !currentUser) return;
    const person = preferredUserToken(currentUser);
    if (!person) return;
    defaultedUserFilter.current = true;
    setFilters((current) => current.person ? current : { ...current, person });
    setSelectedViewId(BUILTIN_MY_WORK);
  }, [currentUser, initial.explicitPersonOrView]);

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
  const kanbanStatuses = useMemo(() => collectStatuses(filteredItems), [filteredItems]);
  const selectableKanbanStatuses = useMemo(
    () => [...new Set([...kanbanStatuses, ...hiddenStatuses])].toSorted((a, b) => a.localeCompare(b)),
    [hiddenStatuses, kanbanStatuses],
  );
  const hiddenSet = useMemo(() => new Set(hiddenStatuses), [hiddenStatuses]);

  const persist = useCallback(
    (nextSelected = selected?.ref) => {
      const state = { query, source, filters, selected: nextSelected ?? null, view: viewMode, hiddenStatuses, viewId: selectedViewId };
      safeSetStoredState(state);
      if (routeStateHost?.setRouteState) routeStateHost.setRouteState(encodeStoredState(state));
      else safeReplaceHash(state);
    },
    [filters, hiddenStatuses, query, routeStateHost, selected?.ref, selectedViewId, source, viewMode],
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
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

      <section className="saved-views" aria-label="Saved work item views">
        <div className="view-tabs" aria-label="Saved views">
          <button type="button" aria-pressed={selectedViewId === BUILTIN_MY_WORK} onClick={() => applyBuiltinView(BUILTIN_MY_WORK, currentUser, { setQuery, setSource, setFilters, setViewMode, setHiddenStatuses, setSelectedViewId })}>My work</button>
          <button type="button" aria-pressed={selectedViewId === BUILTIN_ALL} onClick={() => applyBuiltinView(BUILTIN_ALL, currentUser, { setQuery, setSource, setFilters, setViewMode, setHiddenStatuses, setSelectedViewId })}>All items</button>
          {savedViews.map((view) => <button key={view.id} type="button" aria-pressed={selectedViewId === view.id} onClick={() => applySavedView(view, { setQuery, setSource, setFilters, setViewMode, setHiddenStatuses, setSelectedViewId })}>{view.name}</button>)}
        </div>
        <div className="view-actions">
          <fieldset className="segment"><legend className="sr-only">Result view</legend>{(["list", "kanban"] as const).map((mode) => <label key={mode} data-active={viewMode === mode}><input type="radio" name="work-item-view-mode" checked={viewMode === mode} onChange={() => setViewMode(mode)} />{mode === "list" ? "List" : "Kanban"}</label>)}</fieldset>
          <label className="save-view-name"><span className="sr-only">New view name</span><input value={newViewName} onChange={(event) => setNewViewName(event.currentTarget.value)} placeholder="Name this view…" /></label>
          <button type="button" disabled={viewsBusy || !newViewName.trim()} onClick={() => void saveCurrentView(api, { name: newViewName, query, source, filters, view: viewMode, hiddenStatuses }, { setViewsBusy, setSavedViews, setSelectedViewId, setNewViewName, setError })}>Save view</button>
          {!isBuiltinView(selectedViewId) && <button className="danger-link" type="button" disabled={viewsBusy} onClick={() => void deleteCurrentView(api, selectedViewId, currentUser, { setViewsBusy, setSavedViews, setQuery, setSource, setFilters, setViewMode, setHiddenStatuses, setSelectedViewId, setError })}><Trash size={14} /> Delete</button>}
        </div>
      </section>

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

      {viewMode === "kanban" && <section className="kanban-controls" aria-label="Kanban column visibility">
        <span>{hiddenStatuses.length} hidden</span>
        {selectableKanbanStatuses.map((status) => <label key={status}><input type="checkbox" checked={!hiddenSet.has(status)} onChange={(event) => { const checked = event.currentTarget.checked; setHiddenStatuses((current) => checked ? current.filter((value) => value !== status) : [...new Set([...current, status])]); }} /> Show {status}</label>)}
      </section>}

      {statuses && (!statuses.jira.configured || !statuses.jira.connected || !statuses.zendesk.configured || !statuses.zendesk.connected) && (
        <Banner tone="neutral" title="Provider setup" message="Disconnected or unconfigured providers stay visible here so admins know what Team PI needs before searching." />
      )}
      {page.errors?.map((providerError) => (
        <Banner key={providerError.source} tone="warning" title={`${labelSource(providerError.source)} search failed`} message={providerError.message} />
      ))}
      {error && <Banner tone="danger" title="Couldn’t load work items" message={error} action={<button onClick={() => void refreshAll()}>Retry</button>} />}

      <div className="content-grid">
        <section className="list-pane" aria-label="Work item results">
          {viewMode === "list" ? <>
            <div className="list-head" role="row"><span>Source</span><span>Key</span><span>Title</span><span>Status</span><span>Priority</span><span>Owner</span><span>Updated</span></div>
            <div ref={listRef} className="work-list" role="list" tabIndex={0} aria-label="Work items. Use arrow keys to move and Enter to open." onKeyDown={onListKeyDown} aria-busy={loading} aria-live="polite">
              {loading ? <SkeletonRows /> : filteredItems.length === 0 ? <EmptyState query={debouncedQuery} /> : filteredItems.map((item, index) => <WorkItemRow key={`${item.source}:${item.id}`} item={item} active={index === activeIndex} selected={sameRef(item, selected?.ref)} rowRef={(node) => setRowRef(item, node, rowRefs.current)} onFocus={() => setActiveIndex(index)} onOpen={() => void selectItem(item)} />)}
            </div>
          </> : <KanbanBoard items={filteredItems} statuses={kanbanStatuses} hiddenStatuses={hiddenSet} loading={loading} query={debouncedQuery} selected={selected?.ref} onOpen={(item) => void selectItem(item)} />}
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
        rootApi={api}
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
  const allOptions = value && !options.includes(value) ? [value, ...options] : options;
  return <label className="filter-select"><span>{label}</span><select value={value} onChange={(event) => onChange(event.currentTarget.value)}><option value="">Any</option>{allOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
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

function KanbanBoard({ items, statuses, hiddenStatuses, loading, query, selected, onOpen }: { items: WorkItemSummary[]; statuses: string[]; hiddenStatuses: Set<string>; loading: boolean; query: string; selected?: WorkItemProviderRef; onOpen: (item: WorkItemSummary) => void }) {
  const visibleStatuses = statuses.filter((status) => !hiddenStatuses.has(status));
  if (loading) return <div className="work-list"><SkeletonRows /></div>;
  if (items.length === 0) return <EmptyState query={query} />;
  return <div className="kanban-board" aria-label="Kanban work items">{visibleStatuses.map((status) => {
    const columnItems = items.filter((item) => (item.status || "No status") === status);
    return <section key={status} className="kanban-column" aria-labelledby={`kanban-${cssEscape(status)}`}><h2 id={`kanban-${cssEscape(status)}`}>{status} <span>{columnItems.length}</span></h2><div className="kanban-cards">{columnItems.map((item) => <button key={rowKey(item)} type="button" className="kanban-card" aria-current={sameRef(item, selected) ? "true" : undefined} onClick={() => onOpen(item)}><div><SourceBadge source={item.source} /><span className="mono">{item.key ?? item.id}</span></div><strong>{item.title}</strong><p>{item.assignee || item.requester || "Unassigned"}</p><div className="compact-chip-row"><span>{item.type || "No type"}</span><span>{item.priority || "No priority"}</span></div></button>)}</div></section>;
  })}{visibleStatuses.length === 0 && <p className="empty-state">All kanban columns are hidden.</p>}</div>;
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
  rootApi: WorkItemsManagementApi;
}) {
  const { selected, read, loading, error, tab, setTab, notice, backButtonRef, onClose, onRetry, mutationEpoch, onMutated, rootApi } = props;
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
      <MetadataEditor read={read} api={selected.stub} mutationEpoch={mutationEpoch} onMutated={onMutated} />
      {notice && <p className="success-note" role="status"><CheckCircle size={15} />{notice}</p>}
      <DescriptionEditor read={read} api={selected.stub} mutationEpoch={mutationEpoch} onMutated={onMutated} />
      <CommentComposer item={item} api={selected.stub} mutationEpoch={mutationEpoch} onMutated={onMutated} />
      {item.source === "jira" && <TransitionEditor item={item} transitions={read.transitions} api={selected.stub} mutationEpoch={mutationEpoch} onMutated={onMutated} />}
      <LinkEditor item={item} api={selected.stub} rootApi={rootApi} />
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

function MetadataEditor({ read, api, mutationEpoch, onMutated }: { read: WorkItemRead; api: DisposableItemApi; mutationEpoch: number; onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void }) {
  const item = read.detail.item;
  const allowed = new Set(read.updateOptions.allowedFields.map((field) => field.toLowerCase()));
  const tagsValue = String(item.fields.labels ?? item.fields.tags ?? "");
  const chips = [
    { label: item.source === "zendesk" ? "Requester" : "Assignee", field: item.source === "zendesk" ? "requester" : "assignee", value: item.assignee || item.requester || "Unassigned" },
    { label: "Type", field: "type", value: item.type || "—" },
    { label: "Status", field: "status", value: item.status || "—", readonly: item.source === "jira" },
    { label: "Priority", field: "priority", value: item.priority || "—" },
    { label: "Labels/tags", field: item.fields.labels === undefined ? "tags" : "labels", value: tagsValue || "—" },
  ];
  return <section className="metadata-section" aria-label="Work item metadata"><div className="metadata-chips">{chips.map((chip) => <InlineFieldChip key={chip.field} chip={chip} editable={!chip.readonly && allowed.has(chip.field.toLowerCase())} item={item} api={api} mutationEpoch={mutationEpoch} onMutated={onMutated} />)}<div className="meta-chip readonly"><span>Updated</span><strong>{fullDate(item.updatedAt)}</strong></div></div>{read.updateOptions.providerOptions?.length ? <p className="hint">Provider options: {read.updateOptions.providerOptions.join(", ")}</p> : null}</section>;
}

function InlineFieldChip({ chip, editable, item, api, mutationEpoch, onMutated }: { chip: { label: string; field: string; value: string }; editable: boolean; item: WorkItemSummary; api: DisposableItemApi; mutationEpoch: number; onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(chip.value === "—" || chip.value === "Unassigned" ? "" : chip.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setEditing(false); setValue(chip.value === "—" || chip.value === "Unassigned" ? "" : chip.value); setError(undefined); }, [chip.field, chip.value, item.id]);
  async function submit() {
    setBusy(true); setError(undefined);
    try {
      const nextValue = chip.field === "labels" || chip.field === "tags"
        ? value.split(",").map((part) => part.trim()).filter(Boolean)
        : value;
      const patch: WorkItemFieldPatch = { fields: { [chip.field]: nextValue } };
      onMutated(await api.updateFields(patch), { stub: api, ref: item, epoch: mutationEpoch });
      setEditing(false);
    } catch (caught) { setError(safeMessage(caught)); }
    finally { setBusy(false); }
  }
  return <div className={`meta-chip ${editable ? "editable" : "readonly"}`}><span>{chip.label}</span>{editing ? <><input aria-label={`${chip.label} value`} value={value} onChange={(event) => setValue(event.currentTarget.value)} /><button type="button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></> : <><strong>{chip.value}</strong>{editable && <button type="button" aria-label={`Edit ${chip.label}`} onClick={() => setEditing(true)}><PencilSimple size={13} /></button>}</>}{error && <em role="alert">{error}</em>}</div>;
}

function DescriptionEditor({ read, api, mutationEpoch, onMutated }: { read: WorkItemRead; api: DisposableItemApi; mutationEpoch: number; onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void }) {
  const item = read.detail.item;
  const allowed = read.updateOptions.allowedFields.some((field) => field.toLowerCase() === "description");
  const description = String(item.fields.description ?? "");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setEditing(false); setValue(description); setError(undefined); }, [description, item.id]);
  async function submit() {
    setBusy(true); setError(undefined);
    try {
      onMutated(await api.updateFields({ fields: { description: value } }), { stub: api, ref: item, epoch: mutationEpoch });
      setEditing(false);
    } catch (caught) { setError(safeMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="description-section" aria-label="Description"><div className="section-heading"><h3>Description</h3>{allowed && !editing && <button type="button" onClick={() => setEditing(true)}><PencilSimple size={14} /> Edit</button>}</div>{editing ? <><textarea aria-label="Description body" value={value} onChange={(event) => setValue(event.currentTarget.value)} /><div className="inline-editor"><button type="button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save description"}</button><button type="button" onClick={() => { setEditing(false); setValue(description); }}>Cancel</button></div></> : description ? <RichText value={description} /> : <p className="hint">No description returned by the provider.</p>}{error && <p className="mutation-error" role="alert">{error}</p>}</section>;
}

function TransitionEditor({ item, transitions, api, mutationEpoch, onMutated }: { item: WorkItemSummary; transitions: WorkItemRead["transitions"]; api: DisposableItemApi; mutationEpoch: number; onMutated: (detail: WorkItemDetail, ctx: MutationContext) => void }) {
  const [selectedTransition, setSelectedTransition] = useState(transitions[0]?.id ?? "");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => setSelectedTransition(transitions[0]?.id ?? ""), [transitions.map((transition) => transition.id).join("\0")]);
  if (transitions.length === 0) return null;
  async function apply(id: string) {
    setBusy(id); setError(undefined);
    try { onMutated(await api.transition(id), { stub: api, ref: item, epoch: mutationEpoch }); } catch (caught) { setError(safeMessage(caught)); } finally { setBusy(undefined); }
  }
  return <section className="editor-block compact-transition" aria-label="Apply Jira transition"><h3><GitBranch size={15} /> Jira transition near status</h3><div className="inline-editor"><label className="sr-only" htmlFor="jira-transition">Jira transition</label><select id="jira-transition" value={selectedTransition} onChange={(event) => setSelectedTransition(event.currentTarget.value)}>{transitions.map((transition) => <option key={transition.id} value={transition.id}>{transition.name}{transition.toStatus ? ` → ${transition.toStatus}` : ""}</option>)}</select><button type="button" aria-label="Apply selected Jira transition" disabled={!!busy || !selectedTransition} onClick={() => void apply(selectedTransition)}>{busy ? "Applying…" : "Apply"}</button></div>{error && <p className="mutation-error" role="alert">{error}</p>}</section>;
}

function LinkEditor({ item, api, rootApi }: { item: WorkItemSummary; api: DisposableItemApi; rootApi: WorkItemsManagementApi }) {
  const [source, setSource] = useState<WorkItemProviderKind>(item.source === "jira" ? "zendesk" : "jira");
  const [id, setId] = useState("");
  const [suggestions, setSuggestions] = useState<WorkItemSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { setSource(item.source === "jira" ? "zendesk" : "jira"); setId(""); setResult(undefined); setError(undefined); }, [item.source, item.id]);
  useEffect(() => {
    const query = id.trim();
    let cancelled = false;
    if (query.length < 2) { setSuggestions([]); return; }
    const timer = window.setTimeout(() => {
      setSearching(true);
      void rootApi.search({ source, query, limit: 8 }).then((page) => {
        if (!cancelled) setSuggestions(page.items.filter((candidate) => !sameRef(candidate, item)));
      }).catch((caught) => {
        if (!cancelled) setError(safeMessage(caught));
      }).finally(() => {
        if (!cancelled) setSearching(false);
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id, item, rootApi, source]);
  async function submit() {
    setBusy(true); setError(undefined); setResult(undefined);
    try {
      const link = await api.linkTo({ source, id: id.trim(), key: source === "jira" ? id.trim() : undefined });
      setResult(`Created Jira remote backlink ${link.globalId}.`);
    } catch (caught) { setError(safeMessage(caught)); }
    finally { setBusy(false); }
  }
  return <section className="editor-block" aria-label="Link Jira and Zendesk"><h3><LinkSimple size={15} /> Link Jira ↔ Zendesk</h3><p className="hint">Search the opposite source or enter a provider ID/key manually.</p><div className="inline-editor"><label className="sr-only" htmlFor="work-item-link-source">Item source to link</label><select id="work-item-link-source" aria-label="Item source to link" value={source} onChange={(event) => setSource(event.currentTarget.value as WorkItemProviderKind)}><option value="jira">Jira issue</option><option value="zendesk">Zendesk ticket</option></select><label className="sr-only" htmlFor="work-item-link-id">Search or enter item ID/key to link</label><input id="work-item-link-id" aria-label="Search or enter item ID/key to link" value={id} onChange={(event) => setId(event.currentTarget.value)} placeholder="Search by title, ID, or key" /><button aria-label="Create Jira remote backlink" disabled={busy || !id.trim()} onClick={() => void submit()}>{busy ? "Linking…" : "Create link"}</button></div>{searching && <p className="hint" aria-live="polite">Searching…</p>}{suggestions.length > 0 && <div className="link-suggestions" aria-label="Link suggestions">{suggestions.map((suggestion) => <button key={rowKey(suggestion)} type="button" onClick={() => { setSource(suggestion.source); setId(suggestion.key ?? suggestion.id); }}><SourceBadge source={suggestion.source} /><span>{suggestion.key ?? suggestion.id}</span><strong>{suggestion.title}</strong></button>)}</div>}<p className="hint">Manual fallback: type an exact Jira key or Zendesk ticket ID, then Create link.</p>{result && <p className="success-note" role="status"><CheckCircle size={15} />{result}</p>}{error && <p className="mutation-error" role="alert">{error}</p>}</section>;
}

function TimelineEmptyAware({ children, emptyText }: { children: ReactNode[]; emptyText: string }) {
  return <div className="timeline">{children.length ? children : <p className="timeline-empty">{emptyText}</p>}</div>;
}

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
  return items.filter((item) => (!filters.status || item.status === filters.status) && (!filters.priority || item.priority === filters.priority) && (!filters.type || item.type === filters.type) && personMatches(filters.person, item.assignee, item.requester));
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
function isBuiltinView(id: string) { return id === BUILTIN_MY_WORK || id === BUILTIN_ALL; }
function preferredUserToken(user: WorkItemsCurrentUser | null): string { return user?.uniqueName || user?.displayName || ""; }
function normalizePerson(value: string): string {
  return value.toLowerCase().replace(/@.*$/, "").replace(/[._-]+/g, " ").replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}
function personMatches(filter: string, ...values: Array<string | undefined>): boolean {
  if (!filter) return true;
  const wanted = normalizePerson(filter);
  return values.some((value) => {
    const candidate = normalizePerson(value ?? "");
    return !!candidate && (candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate));
  });
}
function collectStatuses(items: WorkItemSummary[]): string[] {
  const set = new Set<string>();
  for (const item of items) set.add(item.status || "No status");
  return [...set].toSorted((a, b) => a.localeCompare(b));
}
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
function applyBuiltinView(id: string, user: WorkItemsCurrentUser | null, setters: { setQuery: (value: string) => void; setSource: (value: WorkItemSearchSource) => void; setFilters: React.Dispatch<React.SetStateAction<Filters>>; setViewMode: (value: ViewMode) => void; setHiddenStatuses: (value: string[]) => void; setSelectedViewId: (value: string) => void }) {
  setters.setQuery("");
  setters.setSource("both");
  setters.setFilters(id === BUILTIN_MY_WORK ? { ...EMPTY_FILTERS, person: preferredUserToken(user) } : EMPTY_FILTERS);
  setters.setViewMode("list");
  setters.setHiddenStatuses([]);
  setters.setSelectedViewId(id);
}
function applySavedView(view: WorkItemSavedView, setters: { setQuery: (value: string) => void; setSource: (value: WorkItemSearchSource) => void; setFilters: (value: Filters) => void; setViewMode: (value: ViewMode) => void; setHiddenStatuses: (value: string[]) => void; setSelectedViewId: (value: string) => void }) {
  setters.setQuery(view.query);
  setters.setSource(view.source);
  setters.setFilters(view.filters);
  setters.setViewMode(view.view);
  setters.setHiddenStatuses(view.hiddenStatuses);
  setters.setSelectedViewId(view.id);
}
async function saveCurrentView(api: WorkItemsManagementApi, view: Omit<WorkItemSavedView, "id"> & { name: string }, setters: { setViewsBusy: (value: boolean) => void; setSavedViews: React.Dispatch<React.SetStateAction<WorkItemSavedView[]>>; setSelectedViewId: (value: string) => void; setNewViewName: (value: string) => void; setError: (value: string | undefined) => void }) {
  setters.setViewsBusy(true); setters.setError(undefined);
  try {
    const saved = await api.saveSavedView({ ...view, id: `custom:${Date.now().toString(36)}` });
    setters.setSavedViews((current) => [...current.filter((existing) => existing.id !== saved.id), saved]);
    setters.setSelectedViewId(saved.id);
    setters.setNewViewName("");
  } catch (caught) { setters.setError(safeMessage(caught)); }
  finally { setters.setViewsBusy(false); }
}
async function deleteCurrentView(api: WorkItemsManagementApi, id: string, user: WorkItemsCurrentUser | null, setters: { setViewsBusy: (value: boolean) => void; setSavedViews: React.Dispatch<React.SetStateAction<WorkItemSavedView[]>>; setQuery: (value: string) => void; setSource: (value: WorkItemSearchSource) => void; setFilters: React.Dispatch<React.SetStateAction<Filters>>; setViewMode: (value: ViewMode) => void; setHiddenStatuses: (value: string[]) => void; setSelectedViewId: (value: string) => void; setError: (value: string | undefined) => void }) {
  if (isBuiltinView(id)) return;
  setters.setViewsBusy(true); setters.setError(undefined);
  try {
    await api.deleteSavedView(id);
    setters.setSavedViews((current) => current.filter((view) => view.id !== id));
    applyBuiltinView(BUILTIN_MY_WORK, user, setters);
  } catch (caught) { setters.setError(safeMessage(caught)); }
  finally { setters.setViewsBusy(false); }
}
type StoredState = { query: string; source: WorkItemSearchSource; filters: Filters; selected: WorkItemProviderRef | null; view: ViewMode; hiddenStatuses: string[]; viewId: string };
function readInitialState(routeState?: string): StoredState & { explicitPersonOrView: boolean } {
  const host = routeState ? new URLSearchParams(routeState) : null;
  const stored = safeJson(safeSessionGet(STORE_KEY));
  const hash = host ?? safeHashParams();
  const source = hash.get("source") ?? stored?.source;
  const view = hash.get("view") ?? stored?.view;
  const viewId = hash.get("viewId") ?? stored?.viewId ?? BUILTIN_MY_WORK;
  const hiddenStatuses = hash.get("hiddenStatuses")?.split(",").filter(Boolean) ?? (Array.isArray(stored?.hiddenStatuses) ? stored.hiddenStatuses : []);
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
    view: view === "kanban" ? "kanban" : "list",
    hiddenStatuses,
    viewId,
    explicitPersonOrView: hash.has("person") || (hash.has("viewId") && viewId !== BUILTIN_MY_WORK) || !!stored?.filters?.person || (!!stored?.viewId && stored.viewId !== BUILTIN_MY_WORK),
  };
}
function safeSessionGet(key: string): string | null { try { return sessionStorage.getItem(key); } catch { return null; } }
function safeSetStoredState(state: StoredState): void { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} }
function safeHashParams(): URLSearchParams { try { return new URLSearchParams(location.hash.replace(/^#/, "")); } catch { return new URLSearchParams(); } }
function encodeStoredState(state: StoredState): string {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.source !== "both") params.set("source", state.source);
  if (state.view !== "list") params.set("view", state.view);
  if (state.viewId !== BUILTIN_MY_WORK) params.set("viewId", state.viewId);
  if (state.hiddenStatuses.length) params.set("hiddenStatuses", state.hiddenStatuses.join(","));
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
