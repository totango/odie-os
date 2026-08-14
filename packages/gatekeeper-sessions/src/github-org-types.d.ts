/** Read-only access to repositories installed for the Totango organization GitHub App. */
export interface GitHubOrganizationSession {
  /** Searches installed Totango repositories by name and description. Returns at most 50 results. */
  searchRepositories(query: string, limit?: number): Promise<GitHubOrganizationRepositorySummary[]>;

  /** Opens one installed Totango repository by its name without the organization prefix. */
  openRepository(name: string): Promise<GitHubSourceRepository>;
}

/** Read-only access to the current source of one installed Totango repository. */
export interface GitHubSourceRepository {
  /** Returns repository metadata, including its default branch and current default-branch revision. */
  getMetadata(): Promise<GitHubSourceRepositoryMetadata>;

  /** Lists the immediate entries at a repository path and optional branch, tag, or commit ref. */
  listTree(options?: GitHubTreeOptions): Promise<GitHubTreeResult>;

  /** Searches actual default-branch source and returns matching paths and bounded text fragments. */
  searchCode(query: string, limit?: number): Promise<GitHubCodeSearchResult[]>;

  /** Reads one UTF-8 source file, capped at 256 KiB, at an optional branch, tag, or commit ref. */
  readFile(path: string, ref?: string): Promise<GitHubSourceFile>;
}

/** Summary of an installed Totango repository. */
export type GitHubOrganizationRepositorySummary = {
  name: string;
  fullName: string;
  description?: string;
  url: string;
  defaultBranch: string;
  archived: boolean;
  updatedAt: string;
};

/** Metadata for an installed Totango repository and its current default branch. */
export type GitHubSourceRepositoryMetadata = GitHubOrganizationRepositorySummary & {
  visibility: "public" | "private" | "internal";
  defaultBranchRevision: string;
};

/** Options for listing a repository tree. Omit `path` to list the repository root. */
export type GitHubTreeOptions = {
  ref?: string;
  path?: string;
};

/** One file, directory, symlink, or submodule in a repository tree. */
export type GitHubTreeEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "submodule";
  sha: string;
  size?: number;
  url?: string;
};

/** Bounded immediate entries at one repository path. */
export type GitHubTreeResult = {
  repository: string;
  ref: string;
  path: string;
  entries: GitHubTreeEntry[];
  truncated: boolean;
};

/** One source-code search hit. Call `readFile()` for complete current contents. */
export type GitHubCodeSearchResult = {
  repository: string;
  path: string;
  sha: string;
  url: string;
  fragments: string[];
};

/** One current UTF-8 source file read from GitHub. */
export type GitHubSourceFile = {
  repository: string;
  path: string;
  ref: string;
  sha: string;
  url: string;
  content: string;
};
