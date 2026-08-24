export type WorkItemTarget = {
  source: "jira" | "zendesk";
  id: string;
  key?: string;
};

const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/i;

/**
 * Recognizes provider UI links emitted in chat so the Workshop can open the same item in Work Items.
 */
export function workItemTargetFromUrl(href: string | undefined): WorkItemTarget | null {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const hostname = url.hostname.toLowerCase();

    const browseIndex = segments.findIndex((segment) => segment.toLowerCase() === "browse");
    const jiraKey = browseIndex >= 0 ? segments[browseIndex + 1] : undefined;
    if (hostname.endsWith(".atlassian.net") && jiraKey && JIRA_KEY_PATTERN.test(jiraKey)) {
      const key = jiraKey.toUpperCase();
      return { source: "jira", id: key, key };
    }

    const ticketsIndex = segments.findIndex((segment, index) =>
      segment.toLowerCase() === "tickets" && segments[index - 1]?.toLowerCase() === "agent");
    const ticketId = ticketsIndex >= 0 ? segments[ticketsIndex + 1] : undefined;
    if (hostname.endsWith(".zendesk.com") && ticketId && /^\d+$/.test(ticketId)) {
      return { source: "zendesk", id: ticketId };
    }
  } catch {
    // Invalid and non-URL hrefs keep the ordinary markdown-link behavior.
  }
  return null;
}

/** Encodes the selected item using the route-state contract owned by the Team PI Work Items app. */
export function workItemRouteState(target: WorkItemTarget): string {
  const encodedRef = `${target.source}:${encodeURIComponent(target.id)}${target.key ? `:${encodeURIComponent(target.key)}` : ""}`;
  return new URLSearchParams({ selected: encodedRef }).toString();
}


/** Validates a structured Work Items reference received from the first-party Team PI app. */
export function normalizeWorkItemTarget(
  source: unknown,
  id: unknown,
  key: unknown,
): WorkItemTarget {
  if (source !== "jira" && source !== "zendesk") throw new TypeError("Invalid work item source.");
  if (typeof id !== "string") throw new TypeError("Invalid work item identifier.");
  const normalizedId = id.trim();
  if (source === "zendesk") {
    if (!/^\d{1,30}$/.test(normalizedId) || key !== undefined) {
      throw new TypeError("Invalid Zendesk work item reference.");
    }
    return { source, id: normalizedId };
  }
  if (!/^[A-Z0-9][A-Z0-9_-]{0,179}$/i.test(normalizedId)) {
    throw new TypeError("Invalid Jira work item identifier.");
  }
  if (key === undefined) return { source, id: normalizedId };
  if (typeof key !== "string" || !JIRA_KEY_PATTERN.test(key.trim())) {
    throw new TypeError("Invalid Jira work item key.");
  }
  return { source, id: normalizedId, key: key.trim().toUpperCase() };
}

/** Builds the fixed Workshop-owned instruction used after the user confirms a Code session. */
export function codingSessionInputForWorkItem(target: WorkItemTarget): string {
  const provider = target.source === "jira" ? "Jira" : "Zendesk";
  const reference = target.key ?? target.id;
  return `Start working on the ${provider} work item ${reference}. Use the connected Team PI Work Items tools to read the authoritative issue and related customer context before making changes.`;
}
