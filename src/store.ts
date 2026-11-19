// Shared in-memory state for the forge: users, repositories, git objects, issues,
// pull requests, labels and comments — plus the GitHub JSON views every surface
// (REST v3, GraphQL v4, MCP) renders from the same objects.
//
// The entry starts empty: every check creates what it needs through the API, so
// nothing here is pre-seeded except the twelve seeded scenario users (wire.ts
// buildScenario: viewer adaiversen id 1000, teammate quinnkeller, stranger
// olgabauer, org faint-meadow-org). A repository belongs to the login the bearer
// token names; the same name under another login is a 404, never a 403.
//
// Erasable TypeScript only (node --experimental-strip-types): no enums, no
// namespaces, no parameter properties. Node builtins only.

import { createHash, randomBytes } from 'node:crypto';

/** The login the bearer token names in every trial (wire.ts Scenario.viewer). */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's id (wire.ts: users are 1000+i in scenario order). */
export const VIEWER_ID = 1000;
/** The scenario org's login (wire.ts buildScenario().org). */
export const ORG_LOGIN = 'faint-meadow-org';

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The twelve seeded scenario users, in wire.ts order (ids 1000..1011). */
export const USERS: readonly User[] = Object.freeze([
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
]);

export const USER_BY_LOGIN: ReadonlyMap<string, User> = new Map(USERS.map((u) => [u.login, u]));

/** The viewer: the user the token names. */
export const VIEWER: User = USERS[0] as User;

/** The six default labels a GitHub repository is born with (name, color). */
export const DEFAULT_LABELS: readonly (readonly [string, string])[] = Object.freeze([
  ['bug', 'd73a4a'],
  ['enhancement', 'a2eeef'],
  ['documentation', '0075ca'],
  ['question', 'd876e3'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
]);

// ---------------------------------------------------------------- git objects

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  /** Raw object payload (without the "<type> <len>\0" header). */
  readonly data: Buffer;
}

/** The SHA-1 of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** A blob object for `content` (string or bytes). */
export function makeBlob(content: string | Buffer): { sha: string; object: GitObject } {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return { sha: hashObject('blob', data), object: { type: 'blob', data } };
}

export interface TreeEntry {
  /** '100644' for a blob, '40000' for a tree. */
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/**
 * A tree object for `entries`. Git sorts entries by name, directories as if
 * their name had a trailing '/'. Returns the sha and the object.
 */
export function makeTree(entries: readonly TreeEntry[]): { sha: string; object: GitObject } {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  const data = Buffer.concat(parts);
  return { sha: hashObject('tree', data), object: { type: 'tree', data } };
}

export interface CommitOpts {
  readonly tree: string;
  readonly parents: readonly string[];
  /** Author/committer identity: {name, email}. */
  readonly author: { name: string; email: string };
  /** Unix seconds; defaults to now. */
  readonly epochSec?: number;
  readonly message: string;
}

/** A commit object. Author and committer are the same identity. */
export function makeCommit(opts: CommitOpts): { sha: string; object: GitObject } {
  const epoch = opts.epochSec ?? Math.floor(Date.now() / 1000);
  const ident = `${opts.author.name} <${opts.author.email}> ${epoch} +0000`;
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', opts.message);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  return { sha: hashObject('commit', data), object: { type: 'commit', data } };
}

/** Parse a commit object's payload into its fields (best effort). */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; authorLine: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
  }
  return { tree, parents, message, authorLine };
}

/** Parse a tree object's payload into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const mode = data.subarray(i, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- issues / pulls

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  readonly id: number;
  body: string;
  readonly user: User;
  readonly created_at: string;
  updated_at: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly user: User;
  labels: Label[];
  assignees: User[];
  comments: IssueComment[];
  readonly created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly user: User;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly created_at: string;
  updated_at: string;
  closed_at: string | null;
  files: PullFile[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  mergeable: boolean;
}

export interface Repo {
  readonly id: number;
  readonly owner: User;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  readonly created_at: string;
  updated_at: string;
  pushed_at: string;
  /** sha -> object (raw payloads). */
  readonly objects: Map<string, GitObject>;
  /** Full ref name ('refs/heads/main') -> commit sha. */
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  nextIssue: number;
  readonly pulls: Map<number, Pull>;
  nextPull: number;
  /** label name -> Label. */
  readonly labels: Map<string, Label>;
  nextLabelId: number;
  nextCommentId: number;
  nextIssueId: number;
  nextPullId: number;
}

/** ISO-8601 now (the entry's clock; no check reads a clock for data). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** A non-empty request id for the X-GitHub-Request-Id header (every reply). */
export function newRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

/** The bearer token the env presents (MAKEFUN_SHOP_TOKEN in a trial). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * Whether the request carries the token: `Authorization: Bearer <token>`.
 * Missing or wrong is refused (part of the protocol checks). /healthz is exempt
 * (app.ts never calls this for it).
 */
export function authOk(req: { headers: { authorization?: string | undefined } }): boolean {
  const token = expectedToken();
  if (token === '') return false;
  return req.headers.authorization === `Bearer ${token}`;
}

/** The store: every repository, keyed `owner/name`. Starts empty. */
export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  /** Repositories owned by `login`, in creation order. */
  listReposForUser(login: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.login === login) out.push(repo);
    return out;
  }

  createRepo(ownerLogin: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo {
    const owner = USER_BY_LOGIN.get(ownerLogin) ?? VIEWER;
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      full_name: `${owner.login}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.defaultBranch ?? 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      labels: new Map(),
      nextLabelId: 1,
      nextCommentId: 1,
      nextIssueId: 1,
      nextPullId: 1,
    };
    this.nextRepoId += 1;
    for (const [labelName, color] of DEFAULT_LABELS) {
      repo.labels.set(labelName, { id: repo.nextLabelId, name: labelName, color, description: '' });
      repo.nextLabelId += 1;
    }
    this.repos.set(repo.full_name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Store a git object (idempotent). */
  putObject(repo: Repo, sha: string, object: GitObject): void {
    if (!repo.objects.has(sha)) repo.objects.set(sha, object);
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  /** Resolve a ref name ('refs/heads/main', 'main', 'HEAD') to a sha, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.default_branch}`);
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const short = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    return short;
  }

  /** Open issues + open pulls, as GitHub's open_issues_count counts both. */
  openIssuesCount(repo: Repo): number {
    let count = 0;
    for (const issue of repo.issues.values()) if (issue.state === 'open') count += 1;
    for (const pull of repo.pulls.values()) if (pull.state === 'open') count += 1;
    return count;
  }
}

// ---------------------------------------------------------------- JSON views

/** `http://host:port` for a request (the entry's own origin, from Host). */
export function originOf(hostHeader: string | undefined): string {
  const host = hostHeader ?? '127.0.0.1';
  return `http://${host}`;
}

export function userView(user: User, origin: string): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `MDQ6VXNlcj${user.id}`,
    avatar_url: `${origin}/avatars/${user.login}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${user.login}`,
    html_url: `${origin}/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoView(repo: Repo, origin: string, store: Store): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.full_name}`;
  return {
    id: repo.id,
    node_id: `MDEwOlJlcG9zaXRvcnk${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    owner: userView(repo.owner, origin),
    private: repo.private,
    html_url: `${origin}/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: base,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${repo.full_name}.git`,
    ssh_url: `git@${origin.replace(/^https?:\/\//, '')}:${repo.full_name}.git`,
    clone_url: `${origin}/${repo.full_name}.git`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: store.openIssuesCount(repo),
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: store.openIssuesCount(repo),
    watchers: 0,
    default_branch: repo.default_branch,
  };
}

export function labelView(label: Label, repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `MDU6TGFiZWw${label.id}`,
    url: `${origin}/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: DEFAULT_LABELS.some(([n]) => n === label.name),
    description: label.description,
  };
}

export function commentView(comment: IssueComment, repo: Repo, issueNumber: number, origin: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `MDEyOklzc3VlQ29tbWVud${comment.id}`,
    url: `${origin}/api/v3/repos/${repo.full_name}/issues/comments/${comment.id}`,
    html_url: `${origin}/${repo.full_name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userView(comment.user, origin),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

export function issueView(issue: Issue, repo: Repo, origin: string): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.full_name}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: `MDU6SXNzdWU${issue.id}`,
    url: base,
    repository_url: `${origin}/api/v3/repos/${repo.full_name}`,
    labels_url: `${base}/labels{/name}`,
    comments_url: `${base}/comments`,
    events_url: `${base}/events`,
    html_url: `${origin}/${repo.full_name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userView(issue.user, origin),
    labels: issue.labels.map((label) => labelView(label, repo, origin)),
    assignees: issue.assignees.map((u) => userView(u, origin)),
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
  };
}

export function pullView(pull: Pull, repo: Repo, origin: string, store: Store): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.full_name}/pulls/${pull.number}`;
  return {
    id: pull.id,
    node_id: `MDExOlB1bGxSZXF1ZXN0${pull.id}`,
    url: base,
    html_url: `${origin}/${repo.full_name}/pull/${pull.number}`,
    diff_url: `${base}.diff`,
    patch_url: `${base}.patch`,
    issue_url: `${origin}/api/v3/repos/${repo.full_name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userView(pull.user, origin),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? userView(pull.user, origin) : null,
    commits: pull.commits,
    additions: pull.additions,
    deletions: pull.deletions,
    changed_files: pull.changedFiles,
    head: { label: `${repo.owner.login}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userView(repo.owner, origin), repo: repoView(repo, origin, store) },
    base: { label: `${repo.owner.login}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userView(repo.owner, origin), repo: repoView(repo, origin, store) },
    author_association: 'OWNER',
  };
}
