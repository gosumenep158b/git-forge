// GraphQL v4 surface (POST /api/graphql) for the forge.
//
// A small hand-written executor for exactly the documents the conformance
// suite sends (gh / github-mcp-server shapes): viewer, repository, node,
// __type introspection, issue / pull-request connections with cursor
// pagination, and the createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment mutations. No GraphQL library, no runtime
// dependencies, erasable TypeScript only (node --experimental-strip-types).
//
// Global ids are base64("<Type>:<owner>/<repo>:<number>") (or
// base64("User:<login>") / base64("IssueComment:<owner>/<repo>:<issue>:<id>")):
// opaque, stable across reads, and round-trippable through node(id:) and
// through the mutation inputs (repositoryId / issueId / pullRequestId /
// subjectId). Cursors are base64("cursor:<offset>") into the filtered,
// ordered connection list.
//
// Mutations write the same Store objects the REST surface renders, so a
// GraphQL-created issue / pull / comment / merge is visible over REST and
// vice versa.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ORG_LOGIN,
  USER_BY_LOGIN,
  VIEWER,
  authOk,
  makeCommit,
  makeTree,
  newRequestId,
  nowIso,
  originOf,
  parseCommit,
  parseTree,
  type Issue,
  type IssueComment,
  type Label,
  type Pull,
  type PullFile,
  type Repo,
  type Store,
  type User,
} from './store.ts';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): string | null {
  if (typeof text !== 'string' || text === '') return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return null;
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    // Round-trip check: reject strings that are not canonical base64 of the payload.
    if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': newRequestId(), 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

function repoId(repo: Repo): string {
  return b64encode(`Repository:${repo.full_name}`);
}

function issueId(repo: Repo, issue: Issue): string {
  return b64encode(`Issue:${repo.full_name}:${issue.number}`);
}

function pullId(repo: Repo, pull: Pull): string {
  return b64encode(`PullRequest:${repo.full_name}:${pull.number}`);
}

function userId(user: User): string {
  return b64encode(`User:${user.login}`);
}

function commentId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return b64encode(`IssueComment:${repo.full_name}:${issue.number}:${comment.id}`);
}

function labelId(repo: Repo, label: Label): string {
  return b64encode(`Label:${repo.full_name}:${label.name}`);
}

/** Decode a global id into its payload, or null when it is not one of ours. */
function decodeGlobalId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  return b64decode(id);
}

function findRepoByGlobalId(store: Store, id: unknown): Repo | null {
  const payload = decodeGlobalId(id);
  if (payload === null || !payload.startsWith('Repository:')) return null;
  return store.getRepo(...splitOwnerName(payload.slice('Repository:'.length))) ?? null;
}

function splitOwnerName(full: string): [string, string] {
  const slash = full.indexOf('/');
  if (slash < 0) return [full, ''];
  return [full.slice(0, slash), full.slice(slash + 1)];
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const payload = decodeGlobalId(id);
  if (payload === null || !payload.startsWith('Issue:')) return null;
  const rest = payload.slice('Issue:'.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon < 0) return null;
  const [owner, name] = splitOwnerName(rest.slice(0, lastColon));
  const number = Number(rest.slice(lastColon + 1));
  if (!Number.isInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  return { repo, issue };
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  const payload = decodeGlobalId(id);
  if (payload === null || !payload.startsWith('PullRequest:')) return null;
  const rest = payload.slice('PullRequest:'.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon < 0) return null;
  const [owner, name] = splitOwnerName(rest.slice(0, lastColon));
  const number = Number(rest.slice(lastColon + 1));
  if (!Number.isInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return null;
  return { repo, pull };
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

function encodeCursor(offset: number): string {
  return b64encode(`cursor:${offset}`);
}

function decodeCursor(cursor: unknown): number {
  if (cursor === null || cursor === undefined) return -1;
  if (typeof cursor !== 'string') throw new Error(`Invalid cursor: ${JSON.stringify(cursor)}`);
  const decoded = b64decode(cursor);
  const match = decoded === null ? null : /^cursor:(\d+)$/.exec(decoded);
  if (match === null) throw new Error(`Invalid cursor: ${JSON.stringify(cursor)}`);
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Git helpers: tree flattening, line diffs, pull stats (also used by the
// throwaway test harness in /tmp, hence exported).
// ---------------------------------------------------------------------------

/** Flatten a tree object (recursively) into path -> blob sha. */
export function flattenTree(store: Store, repo: Repo, treeSha: string, prefix: string, out: Map<string, string>, depth = 0): void {
  if (depth > 32 || treeSha === '') return;
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, repo, entry.sha, path, out, depth + 1);
    else out.set(path, entry.sha);
  }
}

function blobLines(repo: Repo, sha: string): string[] {
  const object = repo.objects.get(sha);
  if (object === undefined) return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-diff counts via LCS; falls back to naive counts for very large files. */
function diffLineCounts(oldLines: string[], newLines: string[]): { additions: number; deletions: number } {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 250_000) return { additions: m, deletions: n };
  // LCS length with two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

function commitAncestors(repo: Repo, startSha: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = startSha === '' ? [] : [startSha];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(sha);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

export interface PullStats {
  files: PullFile[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
}

/** The changed files and commit count of head vs base (three-dot-ish: head-only commits). */
export function pullStats(store: Store, repo: Repo, headSha: string, baseSha: string): PullStats {
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  if (baseSha !== '') flattenTree(store, repo, treeOf(repo, baseSha), '', baseFiles);
  if (headSha !== '') flattenTree(store, repo, treeOf(repo, headSha), '', headFiles);
  const files: PullFile[] = [];
  let additions = 0;
  let deletions = 0;
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base === head) continue;
    if (base === undefined && head !== undefined) {
      const lines = blobLines(repo, head);
      files.push({ filename: path, status: 'added', additions: lines.length, deletions: 0, changes: lines.length, sha: head });
      additions += lines.length;
    } else if (head === undefined && base !== undefined) {
      const lines = blobLines(repo, base);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: lines.length, changes: lines.length, sha: base });
      deletions += lines.length;
    } else if (base !== undefined && head !== undefined) {
      const counts = diffLineCounts(blobLines(repo, base), blobLines(repo, head));
      files.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions, sha: head });
      additions += counts.additions;
      deletions += counts.deletions;
    }
  }
  let commits = 0;
  if (headSha !== '' && headSha !== baseSha) {
    const headAncestors = commitAncestors(repo, headSha);
    const baseAncestors = baseSha === '' ? new Set<string>() : commitAncestors(repo, baseSha);
    for (const sha of headAncestors) if (!baseAncestors.has(sha)) commits += 1;
    if (commits === 0 && headAncestors.size > 0) commits = 1;
  }
  return { files, additions, deletions, changedFiles: files.length, commits };
}

function treeOf(repo: Repo, commitSha: string): string {
  const object = repo.objects.get(commitSha);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------------------
// Typed values: every resolver returns one of these (or a scalar / null).
// ---------------------------------------------------------------------------

type TypedValue = Record<string, unknown> & { __typename: string };

function repoVal(repo: Repo): TypedValue {
  return { __typename: 'Repository', repo };
}

function issueVal(repo: Repo, issue: Issue): TypedValue {
  return { __typename: 'Issue', repo, issue };
}

function pullVal(repo: Repo, pull: Pull): TypedValue {
  return { __typename: 'PullRequest', repo, pull };
}

function userVal(user: User): TypedValue {
  return { __typename: 'User', user };
}

function orgVal(login: string): TypedValue {
  const user = USER_BY_LOGIN.get(login);
  return { __typename: 'Organization', login, user: user ?? { id: 0, login, name: login, email: '' } };
}

function commentVal(repo: Repo, issue: Issue, comment: IssueComment): TypedValue {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function labelVal(repo: Repo, label: Label): TypedValue {
  return { __typename: 'Label', repo, label };
}

function refVal(repo: Repo, name: string): TypedValue {
  return { __typename: 'Ref', repo, name };
}

interface PageInfoData {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function makeConnection(typeName: string, allItems: TypedValue[], first: unknown, after: unknown): TypedValue {
  const startOffset = decodeCursor(after) + 1;
  const limit = typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : allItems.length;
  const items = allItems.slice(startOffset, startOffset + limit);
  const endOffset = items.length === 0 ? startOffset - 1 : startOffset + items.length - 1;
  const pageInfo: PageInfoData = {
    hasNextPage: items.length > 0 && endOffset < allItems.length - 1,
    hasPreviousPage: startOffset > 0,
    startCursor: items.length === 0 ? null : encodeCursor(startOffset),
    endCursor: items.length === 0 ? null : encodeCursor(endOffset),
  };
  return { __typename: typeName, __items: items, __startOffset: startOffset, __totalCount: allItems.length, __pageInfo: pageInfo };
}

// ---------------------------------------------------------------------------
// Schema: field sets (validation + introspection) and argument sets.
// ---------------------------------------------------------------------------

const FIELD_SETS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'organization', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'pushedAt', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'forkCount', 'stargazerCount', 'stargazers', 'watchers', 'labels', 'issues', 'issue', 'pullRequests', 'pullRequest'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'repositories'],
  Organization: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'repositories'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'assignees', 'locked'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'merged', 'mergedAt', 'mergeCommit', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergeable', 'mergeableState', 'mergeStateStatus'],
  Label: ['id', 'databaseId', 'name', 'color', 'description', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'prefix'],
  Commit: ['oid', 'abbreviatedOid', 'message', 'messageHeadline', 'author', 'committedDate'],
  GitActor: ['name', 'email', 'date'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  LabelConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueCommentConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  RepositoryConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  UserConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestCommitConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  SearchResultItemConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  RepositoryEdge: ['node', 'cursor'],
  UserEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestCommitEdge: ['node', 'cursor'],
  SearchResultItemEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestCommit: ['id', 'commit'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'possibleTypes', 'interfaces'],
  __Field: ['name', 'description', 'type', 'args'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
};

const ARG_SETS: Record<string, Record<string, readonly string[]>> = {
  Query: {
    repository: ['owner', 'name'],
    node: ['id'],
    user: ['login'],
    organization: ['login'],
    search: ['query', 'type', 'first', 'after', 'last', 'before'],
    __type: ['name'],
    __schema: [],
    viewer: [],
  },
  Mutation: {
    createIssue: ['input'],
    closeIssue: ['input'],
    createPullRequest: ['input'],
    mergePullRequest: ['input'],
    addComment: ['input'],
  },
  Repository: {
    issue: ['number'],
    issues: ['first', 'after', 'last', 'before', 'states', 'orderBy', 'labels', 'filterBy'],
    pullRequest: ['number'],
    pullRequests: ['first', 'after', 'last', 'before', 'states', 'orderBy'],
    labels: ['first', 'after'],
    stargazers: ['first', 'after'],
    watchers: ['first', 'after'],
  },
  User: { repositories: ['first', 'after'] },
  Organization: { repositories: ['first', 'after'] },
  Issue: {
    labels: ['first', 'after'],
    comments: ['first', 'after'],
    assignees: ['first', 'after'],
  },
  PullRequest: {
    files: ['first', 'after'],
    commits: ['first', 'after'],
  },
  __Type: {
    fields: ['includeDeprecated'],
    enumValues: ['includeDeprecated'],
    inputFields: ['includeDeprecated'],
  },
};

const REQUIRED_ARGS: Record<string, Record<string, readonly string[]>> = {
  Query: { repository: ['owner', 'name'], node: ['id'], __type: ['name'] },
  Repository: { issue: ['number'], pullRequest: ['number'] },
  Mutation: { createIssue: ['input'], closeIssue: ['input'], createPullRequest: ['input'], mergePullRequest: ['input'], addComment: ['input'] },
};

interface TypeInfo {
  kind: string;
  fields?: readonly string[];
  enumValues?: readonly string[];
  inputFields?: readonly string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: FIELD_SETS.Query },
  Mutation: { kind: 'OBJECT', fields: FIELD_SETS.Mutation },
  Repository: { kind: 'OBJECT', fields: FIELD_SETS.Repository },
  User: { kind: 'OBJECT', fields: FIELD_SETS.User },
  Organization: { kind: 'OBJECT', fields: FIELD_SETS.Organization },
  Issue: { kind: 'OBJECT', fields: FIELD_SETS.Issue },
  PullRequest: { kind: 'OBJECT', fields: FIELD_SETS.PullRequest },
  Label: { kind: 'OBJECT', fields: FIELD_SETS.Label },
  IssueComment: { kind: 'OBJECT', fields: FIELD_SETS.IssueComment },
  Ref: { kind: 'OBJECT', fields: FIELD_SETS.Ref },
  Commit: { kind: 'OBJECT', fields: FIELD_SETS.Commit },
  PageInfo: { kind: 'OBJECT', fields: FIELD_SETS.PageInfo },
  IssueConnection: { kind: 'OBJECT', fields: FIELD_SETS.IssueConnection },
  PullRequestConnection: { kind: 'OBJECT', fields: FIELD_SETS.PullRequestConnection },
  PullRequestChangedFile: { kind: 'OBJECT', fields: FIELD_SETS.PullRequestChangedFile },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: ['repositoryId', 'title', 'body', 'labelIds', 'assigneeIds', 'clientMutationId'] },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: ['issueId', 'clientMutationId'] },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'] },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: ['pullRequestId', 'mergeMethod', 'clientMutationId'] },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: ['subjectId', 'body', 'clientMutationId'] },
};

// ---------------------------------------------------------------------------
// Lexer / parser for the documents the suite sends
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Token['kind'], value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('Syntax Error: Unterminated string.');
      push('string', out);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      push(isFloat ? 'float' : 'int', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      push('name', src.slice(i, j));
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      push('punct', '...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(ch) || ch === '{' || ch === '}') {
      push('punct', ch);
      i += 1;
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character "${ch}".`);
  }
  push('eof', '');
  return tokens;
}

interface TypeNode {
  kind: 'named' | 'list' | 'nonNull';
  name?: string;
  ofType?: TypeNode;
}

interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: string;
  items?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
}

interface DirectiveNode {
  name: string;
  args: { name: string; value: ValueNode }[];
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: ValueNode }[];
  directives: DirectiveNode[];
  selections: SelectionNode[] | null;
}

interface SpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | SpreadNode | InlineNode;

interface VarDef {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`Syntax Error: Expected "${value}", found ${JSON.stringify(tok.value)}.`);
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name' || (value !== undefined && tok.value !== value)) {
      throw new Error(`Syntax Error: Expected ${value === undefined ? 'a name' : JSON.stringify(value)}, found ${JSON.stringify(tok.value)}.`);
    }
    return tok.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        const frag = this.parseFragment();
        fragments.set(frag.name, frag);
      } else {
        throw new Error(`Syntax Error: Unexpected ${JSON.stringify(tok.value)}.`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const kind = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const varDefs: VarDef[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        varDefs.push({ name: varName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    // Directives on the operation itself (rare): skip them.
    while (this.peek().kind === 'punct' && this.peek().value === '@') this.parseDirective();
    return { kind, name, varDefs, selections: this.parseSelectionSet() };
  }

  private parseFragment(): FragmentDef {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    while (this.peek().kind === 'punct' && this.peek().value === '@') this.parseDirective();
    return { name, typeCondition, selections: this.parseSelectionSet() };
  }

  private parseType(): TypeNode {
    const tok = this.peek();
    let type: TypeNode;
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type = { kind: 'nonNull', ofType: type };
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Syntax Error: Unterminated selection set.');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    const directives = this.parseDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, directives, selections };
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') directives.push(this.parseDirective());
    return directives;
  }

  private parseDirective(): DirectiveNode {
    this.expectPunct('@');
    const name = this.expectName();
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return { name, args };
  }

  private parseValue(): ValueNode {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.kind === 'string') {
      this.next();
      return { kind: 'string', value: tok.value };
    }
    if (tok.kind === 'int') {
      this.next();
      return { kind: 'int', value: tok.value };
    }
    if (tok.kind === 'float') {
      this.next();
      return { kind: 'float', value: tok.value };
    }
    if (tok.kind === 'name') {
      this.next();
      if (tok.value === 'true' || tok.value === 'false') return { kind: 'boolean', value: tok.value };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Syntax Error: Unexpected value ${JSON.stringify(tok.value)}.`);
  }
}

// ---------------------------------------------------------------------------
// Value evaluation + variable coercion
// ---------------------------------------------------------------------------

interface GqlErrorEntry {
  message: string;
  path?: (string | number)[];
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name as string];
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
      return Number(node.value);
    case 'float':
      return Number(node.value);
    case 'boolean':
      return node.value === 'true';
    case 'null':
      return null;
    case 'list':
      return (node.items ?? []).map((item) => evalValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = evalValue(field.value, vars);
      return out;
    }
    default:
      return undefined;
  }
}

function typeToString(type: TypeNode): string {
  if (type.kind === 'named') return type.name as string;
  if (type.kind === 'list') return `[${typeToString(type.ofType as TypeNode)}]`;
  return `${typeToString(type.ofType as TypeNode)}!`;
}

function checkVarValue(value: unknown, type: TypeNode, varName: string, errors: string[]): void {
  if (type.kind === 'nonNull') {
    if (value === null || value === undefined) {
      errors.push(`Variable $${varName} of required type ${typeToString(type)} was not provided.`);
      return;
    }
    checkVarValue(value, type.ofType as TypeNode, varName, errors);
    return;
  }
  if (value === null || value === undefined) return;
  if (type.kind === 'list') {
    if (!Array.isArray(value)) {
      errors.push(`Variable $${varName} expected a list but got ${JSON.stringify(value)}.`);
      return;
    }
    for (const item of value) checkVarValue(item, type.ofType as TypeNode, varName, errors);
    return;
  }
  const name = type.name as string;
  if (name === 'Int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`Variable $${varName} expected type Int but got ${JSON.stringify(value)}.`);
  } else if (name === 'Float') {
    if (typeof value !== 'number') errors.push(`Variable $${varName} expected type Float but got ${JSON.stringify(value)}.`);
  } else if (name === 'String' || name === 'ID') {
    if (typeof value !== 'string' && typeof value !== 'number') errors.push(`Variable $${varName} expected type ${name} but got ${JSON.stringify(value)}.`);
  } else if (name === 'Boolean') {
    if (typeof value !== 'boolean') errors.push(`Variable $${varName} expected type Boolean but got ${JSON.stringify(value)}.`);
  }
  // Input object / enum types: accept any record / string; deeper checks happen at use.
}

// ---------------------------------------------------------------------------
// Validation (unknown fields / arguments, missing required arguments)
// ---------------------------------------------------------------------------

function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  fragments: Map<string, FragmentDef>,
  errors: string[],
  depth = 0,
): void {
  if (depth > 50) return;
  const fields = FIELD_SETS[parentType];
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (sel.name === '__typename') continue;
      if (fields === undefined || !fields.includes(sel.name)) {
        errors.push(`Cannot query field "${sel.name}" on type "${parentType}".`);
        continue;
      }
      const argSet = ARG_SETS[parentType]?.[sel.name];
      if (argSet !== undefined) {
        for (const arg of sel.args) {
          if (!argSet.includes(arg.name)) errors.push(`Unknown argument "${arg.name}" on field "${parentType}.${sel.name}".`);
        }
      }
      const required = REQUIRED_ARGS[parentType]?.[sel.name] ?? [];
      for (const req of required) {
        if (!sel.args.some((arg) => arg.name === req)) errors.push(`Field "${parentType}.${sel.name}" argument "${req}" of type "String!" is required, but it was not provided.`);
      }
      if (sel.selections !== null) {
        const childType = childTypeOf(parentType, sel.name);
        if (childType !== null) validateSelections(sel.selections, childType, fragments, errors, depth + 1);
      }
    } else if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (frag === undefined) errors.push(`Unknown fragment "${sel.name}".`);
      else validateSelections(frag.selections, frag.typeCondition, fragments, errors, depth + 1);
    } else {
      const nextType = sel.typeCondition ?? parentType;
      validateSelections(sel.selections, nextType, fragments, errors, depth + 1);
    }
  }
}

/** The object type a field's sub-selection is validated / executed against. */
function childTypeOf(parentType: string, field: string): string | null {
  switch (parentType) {
    case 'Query':
      if (field === 'viewer') return 'User';
      if (field === 'repository') return 'Repository';
      if (field === 'node') return null; // polymorphic: validated loosely below
      if (field === 'user') return 'User';
      if (field === 'organization') return 'Organization';
      if (field === 'search') return 'SearchResultItemConnection';
      if (field === '__type') return '__Type';
      if (field === '__schema') return '__Schema';
      return null;
    case 'Mutation':
      if (field === 'createIssue') return 'CreateIssuePayload';
      if (field === 'closeIssue') return 'CloseIssuePayload';
      if (field === 'createPullRequest') return 'CreatePullRequestPayload';
      if (field === 'mergePullRequest') return 'MergePullRequestPayload';
      if (field === 'addComment') return 'AddCommentPayload';
      return null;
    case 'Repository':
      if (field === 'owner') return 'User';
      if (field === 'defaultBranchRef') return 'Ref';
      if (field === 'issues') return 'IssueConnection';
      if (field === 'issue') return 'Issue';
      if (field === 'pullRequests') return 'PullRequestConnection';
      if (field === 'pullRequest') return 'PullRequest';
      if (field === 'labels') return 'LabelConnection';
      if (field === 'stargazers' || field === 'watchers') return 'UserConnection';
      return null;
    case 'User':
    case 'Organization':
      if (field === 'repositories') return 'RepositoryConnection';
      return null;
    case 'Issue':
      if (field === 'author') return 'User';
      if (field === 'labels') return 'LabelConnection';
      if (field === 'comments') return 'IssueCommentConnection';
      if (field === 'repository') return 'Repository';
      if (field === 'assignees') return 'UserConnection';
      return null;
    case 'PullRequest':
      if (field === 'author') return 'User';
      if (field === 'files') return 'PullRequestChangedFileConnection';
      if (field === 'commits') return 'PullRequestCommitConnection';
      if (field === 'mergeCommit') return 'Commit';
      return null;
    case 'IssueComment':
      if (field === 'author') return 'User';
      return null;
    case 'Commit':
      if (field === 'author') return 'GitActor';
      return null;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
    case 'RepositoryConnection':
    case 'UserConnection':
    case 'PullRequestChangedFileConnection':
    case 'PullRequestCommitConnection':
    case 'SearchResultItemConnection':
      if (field === 'nodes') return elementTypeOf(parentType);
      if (field === 'edges') return edgeTypeOf(parentType);
      if (field === 'pageInfo') return 'PageInfo';
      return null;
    case 'IssueEdge':
      return field === 'node' ? 'Issue' : null;
    case 'PullRequestEdge':
      return field === 'node' ? 'PullRequest' : null;
    case 'LabelEdge':
      return field === 'node' ? 'Label' : null;
    case 'IssueCommentEdge':
      return field === 'node' ? 'IssueComment' : null;
    case 'RepositoryEdge':
      return field === 'node' ? 'Repository' : null;
    case 'UserEdge':
      return field === 'node' ? 'User' : null;
    case 'PullRequestChangedFileEdge':
      return field === 'node' ? 'PullRequestChangedFile' : null;
    case 'PullRequestCommitEdge':
      return field === 'node' ? 'PullRequestCommit' : null;
    case 'SearchResultItemEdge':
      return null;
    case 'PullRequestCommit':
      if (field === 'commit') return 'Commit';
      return null;
    case '__Type':
      if (field === 'fields') return '__Field';
      if (field === 'enumValues') return '__EnumValue';
      if (field === 'inputFields') return '__InputValue';
      return null;
    case '__Field':
      if (field === 'type') return '__Type';
      if (field === 'args') return '__InputValue';
      return null;
    case '__Schema':
      if (field === 'queryType' || field === 'mutationType' || field === 'subscriptionType') return '__Type';
      if (field === 'types') return '__Type';
      return null;
    case 'CreateIssuePayload':
      if (field === 'issue') return 'Issue';
      return null;
    case 'CloseIssuePayload':
      if (field === 'issue') return 'Issue';
      return null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return 'PullRequest';
      return null;
    case 'AddCommentPayload':
      if (field === 'commentEdge') return 'IssueCommentEdge';
      if (field === 'subject') return null;
      return null;
    default:
      return null;
  }
}

function elementTypeOf(connection: string): string | null {
  const map: Record<string, string> = {
    IssueConnection: 'Issue',
    PullRequestConnection: 'PullRequest',
    LabelConnection: 'Label',
    IssueCommentConnection: 'IssueComment',
    RepositoryConnection: 'Repository',
    UserConnection: 'User',
    PullRequestChangedFileConnection: 'PullRequestChangedFile',
    PullRequestCommitConnection: 'PullRequestCommit',
    SearchResultItemConnection: 'Issue',
  };
  return map[connection] ?? null;
}

function edgeTypeOf(connection: string): string | null {
  const map: Record<string, string> = {
    IssueConnection: 'IssueEdge',
    PullRequestConnection: 'PullRequestEdge',
    LabelConnection: 'LabelEdge',
    IssueCommentConnection: 'IssueCommentEdge',
    RepositoryConnection: 'RepositoryEdge',
    UserConnection: 'UserEdge',
    PullRequestChangedFileConnection: 'PullRequestChangedFileEdge',
    PullRequestCommitConnection: 'PullRequestCommitEdge',
    SearchResultItemConnection: 'SearchResultItemEdge',
  };
  return map[connection] ?? null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  origin: string;
  errors: GqlErrorEntry[];
  vars: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
}

function directiveApplies(directives: DirectiveNode[], vars: Record<string, unknown>): boolean {
  for (const dir of directives) {
    const ifArg = dir.args.find((arg) => arg.name === 'if');
    if (ifArg === undefined) continue;
    const value = evalValue(ifArg.value, vars);
    if (dir.name === 'skip' && value === true) return false;
    if (dir.name === 'include' && value !== true) return false;
  }
  return true;
}

function argsOf(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, vars);
  return out;
}

function executeSelectionSet(
  typeName: string,
  value: TypedValue,
  selections: SelectionNode[],
  path: (string | number)[],
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (!directiveApplies(sel.directives, ctx.vars)) continue;
      const responseKey = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        out[responseKey] = typeName;
        continue;
      }
      let resolved: unknown;
      try {
        resolved = resolveField(typeName, sel.name, value, argsOf(sel, ctx.vars), ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, responseKey] });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = executeValue(typeName, sel, resolved, [...path, responseKey], ctx);
    } else if (sel.kind === 'spread') {
      if (!directiveApplies(sel.directives, ctx.vars)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) continue;
      if (frag.typeCondition !== typeName && frag.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(typeName, value, frag.selections, path, ctx));
    } else {
      if (!directiveApplies(sel.directives, ctx.vars)) continue;
      if (sel.typeCondition !== null && sel.typeCondition !== typeName && sel.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(typeName, value, sel.selections, path, ctx));
    }
  }
  return out;
}

function executeValue(
  parentType: string,
  field: FieldNode,
  resolved: unknown,
  path: (string | number)[],
  ctx: ExecCtx,
): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    if (field.selections === null) return resolved;
    const childType = childTypeOf(parentType, field.name);
    return resolved.map((item, index) => {
      if (isRecord(item) && typeof item.__typename === 'string') {
        return executeSelectionSet(item.__typename as string, item as TypedValue, field.selections as SelectionNode[], [...path, index], ctx);
      }
      return item;
    });
  }
  if (isRecord(resolved) && typeof resolved.__typename === 'string') {
    if (field.selections === null) return {};
    // node(id:) is polymorphic: sub-selections are validated against the
    // concrete type, so execute against the resolved type directly.
    return executeSelectionSet(resolved.__typename as string, resolved as TypedValue, field.selections, path, ctx);
  }
  return resolved;
}

// --- ordering ---------------------------------------------------------------

function orderIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const out = [...issues];
  const spec = isRecord(orderBy) ? orderBy : {};
  const field = typeof spec.field === 'string' ? spec.field : 'CREATED_AT';
  const direction = spec.direction === 'ASC' ? 1 : -1;
  out.sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
    else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * direction;
  });
  return out;
}

function orderPulls(pulls: Pull[], orderBy: unknown): Pull[] {
  const out = [...pulls];
  const spec = isRecord(orderBy) ? orderBy : {};
  const direction = spec.direction === 'ASC' ? 1 : -1;
  out.sort((a, b) => {
    const cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number;
    return cmp * direction;
  });
  return out;
}

// --- field resolution -------------------------------------------------------

function resolveField(typeName: string, field: string, value: TypedValue, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const origin = ctx.origin;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return userVal(VIEWER);
      if (field === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoVal(repo);
      }
      if (field === 'node') return resolveNode(args.id, ctx);
      if (field === 'user') {
        const user = USER_BY_LOGIN.get(String(args.login ?? ''));
        return user === undefined ? null : userVal(user);
      }
      if (field === 'organization') {
        const login = String(args.login ?? '');
        if (login === ORG_LOGIN) return orgVal(login);
        return null;
      }
      if (field === 'search') {
        return makeConnection('SearchResultItemConnection', [], args.first, args.after);
      }
      if (field === '__type') {
        const info = TYPE_INFO[String(args.name ?? '')];
        if (info === undefined) return null;
        return typeVal(String(args.name), info);
      }
      if (field === '__schema') {
        return { __typename: '__Schema', __types: Object.keys(TYPE_INFO) };
      }
      throw new Error(`Cannot query field "${field}" on type "Query".`);
    }
    case 'Mutation': {
      if (field === 'createIssue') return mutateCreateIssue(args.input, ctx);
      if (field === 'closeIssue') return mutateCloseIssue(args.input, ctx);
      if (field === 'createPullRequest') return mutateCreatePullRequest(args.input, ctx);
      if (field === 'mergePullRequest') return mutateMergePullRequest(args.input, ctx);
      if (field === 'addComment') return mutateAddComment(args.input, ctx);
      throw new Error(`Cannot query field "${field}" on type "Mutation".`);
    }
    case 'Repository': {
      const repo = value.repo as Repo;
      switch (field) {
        case 'id': return repoId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.full_name;
        case 'owner': return userVal(repo.owner);
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'url': return `${origin}/${repo.full_name}`;
        case 'resourcePath': return `/${repo.full_name}`;
        case 'createdAt': return repo.created_at;
        case 'updatedAt': return repo.updated_at;
        case 'pushedAt': return repo.pushed_at;
        case 'defaultBranchRef': {
          const sha = store.resolveRef(repo, repo.default_branch);
          return sha === undefined ? null : refVal(repo, repo.default_branch);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'forkCount': return 0;
        case 'stargazerCount': return 0;
        case 'stargazers':
        case 'watchers':
          return makeConnection('UserConnection', [], args.first, args.after);
        case 'labels': {
          const labels = [...repo.labels.values()].sort((a, b) => (a.id - b.id));
          return makeConnection('LabelConnection', labels.map((label) => labelVal(repo, label)), args.first, args.after);
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueVal(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as unknown[]).map((s) => String(s).toUpperCase() === 'CLOSED' ? 'closed' : 'open'));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          issues = orderIssues(issues, args.orderBy);
          return makeConnection('IssueConnection', issues.map((issue) => issueVal(repo, issue)), args.first, args.after);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullVal(repo, pull);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as unknown[]).map((s) => String(s).toUpperCase()));
            pulls = pulls.filter((pull) => {
              const state = pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
              return wanted.has(state);
            });
          }
          pulls = orderPulls(pulls, args.orderBy);
          return makeConnection('PullRequestConnection', pulls.map((pull) => pullVal(repo, pull)), args.first, args.after);
        }
        default:
          throw new Error(`Cannot query field "${field}" on type "Repository".`);
      }
    }
    case 'User': {
      const user = value.user as User;
      switch (field) {
        case 'id': return userId(user);
        case 'databaseId': return user.id;
        case 'login': return user.login;
        case 'name': return user.name;
        case 'email': return user.email;
        case 'url': return `${origin}/${user.login}`;
        case 'avatarUrl': return `${origin}/avatars/${user.login}`;
        case 'repositories': {
          const repos = store.listReposForUser(user.login);
          return makeConnection('RepositoryConnection', repos.map((repo) => repoVal(repo)), args.first, args.after);
        }
        default:
          throw new Error(`Cannot query field "${field}" on type "User".`);
      }
    }
    case 'Organization': {
      const login = value.login as string;
      const user = value.user as User;
      switch (field) {
        case 'id': return b64encode(`Organization:${login}`);
        case 'databaseId': return user.id;
        case 'login': return login;
        case 'name': return login;
        case 'email': return user.email;
        case 'url': return `${origin}/${login}`;
        case 'avatarUrl': return `${origin}/avatars/${login}`;
        case 'repositories': {
          const repos = store.listReposForUser(login);
          return makeConnection('RepositoryConnection', repos.map((repo) => repoVal(repo)), args.first, args.after);
        }
        default:
          throw new Error(`Cannot query field "${field}" on type "Organization".`);
      }
    }
    case 'Issue': {
      const repo = value.repo as Repo;
      const issue = value.issue as Issue;
      switch (field) {
        case 'id': return issueId(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
        case 'author': return userVal(issue.user);
        case 'labels':
          return makeConnection('LabelConnection', issue.labels.map((label) => labelVal(repo, label)), args.first, args.after);
        case 'comments':
          return makeConnection('IssueCommentConnection', issue.comments.map((comment) => commentVal(repo, issue, comment)), args.first, args.after);
        case 'assignees':
          return makeConnection('UserConnection', issue.assignees.map((u) => userVal(u)), args.first, args.after);
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'closedAt': return issue.closed_at;
        case 'url': return `${origin}/${repo.full_name}/issues/${issue.number}`;
        case 'repository': return repoVal(repo);
        case 'locked': return false;
        default:
          throw new Error(`Cannot query field "${field}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const repo = value.repo as Repo;
      const pull = value.pull as Pull;
      switch (field) {
        case 'id': return pullId(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return pull.headSha;
        case 'baseRefOid': return pull.baseSha;
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': {
          if (pull.mergeCommitSha === null) return null;
          return commitVal(repo, pull.mergeCommitSha);
        }
        case 'files': {
          const files = pull.files.map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          }) as TypedValue);
          return makeConnection('PullRequestChangedFileConnection', files, args.first, args.after);
        }
        case 'commits': {
          const nodes: TypedValue[] = [];
          const headSha = pull.headSha;
          if (headSha !== '') {
            nodes.push({ __typename: 'PullRequestCommit', id: b64encode(`PullRequestCommit:${repo.full_name}:${pull.number}:${headSha}`), commit: commitVal(repo, headSha) });
          }
          // totalCount is the real commit count even though nodes carry the head commit only.
          const conn = makeConnection('PullRequestCommitConnection', nodes, args.first, args.after);
          conn.__totalCount = pull.commits;
          return conn;
        }
        case 'author': return userVal(pull.user);
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'closedAt': return pull.closed_at;
        case 'mergeable': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'mergeableState': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'mergeStateStatus': return pull.mergeable ? 'CLEAN' : 'DIRTY';
        default:
          throw new Error(`Cannot query field "${field}" on type "PullRequest".`);
      }
    }
    case 'Label': {
      const repo = value.repo as Repo;
      const label = value.label as Label;
      switch (field) {
        case 'id': return labelId(repo, label);
        case 'databaseId': return label.id;
        case 'name': return label.name;
        case 'color': return label.color;
        case 'description': return label.description;
        case 'url': return `${origin}/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}`;
        default:
          throw new Error(`Cannot query field "${field}" on type "Label".`);
      }
    }
    case 'IssueComment': {
      const repo = value.repo as Repo;
      const issue = value.issue as Issue;
      const comment = value.comment as IssueComment;
      switch (field) {
        case 'id': return commentId(repo, issue, comment);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'author': return userVal(comment.user);
        case 'createdAt': return comment.created_at;
        case 'updatedAt': return comment.updated_at;
        case 'url': return `${origin}/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`;
        default:
          throw new Error(`Cannot query field "${field}" on type "IssueComment".`);
      }
    }
    case 'Ref': {
      const repo = value.repo as Repo;
      const name = value.name as string;
      switch (field) {
        case 'id': return b64encode(`Ref:${repo.full_name}:${name}`);
        case 'name': return name;
        case 'prefix': return 'refs/heads/';
        default:
          throw new Error(`Cannot query field "${field}" on type "Ref".`);
      }
    }
    case 'Commit': {
      const repo = value.repo as Repo;
      const oid = value.oid as string;
      switch (field) {
        case 'oid': return oid;
        case 'abbreviatedOid': return oid.slice(0, 7);
        case 'message':
        case 'messageHeadline': {
          const object = repo.objects.get(oid);
          if (object === undefined) return '';
          const message = parseCommit(object.data).message;
          return field === 'messageHeadline' ? message.split('\n')[0] ?? '' : message;
        }
        case 'author': {
          const object = repo.objects.get(oid);
          const line = object === undefined ? '' : parseCommit(object.data).authorLine;
          const match = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(line);
          return { __typename: 'GitActor', name: match === null ? '' : match[1] as string, email: match === null ? '' : match[2] as string, date: '' };
        }
        case 'committedDate': return '';
        default:
          throw new Error(`Cannot query field "${field}" on type "Commit".`);
      }
    }
    case 'GitActor': {
      if (field === 'name') return value.name;
      if (field === 'email') return value.email;
      if (field === 'date') return value.date;
      throw new Error(`Cannot query field "${field}" on type "GitActor".`);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
    case 'RepositoryConnection':
    case 'UserConnection':
    case 'PullRequestChangedFileConnection':
    case 'PullRequestCommitConnection':
    case 'SearchResultItemConnection': {
      switch (field) {
        case 'nodes': return value.__items as TypedValue[];
        case 'edges': {
          const items = value.__items as TypedValue[];
          const start = value.__startOffset as number;
          const edgeType = edgeTypeOf(typeName) ?? 'IssueEdge';
          return items.map((node, index) => ({ __typename: edgeType, node, cursor: encodeCursor(start + index) }) as TypedValue);
        }
        case 'totalCount': return value.__totalCount as number;
        case 'pageInfo': return { __typename: 'PageInfo', ...(value.__pageInfo as PageInfoData) };
        default:
          throw new Error(`Cannot query field "${field}" on type "${typeName}".`);
      }
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'LabelEdge':
    case 'IssueCommentEdge':
    case 'RepositoryEdge':
    case 'UserEdge':
    case 'PullRequestChangedFileEdge':
    case 'PullRequestCommitEdge':
    case 'SearchResultItemEdge': {
      if (field === 'node') return value.node;
      if (field === 'cursor') return value.cursor;
      throw new Error(`Cannot query field "${field}" on type "${typeName}".`);
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return value.hasNextPage;
      if (field === 'hasPreviousPage') return value.hasPreviousPage;
      if (field === 'startCursor') return value.startCursor;
      if (field === 'endCursor') return value.endCursor;
      throw new Error(`Cannot query field "${field}" on type "PageInfo".`);
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return value.path;
      if (field === 'additions') return value.additions;
      if (field === 'deletions') return value.deletions;
      if (field === 'changeType') return value.changeType;
      throw new Error(`Cannot query field "${field}" on type "PullRequestChangedFile".`);
    }
    case 'PullRequestCommit': {
      if (field === 'id') return value.id;
      if (field === 'commit') return value.commit;
      throw new Error(`Cannot query field "${field}" on type "PullRequestCommit".`);
    }
    case '__Type': {
      const info = value.__info as TypeInfo;
      switch (field) {
        case 'name': return value.__typeName as string;
        case 'kind': return info.kind;
        case 'description': return null;
        case 'fields':
          return info.fields === undefined ? null : info.fields.map((name) => ({ __typename: '__Field', name }) as TypedValue);
        case 'enumValues':
          return info.enumValues === undefined ? null : info.enumValues.map((name) => ({ __typename: '__EnumValue', name }) as TypedValue);
        case 'inputFields':
          return info.inputFields === undefined ? null : info.inputFields.map((name) => ({ __typename: '__InputValue', name }) as TypedValue);
        case 'possibleTypes': return null;
        case 'interfaces': return [];
        default:
          throw new Error(`Cannot query field "${field}" on type "__Type".`);
      }
    }
    case '__Field': {
      if (field === 'name') return value.name;
      if (field === 'description') return null;
      if (field === 'type') return { __typename: '__Type', __typeName: 'String', __info: { kind: 'SCALAR' } as TypeInfo };
      if (field === 'args') return [];
      throw new Error(`Cannot query field "${field}" on type "__Field".`);
    }
    case '__EnumValue': {
      if (field === 'name') return value.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      throw new Error(`Cannot query field "${field}" on type "__EnumValue".`);
    }
    case '__InputValue': {
      if (field === 'name') return value.name;
      if (field === 'description') return null;
      if (field === 'type') return { __typename: '__Type', __typeName: 'String', __info: { kind: 'SCALAR' } as TypeInfo };
      if (field === 'defaultValue') return null;
      throw new Error(`Cannot query field "${field}" on type "__InputValue".`);
    }
    case '__Schema': {
      if (field === 'queryType') return typeVal('Query', TYPE_INFO.Query as TypeInfo);
      if (field === 'mutationType') return typeVal('Mutation', TYPE_INFO.Mutation as TypeInfo);
      if (field === 'subscriptionType') return null;
      if (field === 'types') return (value.__types as string[]).map((name) => typeVal(name, TYPE_INFO[name] as TypeInfo));
      if (field === 'directives') return [];
      throw new Error(`Cannot query field "${field}" on type "__Schema".`);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return value.issue;
      if (field === 'clientMutationId') return value.clientMutationId ?? null;
      throw new Error(`Cannot query field "${field}" on type "${typeName}".`);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return value.pullRequest;
      if (field === 'clientMutationId') return value.clientMutationId ?? null;
      throw new Error(`Cannot query field "${field}" on type "${typeName}".`);
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return value.commentEdge;
      if (field === 'subject') return value.subject ?? null;
      if (field === 'clientMutationId') return value.clientMutationId ?? null;
      throw new Error(`Cannot query field "${field}" on type "AddCommentPayload".`);
    }
    default:
      throw new Error(`Cannot query field "${field}" on type "${typeName}".`);
  }
}

function typeVal(name: string, info: TypeInfo): TypedValue {
  return { __typename: '__Type', __typeName: name, __info: info };
}

function commitVal(repo: Repo, oid: string): TypedValue {
  return { __typename: 'Commit', repo, oid };
}

function resolveNode(id: unknown, ctx: ExecCtx): TypedValue | null {
  const payload = decodeGlobalId(id);
  if (payload === null) return null;
  if (payload.startsWith('Repository:')) {
    const [owner, name] = splitOwnerName(payload.slice('Repository:'.length));
    const repo = ctx.store.getRepo(owner, name);
    return repo === undefined ? null : repoVal(repo);
  }
  if (payload.startsWith('Issue:')) {
    const found = findIssueByGlobalId(ctx.store, id);
    return found === null ? null : issueVal(found.repo, found.issue);
  }
  if (payload.startsWith('PullRequest:')) {
    const found = findPullByGlobalId(ctx.store, id);
    return found === null ? null : pullVal(found.repo, found.pull);
  }
  if (payload.startsWith('User:')) {
    const user = USER_BY_LOGIN.get(payload.slice('User:'.length));
    return user === undefined ? null : userVal(user);
  }
  if (payload.startsWith('Organization:')) {
    const login = payload.slice('Organization:'.length);
    return login === ORG_LOGIN ? orgVal(login) : null;
  }
  return null;
}

// --- mutations ---------------------------------------------------------------

function inputRecord(input: unknown, what: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${what}: input must be an object.`);
  return input;
}

function mutateCreateIssue(input: unknown, ctx: ExecCtx): TypedValue {
  const record = inputRecord(input, 'createIssue');
  const repo = findRepoByGlobalId(ctx.store, record.repositoryId);
  if (repo === null) throw new Error('createIssue: repository not found for repositoryId.');
  const title = record.title;
  if (typeof title !== 'string' || title === '') throw new Error('createIssue: title is required.');
  const now = nowIso();
  const issue: Issue = {
    id: repo.nextIssueId,
    number: repo.nextIssue,
    title,
    body: typeof record.body === 'string' ? record.body : '',
    state: 'open',
    user: VIEWER,
    labels: [],
    assignees: [],
    comments: [],
    created_at: now,
    updated_at: now,
    closed_at: null,
  };
  repo.nextIssueId += 1;
  repo.nextIssue += 1;
  repo.issues.set(issue.number, issue);
  repo.updated_at = now;
  return { __typename: 'CreateIssuePayload', issue: issueVal(repo, issue), clientMutationId: typeof record.clientMutationId === 'string' ? record.clientMutationId : null };
}

function mutateCloseIssue(input: unknown, ctx: ExecCtx): TypedValue {
  const record = inputRecord(input, 'closeIssue');
  const found = findIssueByGlobalId(ctx.store, record.issueId);
  if (found === null) throw new Error('closeIssue: issue not found for issueId.');
  const now = nowIso();
  found.issue.state = 'closed';
  found.issue.closed_at = now;
  found.issue.updated_at = now;
  found.repo.updated_at = now;
  return { __typename: 'CloseIssuePayload', issue: issueVal(found.repo, found.issue), clientMutationId: typeof record.clientMutationId === 'string' ? record.clientMutationId : null };
}

function mutateCreatePullRequest(input: unknown, ctx: ExecCtx): TypedValue {
  const record = inputRecord(input, 'createPullRequest');
  const repo = findRepoByGlobalId(ctx.store, record.repositoryId);
  if (repo === null) throw new Error('createPullRequest: repository not found for repositoryId.');
  const baseRef = record.baseRefName;
  const headRef = record.headRefName;
  const title = record.title;
  if (typeof baseRef !== 'string' || baseRef === '') throw new Error('createPullRequest: baseRefName is required.');
  if (typeof headRef !== 'string' || headRef === '') throw new Error('createPullRequest: headRefName is required.');
  if (typeof title !== 'string' || title === '') throw new Error('createPullRequest: title is required.');
  const baseSha = ctx.store.resolveRef(repo, baseRef) ?? '';
  const headSha = ctx.store.resolveRef(repo, headRef) ?? '';
  const stats = pullStats(ctx.store, repo, headSha, baseSha);
  const now = nowIso();
  const pull: Pull = {
    id: repo.nextPullId,
    number: repo.nextPull,
    title,
    body: typeof record.body === 'string' ? record.body : '',
    state: 'open',
    user: VIEWER,
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
    files: stats.files,
    additions: stats.additions,
    deletions: stats.deletions,
    changedFiles: stats.changedFiles,
    commits: stats.commits,
    mergeable: true,
  };
  repo.nextPullId += 1;
  repo.nextPull += 1;
  repo.pulls.set(pull.number, pull);
  repo.updated_at = now;
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullVal(repo, pull), clientMutationId: typeof record.clientMutationId === 'string' ? record.clientMutationId : null };
}

function mutateMergePullRequest(input: unknown, ctx: ExecCtx): TypedValue {
  const record = inputRecord(input, 'mergePullRequest');
  const found = findPullByGlobalId(ctx.store, record.pullRequestId);
  if (found === null) throw new Error('mergePullRequest: pull request not found for pullRequestId.');
  const { repo, pull } = found;
  if (pull.merged) throw new Error('mergePullRequest: pull request is already merged.');
  if (pull.state === 'closed') throw new Error('mergePullRequest: pull request is closed.');
  const method = typeof record.mergeMethod === 'string' ? record.mergeMethod.toUpperCase() : 'MERGE';
  if (method !== 'MERGE' && method !== 'SQUASH' && method !== 'REBASE') {
    throw new Error(`mergePullRequest: mergeMethod must be MERGE, SQUASH or REBASE, got ${JSON.stringify(record.mergeMethod)}.`);
  }
  const now = nowIso();
  let mergeSha = pull.headSha;
  if (method === 'REBASE') {
    // Fast-forward the base branch onto the head commit.
    if (pull.headSha !== '') repo.refs.set(`refs/heads/${pull.baseRef}`, pull.headSha);
  } else {
    const headTree = pull.headSha !== '' ? treeOf(repo, pull.headSha) : '';
    const baseTree = pull.baseSha !== '' ? treeOf(repo, pull.baseSha) : '';
    const tree = headTree !== '' ? headTree : baseTree;
    let finalTree = tree;
    if (finalTree === '') {
      const empty = makeTree([]);
      repo.objects.set(empty.sha, empty.object);
      finalTree = empty.sha;
    }
    const parents = method === 'SQUASH' ? (pull.baseSha === '' ? [] : [pull.baseSha]) : [pull.baseSha, pull.headSha].filter((sha) => sha !== '');
    const message = method === 'SQUASH' ? pull.title : `Merge pull request #${pull.number} from ${repo.owner.login}:${pull.headRef}`;
    const commit = makeCommit({ tree: finalTree, parents, author: { name: VIEWER.name, email: VIEWER.email }, message });
    repo.objects.set(commit.sha, commit.object);
    mergeSha = commit.sha;
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  }
  pull.merged = true;
  pull.mergeCommitSha = mergeSha === '' ? null : mergeSha;
  pull.mergedAt = now;
  pull.state = 'closed';
  pull.closed_at = now;
  pull.updated_at = now;
  repo.updated_at = now;
  repo.pushed_at = now;
  return { __typename: 'MergePullRequestPayload', pullRequest: pullVal(repo, pull), clientMutationId: typeof record.clientMutationId === 'string' ? record.clientMutationId : null };
}

function mutateAddComment(input: unknown, ctx: ExecCtx): TypedValue {
  const record = inputRecord(input, 'addComment');
  const found = findIssueByGlobalId(ctx.store, record.subjectId);
  if (found === null) throw new Error('addComment: subject not found for subjectId.');
  const body = record.body;
  if (typeof body !== 'string' || body === '') throw new Error('addComment: body is required.');
  const now = nowIso();
  const comment: IssueComment = {
    id: found.repo.nextCommentId,
    body,
    user: VIEWER,
    created_at: now,
    updated_at: now,
  };
  found.repo.nextCommentId += 1;
  found.issue.comments.push(comment);
  found.issue.updated_at = now;
  found.repo.updated_at = now;
  const node = commentVal(found.repo, found.issue, comment);
  const edge: TypedValue = { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(found.issue.comments.length - 1) };
  return {
    __typename: 'AddCommentPayload',
    commentEdge: edge,
    subject: issueVal(found.repo, found.issue),
    clientMutationId: typeof record.clientMutationId === 'string' ? record.clientMutationId : null,
  };
}

// ---------------------------------------------------------------------------
// One operation
// ---------------------------------------------------------------------------

function executeOperation(
  body: Record<string, unknown>,
  store: Store,
  origin: string,
): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isRecord(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;

  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  let operation: Operation | undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (operation === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0] as Operation;
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }

  // Variables: defaults, then supplied values, then required checks.
  const varErrors: string[] = [];
  const vars: Record<string, unknown> = {};
  for (const def of operation.varDefs) {
    if (Object.prototype.hasOwnProperty.call(variables, def.name)) {
      vars[def.name] = variables[def.name];
    } else if (def.defaultValue !== null) {
      vars[def.name] = evalValue(def.defaultValue, {});
    }
    checkVarValue(vars[def.name], def.type, def.name, varErrors);
  }
  if (varErrors.length > 0) {
    return { data: null, errors: varErrors.map((message) => ({ message })) };
  }

  // Validation: unknown fields / arguments / missing required arguments.
  // node(id:) sub-selections are polymorphic, so validate them against every
  // concrete node type the id could name and only fail when the field fits
  // none of them.
  const validationErrors: string[] = [];
  validateOperation(operation, doc.fragments, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }

  const ctx: ExecCtx = { store, origin, errors: [], vars, fragments: doc.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: TypedValue = { __typename: rootType };
  const data = executeSelectionSet(rootType, root, operation.selections, [], ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function validateOperation(operation: Operation, fragments: Map<string, FragmentDef>, errors: string[]): void {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelectionsLoose(operation.selections, rootType, fragments, errors);
}

/**
 * Like validateSelections, but a field under node(id:) (or under an inline
 * fragment on a concrete type) is valid when it exists on the concrete type
 * being validated; node sub-selections are checked against Repository,
 * Issue, PullRequest and User, and pass when they fit at least one.
 */
function validateSelectionsLoose(
  selections: SelectionNode[],
  parentType: string,
  fragments: Map<string, FragmentDef>,
  errors: string[],
  depth = 0,
): void {
  if (depth > 50) return;
  const fields = FIELD_SETS[parentType];
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (sel.name === '__typename') continue;
      if (fields === undefined || !fields.includes(sel.name)) {
        errors.push(`Cannot query field "${sel.name}" on type "${parentType}".`);
        continue;
      }
      const argSet = ARG_SETS[parentType]?.[sel.name];
      if (argSet !== undefined) {
        for (const arg of sel.args) {
          if (!argSet.includes(arg.name)) errors.push(`Unknown argument "${arg.name}" on field "${parentType}.${sel.name}".`);
        }
      }
      const required = REQUIRED_ARGS[parentType]?.[sel.name] ?? [];
      for (const req of required) {
        if (!sel.args.some((arg) => arg.name === req)) errors.push(`Field "${parentType}.${sel.name}" argument "${req}" of type "String!" is required, but it was not provided.`);
      }
      if (sel.selections !== null) {
        if (parentType === 'Query' && sel.name === 'node') {
          // Polymorphic: the field fits when it fits at least one node type.
          const candidates = ['Repository', 'Issue', 'PullRequest', 'User', 'Organization'];
          const ok = candidates.some((candidate) => {
            const probe: string[] = [];
            validateSelections(sel.selections as SelectionNode[], candidate, fragments, probe, depth + 1);
            return probe.length === 0;
          });
          if (!ok) {
            const probe: string[] = [];
            validateSelections(sel.selections as SelectionNode[], 'Repository', fragments, probe, depth + 1);
            errors.push(...probe);
          }
        } else if (parentType === 'AddCommentPayload' && sel.name === 'subject') {
          const candidates = ['Issue', 'PullRequest'];
          const ok = candidates.some((candidate) => {
            const probe: string[] = [];
            validateSelections(sel.selections as SelectionNode[], candidate, fragments, probe, depth + 1);
            return probe.length === 0;
          });
          if (!ok) errors.push(`Cannot query field on type "Issue" in subject selection.`);
        } else {
          const childType = childTypeOf(parentType, sel.name);
          if (childType !== null) validateSelectionsLoose(sel.selections, childType, fragments, errors, depth + 1);
        }
      }
    } else if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (frag === undefined) errors.push(`Unknown fragment "${sel.name}".`);
      else validateSelectionsLoose(frag.selections, frag.typeCondition, fragments, errors, depth + 1);
    } else {
      const nextType = sel.typeCondition ?? parentType;
      validateSelectionsLoose(sel.selections, nextType, fragments, errors, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP handler (the coordinator wires this into app.ts)
// ---------------------------------------------------------------------------

/**
 * Serve POST /api/graphql. Returns true when the path is /api/graphql
 * (any method; non-POST answers 405), false otherwise so the coordinator's
 * router can fall through. Never throws out of the handler.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store, origin: string): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/api/graphql') return false;
  const effectiveOrigin = origin !== '' ? origin : originOf(req.headers.host);
  try {
    if (!authOk(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return true;
    }
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    let text: string;
    try {
      text = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    if (Array.isArray(parsed)) {
      // GitHub operation batching: one body per operation, in order.
      const results = parsed.map((entry) => {
        if (!isRecord(entry)) return { data: null, errors: [{ message: 'Must provide query string.' }] };
        try {
          return executeOperation(entry, store, effectiveOrigin);
        } catch (err) {
          return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
        }
      });
      sendJson(res, 200, results);
      return true;
    }
    if (!isRecord(parsed)) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    let result: Record<string, unknown>;
    try {
      result = executeOperation(parsed, store, effectiveOrigin);
    } catch (err) {
      result = { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    sendJson(res, 200, result);
    return true;
  } catch (err) {
    try {
      sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
    } catch {
      // The response is already gone; nothing more can be done.
    }
    return true;
  }
}
