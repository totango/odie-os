import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { JiraApi, jqlLiteral, parseIssueKeyOrId, type AccessibleResource } from "./jira-api";
import type { ConfiguratorOption, JiraConfiguratorRpc } from "./configurator/jira-configurator-types";

const OPTION_LIMIT = 50;
type Context = { getSites: () => Promise<AccessibleResource[]>; getToken: () => Promise<string> };
const contexts = new WeakMap<object, Context>();
const ctx = (target: object): Context => {
  const value = contexts.get(target);
  if (!value) throw new Error("Jira configurator is not initialized.");
  return value;
};
const apiFor = (site: AccessibleResource, getToken: () => Promise<string>): JiraApi => new JiraApi({ cloudId: site.id, webBase: site.url, getToken });

@validateRpc()
export class JiraConfiguratorUI extends RpcTarget implements JiraConfiguratorRpc {
  constructor(getSites: () => Promise<AccessibleResource[]>, getToken: () => Promise<string>) {
    super();
    contexts.set(this, { getSites, getToken });
  }

  async listSites(query: string): Promise<ConfiguratorOption[]> {
    const q = query.trim().toLowerCase();
    return (await ctx(this).getSites()).filter(site => !q || site.name.toLowerCase().includes(q) || site.url.toLowerCase().includes(q)).slice(0, OPTION_LIMIT).map(site => ({ value: site.url, title: site.name, subtitle: site.url }));
  }

  async listProjects(query: string): Promise<ConfiguratorOption[]> {
    const { getSites, getToken } = ctx(this);
    const q = query.trim().toLowerCase();
    const perSite = await Promise.all((await getSites()).map(async site => {
      const page = await apiFor(site, getToken).listProjects(0, OPTION_LIMIT);
      return (page.values ?? []).filter(project => !q || project.name.toLowerCase().includes(q) || project.key.toLowerCase().includes(q)).map(project => ({ value: `${site.url}/projects/${project.key}`, title: project.name, subtitle: `${project.key} · ${site.name}` }));
    }));
    return perSite.flat().slice(0, OPTION_LIMIT);
  }

  async listIssues(query: string): Promise<ConfiguratorOption[]> {
    const { getSites, getToken } = ctx(this);
    const q = query.trim();
    const perSite = await Promise.all((await getSites()).map(async site => {
      const api = apiFor(site, getToken);
      const jql = /^[A-Z][A-Z0-9_]{1,31}-\d+$/i.test(q) ? `key = ${jqlLiteral(parseIssueKeyOrId(q))}` : (q ? `text ~ ${jqlLiteral(q)} ORDER BY updated DESC` : "ORDER BY updated DESC");
      const page = await api.searchIssues(jql, 0, 20);
      return page.issues.map(issue => ({ value: `${site.url}/browse/${issue.key}`, title: `${issue.key}: ${issue.fields.summary ?? "Untitled"}`, subtitle: site.name }));
    }));
    return perSite.flat().slice(0, OPTION_LIMIT);
  }
}
