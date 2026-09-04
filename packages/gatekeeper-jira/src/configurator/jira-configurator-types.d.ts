export type ConfiguratorOption = { value: string; title: string; subtitle?: string };
export type JiraConfiguratorValues = { siteUrl?: string; projectUrl?: string; issueUrl?: string };
export interface JiraConfiguratorRpc {
  listSites(query: string): Promise<ConfiguratorOption[]>;
  listProjects(query: string): Promise<ConfiguratorOption[]>;
  listIssues(query: string): Promise<ConfiguratorOption[]>;
}
