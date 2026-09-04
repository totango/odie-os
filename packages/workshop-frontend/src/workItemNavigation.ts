export type WorkItemTarget = {
  source: "jira" | "zendesk";
  id: string;
  key?: string;
  url?: string;
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
    const trustedJiraHost = hostname.endsWith(".atlassian.net");
    if (trustedJiraHost && jiraKey && JIRA_KEY_PATTERN.test(jiraKey)) {
      const key = jiraKey.toUpperCase();
      return { source: "jira", id: key, key, url: url.toString() };
    }

    const ticketsIndex = segments.findIndex((segment, index) =>
      segment.toLowerCase() === "tickets" && segments[index - 1]?.toLowerCase() === "agent");
    const ticketId = ticketsIndex >= 0 ? segments[ticketsIndex + 1] : undefined;
    if (hostname.endsWith(".zendesk.com") && ticketId && /^\d+$/.test(ticketId)) {
      return { source: "zendesk", id: ticketId, url: url.toString() };
    }
  } catch {
    // Invalid and non-URL hrefs keep the ordinary markdown-link behavior.
  }
  return null;
}

/** Encodes the selected item using the route-state contract owned by the Work Items app. */
export function workItemRouteState(target: WorkItemTarget): string {
  const encodedRef = `${target.source}:${encodeURIComponent(target.id)}${target.key ? `:${encodeURIComponent(target.key)}` : ""}`;
  const params = new URLSearchParams({ selected: encodedRef });
  if (target.url) params.set("selectedUrl", target.url);
  return params.toString();
}


/** Validates a structured Work Items reference received from the first-party Work Items app. */
export function normalizeWorkItemTarget(
  source: unknown,
  id: unknown,
  key: unknown,
  url?: unknown,
): WorkItemTarget {
  if (source !== "jira" && source !== "zendesk") throw new TypeError("Invalid work item source.");
  if (typeof id !== "string") throw new TypeError("Invalid work item identifier.");
  const normalizedId = id.trim();
  if (source === "zendesk") {
    if (!/^\d{1,30}$/.test(normalizedId) || key !== undefined) {
      throw new TypeError("Invalid Zendesk work item reference.");
    }
    const providerUrl = validateProviderUrl(source, url, normalizedId);
    return { source, id: normalizedId, ...(providerUrl ? { url: providerUrl } : {}) };
  }
  if (!/^[A-Z0-9][A-Z0-9_-]{0,179}$/i.test(normalizedId)) {
    throw new TypeError("Invalid Jira work item identifier.");
  }
  if (key === undefined) {
    const providerUrl = validateProviderUrl(source, url);
    return { source, id: normalizedId, ...(providerUrl ? { url: providerUrl } : {}) };
  }
  if (typeof key !== "string" || !JIRA_KEY_PATTERN.test(key.trim())) {
    throw new TypeError("Invalid Jira work item key.");
  }
  const normalizedKey = key.trim().toUpperCase();
  const providerUrl = validateProviderUrl(source, url, normalizedKey);
  return { source, id: normalizedId, key: normalizedKey, ...(providerUrl ? { url: providerUrl } : {}) };
}

/** Builds the fixed Workshop-owned instruction used after the user confirms a Code session. */
export function codingSessionInputForWorkItem(target: WorkItemTarget): string {
  const provider = target.source === "jira" ? "Jira" : "Zendesk";
  const reference = target.key ?? target.id;
  const binding = target.source === "jira" ? "JIRA_SITE, JIRA_PROJECT, or JIRA_ISSUE" : "ZENDESK or ZENDESK_TICKET";
  const urlInstruction = target.url ? ` The original provider URL is ${target.url}; use that URL to select the exact ${provider} site before resolving the work item.` : "";
  return `Start working on the ${provider} work item ${reference}.${urlInstruction} Use the connected native ${binding} binding and its ${provider} coding tools to read the authoritative work item before making changes.`;
}

function validateProviderUrl(source: "jira" | "zendesk", value: unknown, expectedIdOrKey?: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("Invalid work item provider URL.");
  const target = workItemTargetFromAbsoluteUrl(value);
  if (!target || target.source !== source) throw new TypeError("Invalid work item provider URL.");
  if (expectedIdOrKey && target.source === "jira" && target.key !== expectedIdOrKey.toUpperCase()) {
    throw new TypeError("Jira provider URL does not match work item key.");
  }
  if (expectedIdOrKey && target.source === "zendesk" && target.id !== expectedIdOrKey) {
    throw new TypeError("Zendesk provider URL does not match work item id.");
  }
  return target.url;
}

function workItemTargetFromAbsoluteUrl(href: string): WorkItemTarget | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const hostname = url.hostname.toLowerCase();
    const browseIndex = segments.findIndex((segment) => segment.toLowerCase() === "browse");
    const jiraKey = browseIndex >= 0 ? segments[browseIndex + 1] : undefined;
    if (hostname.endsWith(".atlassian.net") && jiraKey && JIRA_KEY_PATTERN.test(jiraKey)) {
      const key = jiraKey.toUpperCase();
      return { source: "jira", id: key, key, url: url.toString() };
    }
    const ticketsIndex = segments.findIndex((segment, index) =>
      segment.toLowerCase() === "tickets" && segments[index - 1]?.toLowerCase() === "agent");
    const ticketId = ticketsIndex >= 0 ? segments[ticketsIndex + 1] : undefined;
    if (hostname.endsWith(".zendesk.com") && ticketId && /^\d+$/.test(ticketId)) {
      return { source: "zendesk", id: ticketId, url: url.toString() };
    }
  } catch {}
  return null;
}
