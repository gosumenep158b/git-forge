// MCP (Model Context Protocol) surface for the forge: streamable HTTP at POST /mcp,
// JSON-RPC 2.0, speaking the legacy handshake era (2025-11-25 and earlier) the
// suite's client falls back to when `server/discover` answers method-not-found.
//
// Every tool reads/mutates the same shared Store the REST surface uses, so an
// object created over MCP is the same object over REST (same ids, same numbering).
// Every reply carries X-GitHub-Request-Id.
//
// Erasable TypeScript only (node --experimental-strip-types): no enums, no
// namespaces, no parameter properties. Node builtins only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  VIEWER_LOGIN,
  authOk,
  commentView,
  issueView,
  makeCommit,
  newRequestId,
  nowIso,
  parseCommit,
  parseTree,
  pullView,
  repoView,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  type TreeEntry,
} from './store.ts';

/** The MCP server's self-reported identity (initialize / serverInfo). */
const SERVER_NAME = 'forge';
const SERVER_VERSION = '0.1.0';

/** Protocol revisions this server accepts and echoes back on initialize. */
const ACCEPTED_REVISIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** JSON-RPC error codes the suite's client recognises. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** The largest request body accepted (10 MiB; the suite sends kilobytes). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function sendRpcResult(res: ServerResponse, id: JsonRpcId, result: unknown, requestId: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result }, requestId);
}

function sendRpcError(res: ServerResponse, id: JsonRpcId | null, code: number, message: string, requestId: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } }, requestId);
}

// ---------------------------------------------------------------- tool plumbing

/** A tool failure the caller reports as a tool execution error (isError:true). */
class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

interface ToolContext {
  store: Store;
  origin: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => unknown;
}

function reqStr(args: Record<string, unknown>, name: string, tool: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw new ToolError(`Missing required argument: ${name} for tool ${tool}`);
  }
  return value;
}

function optStr(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function reqNum(args: Record<string, unknown>, name: string, tool: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new ToolError(`Missing required argument: ${name} for tool ${tool}`);
}

function optBool(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** The owner a tool call names, defaulting to the token's login. */
function ownerOf(args: Record<string, unknown>): string {
  const owner = optStr(args, 'owner');
  return owner !== undefined && owner !== '' ? owner : VIEWER_LOGIN;
}

function getRepoOrThrow(ctx: ToolContext, owner: string, repoName: string): Repo {
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) throw new ToolError(`Not Found: repository ${owner}/${repoName} does not exist`);
  return repo;
}

/** A branch name as the caller wrote it ('owner:branch' is accepted, GitHub-style). */
function branchName(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/** Resolve a branch/ref name to a commit sha, or throw. */
function resolveShaOrThrow(repo: Repo, ref: string, what: string): string {
  const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (sha !== undefined) return sha;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  throw new ToolError(`Not Found: ${what} ${ref} does not exist in ${repo.full_name}`);
}

// ---------------------------------------------------------------- git helpers

/** path -> {sha, mode} for every blob under `treeSha`, recursively. */
function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, { sha: string; mode: string }>): void {
  const object = repo.objects.get(treeSha);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
}

/** Commit shas from `headSha` down to (excluding) `baseSha`, newest first. */
function commitsAhead(repo: Repo, baseSha: string, headSha: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [headSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (sha === baseSha || seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(sha);
    const parsed = parseCommit(object.data);
    for (const parent of parsed.parents) queue.push(parent);
    if (out.length >= 10000) break;
  }
  return out;
}

/** Lines in a blob's content (a crude diff size; the suite reads only the totals). */
function lineCount(repo: Repo, sha: string): number {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'blob') return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

interface DiffStats {
  files: Pull['files'];
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** The file diff between two trees (base -> head). */
function diffTrees(repo: Repo, baseTreeSha: string, headTreeSha: string): DiffStats {
  const base = new Map<string, { sha: string; mode: string }>();
  const head = new Map<string, { sha: string; mode: string }>();
  flattenTree(repo, baseTreeSha, '', base);
  flattenTree(repo, headTreeSha, '', head);
  const files: Pull['files'] = [];
  let additions = 0;
  let deletions = 0;
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (old === undefined) {
      const added = lineCount(repo, entry.sha);
      files.push({ filename: path, status: 'added', additions: added, deletions: 0, changes: added, sha: entry.sha });
      additions += added;
    } else if (old.sha !== entry.sha) {
      const added = lineCount(repo, entry.sha);
      const removed = lineCount(repo, old.sha);
      files.push({ filename: path, status: 'modified', additions: added, deletions: removed, changes: added + removed, sha: entry.sha });
      additions += added;
      deletions += removed;
    }
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) {
      const removed = lineCount(repo, entry.sha);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: removed, changes: removed, sha: entry.sha });
      deletions += removed;
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return { files, additions, deletions, changedFiles: files.length };
}

/** Parse "Name <email> epoch +0000" into its parts (best effort). */
function parseIdent(line: string): { name: string; email: string; epoch: number } {
  const match = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', epoch: 0 };
  return { name: match[1] as string, email: match[2] as string, epoch: Number(match[3]) };
}

/** A commit object rendered the way the REST views render one. */
function commitView(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') throw new ToolError(`Not Found: commit ${sha} does not exist in ${repo.full_name}`);
  const parsed = parseCommit(object.data);
  const author = parseIdent(parsed.authorLine);
  const date = new Date(author.epoch * 1000).toISOString();
  return {
    sha,
    commit: {
      message: parsed.message,
      author: { name: author.name, email: author.email, date },
      committer: { name: author.name, email: author.email, date },
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER_LOGIN, id: 1000 },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    tree: { sha: parsed.tree },
  };
}

/** Walk a ref's history, newest first (bounded). */
function walkCommits(repo: Repo, fromSha: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [fromSha];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(sha);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- the tools

function createIssue(ctx: ToolContext, repo: Repo, args: Record<string, unknown>, tool: string): Issue {
  const title = reqStr(args, 'title', tool);
  const body = optStr(args, 'body') ?? '';
  const now = nowIso();
  const issue: Issue = {
    id: repo.nextIssueId,
    number: repo.nextIssue,
    title,
    body,
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
  return issue;
}

function getIssueOrThrow(repo: Repo, args: Record<string, unknown>, tool: string): Issue {
  const number = reqNum(args, 'issue_number', tool);
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new ToolError(`Not Found: issue #${number} does not exist in ${repo.full_name}`);
  return issue;
}

function getPullOrThrow(repo: Repo, args: Record<string, unknown>, tool: string): Pull {
  const number = reqNum(args, 'pull_number', tool);
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new ToolError(`Not Found: pull request #${number} does not exist in ${repo.full_name}`);
  return pull;
}

/** The tool set: the github-mcp-server names the suite calls, plus the adjacent ones the brief names. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    handler: (args, ctx) => {
      const name = reqStr(args, 'name', 'create_repo');
      const owner = ownerOf(args);
      if (ctx.store.getRepo(owner, name) !== undefined) {
        throw new ToolError(`Repository ${owner}/${name} already exists`);
      }
      const repo = ctx.store.createRepo(owner, name, {
        description: optStr(args, 'description') ?? '',
        private: optBool(args, 'private') ?? false,
      });
      return repoView(repo, ctx.origin, ctx.store);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'get_repo'));
      return repoView(repo, ctx.origin, ctx.store);
    },
  },
  {
    name: 'search_repositories',
    description: 'Search repositories by name or description.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'The search query.' },
      },
      required: ['q'],
    },
    handler: (args, ctx) => {
      const query = reqStr(args, 'q', 'search_repositories').toLowerCase();
      const tokens = query.split(/\s+/).filter((token) => token !== '');
      const items: Record<string, unknown>[] = [];
      for (const repo of ctx.store.repos.values()) {
        const haystack = `${repo.full_name} ${repo.description}`.toLowerCase();
        if (tokens.every((token) => haystack.includes(token))) items.push(repoView(repo, ctx.origin, ctx.store));
      }
      return { total_count: items.length, incomplete_results: false, items };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'create_issue'));
      return issueView(createIssue(ctx, repo, args, 'create_issue'), repo, ctx.origin);
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The number of the issue.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'get_issue'));
      return issueView(getIssueOrThrow(repo, args, 'get_issue'), repo, ctx.origin);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'open, closed, or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'list_issues'));
      const state = optStr(args, 'state') ?? 'open';
      const out: Record<string, unknown>[] = [];
      for (const issue of repo.issues.values()) {
        if (state !== 'all' && issue.state !== state) continue;
        out.push(issueView(issue, repo, ctx.origin));
      }
      return out;
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The number of the issue.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'add_issue_comment'));
      const issue = getIssueOrThrow(repo, args, 'add_issue_comment');
      const body = reqStr(args, 'body', 'add_issue_comment');
      const now = nowIso();
      const comment = {
        id: repo.nextCommentId,
        body,
        user: VIEWER,
        created_at: now,
        updated_at: now,
      };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      issue.updated_at = now;
      return commentView(comment, repo, issue.number, ctx.origin);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch the changes merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'create_pull_request'));
      const title = reqStr(args, 'title', 'create_pull_request');
      const headRef = branchName(reqStr(args, 'head', 'create_pull_request'));
      const baseRef = branchName(reqStr(args, 'base', 'create_pull_request'));
      const headSha = resolveShaOrThrow(repo, headRef, 'head branch');
      const baseSha = resolveShaOrThrow(repo, baseRef, 'base branch');
      const headCommit = parseCommit((repo.objects.get(headSha) as { data: Buffer }).data);
      const baseCommit = parseCommit((repo.objects.get(baseSha) as { data: Buffer }).data);
      const diff = diffTrees(repo, baseCommit.tree, headCommit.tree);
      const ahead = commitsAhead(repo, baseSha, headSha);
      const now = nowIso();
      const pull: Pull = {
        id: repo.nextPullId,
        number: repo.nextPull,
        title,
        body: optStr(args, 'body') ?? '',
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
        files: diff.files,
        additions: diff.additions,
        deletions: diff.deletions,
        changedFiles: diff.changedFiles,
        commits: ahead.length,
        mergeable: true,
      };
      repo.nextPullId += 1;
      repo.nextPull += 1;
      repo.pulls.set(pull.number, pull);
      return pullView(pull, repo, ctx.origin, ctx.store);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'get_pull_request'));
      return pullView(getPullOrThrow(repo, args, 'get_pull_request'), repo, ctx.origin, ctx.store);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'open, closed, or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'list_pull_requests'));
      const state = optStr(args, 'state') ?? 'open';
      const out: Record<string, unknown>[] = [];
      for (const pull of repo.pulls.values()) {
        if (state !== 'all' && pull.state !== state) continue;
        out.push(pullView(pull, repo, ctx.origin, ctx.store));
      }
      return out;
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'merge_pull_request'));
      const pull = getPullOrThrow(repo, args, 'merge_pull_request');
      if (pull.merged) throw new ToolError(`Pull request #${pull.number} is already merged`);
      if (pull.state !== 'open') throw new ToolError(`Pull request #${pull.number} is ${pull.state}`);
      const now = nowIso();
      if (pull.headSha !== pull.baseSha) {
        const headObject = repo.objects.get(pull.headSha);
        const baseObject = repo.objects.get(pull.baseSha);
        if (headObject === undefined || headObject.type !== 'commit') {
          throw new ToolError(`Cannot merge pull request #${pull.number}: head commit ${pull.headSha} is missing`);
        }
        if (baseObject === undefined || baseObject.type !== 'commit') {
          throw new ToolError(`Cannot merge pull request #${pull.number}: base commit ${pull.baseSha} is missing`);
        }
        const headCommit = parseCommit(headObject.data);
        const merge = makeCommit({
          tree: headCommit.tree,
          parents: [pull.baseSha, pull.headSha],
          author: { name: VIEWER.name, email: VIEWER.email },
          message: `Merge pull request #${pull.number} from ${repo.owner.login}/${pull.headRef}`,
        });
        ctx.store.putObject(repo, merge.sha, merge.object);
        repo.refs.set(`refs/heads/${pull.baseRef}`, merge.sha);
        pull.mergeCommitSha = merge.sha;
        pull.baseSha = merge.sha;
      } else {
        pull.mergeCommitSha = pull.headSha;
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = now;
      pull.closed_at = now;
      pull.updated_at = now;
      repo.pushed_at = now;
      return pullView(pull, repo, ctx.origin, ctx.store);
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch pointing at a commit or another branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        branch: { type: 'string', description: 'The name of the branch to create.' },
        from_branch: { type: 'string', description: 'The branch to start from (default: the default branch).' },
        sha: { type: 'string', description: 'The commit sha to point the branch at.' },
      },
      required: ['owner', 'repo', 'branch'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'create_branch'));
      const branch = reqStr(args, 'branch', 'create_branch');
      const refName = `refs/heads/${branch}`;
      if (repo.refs.has(refName)) throw new ToolError(`Branch ${branch} already exists in ${repo.full_name}`);
      let sha: string;
      const givenSha = optStr(args, 'sha');
      if (givenSha !== undefined) sha = resolveShaOrThrow(repo, givenSha, 'commit');
      else sha = resolveShaOrThrow(repo, optStr(args, 'from_branch') ?? repo.default_branch, 'branch');
      repo.refs.set(refName, sha);
      return { ref: refName, object: { sha, type: 'commit' } };
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'list_branches'));
      const out: Record<string, unknown>[] = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
      }
      return out;
    },
  },
  {
    name: 'get_commit',
    description: 'Get a commit by sha or ref.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        sha: { type: 'string', description: 'The commit sha or ref.' },
      },
      required: ['owner', 'repo', 'sha'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'get_commit'));
      const sha = resolveShaOrThrow(repo, reqStr(args, 'sha', 'get_commit'), 'commit');
      return commitView(repo, sha);
    },
  },
  {
    name: 'list_commits',
    description: 'List commits on a branch, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        sha: { type: 'string', description: 'The branch or commit to list from (default: the default branch).' },
      },
      required: ['owner', 'repo'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'list_commits'));
      const from = resolveShaOrThrow(repo, optStr(args, 'sha') ?? repo.default_branch, 'ref');
      return walkCommits(repo, from, 100).map((sha) => commitView(repo, sha));
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get the contents of a file or directory at a ref.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        path: { type: 'string', description: 'The path of the file or directory.' },
        ref: { type: 'string', description: 'The branch or commit (default: the default branch).' },
      },
      required: ['owner', 'repo', 'path'],
    },
    handler: (args, ctx) => {
      const repo = getRepoOrThrow(ctx, ownerOf(args), reqStr(args, 'repo', 'get_file_contents'));
      const path = reqStr(args, 'path', 'get_file_contents').replace(/^\/+/, '').replace(/\/+$/, '');
      const sha = resolveShaOrThrow(repo, optStr(args, 'ref') ?? repo.default_branch, 'ref');
      const commit = parseCommit((repo.objects.get(sha) as { data: Buffer }).data);
      let treeSha = commit.tree;
      const segments = path === '' ? [] : path.split('/');
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i] as string;
        const object = repo.objects.get(treeSha);
        if (object === undefined || object.type !== 'tree') throw new ToolError(`Not Found: ${path} does not exist in ${repo.full_name}`);
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (entry === undefined) throw new ToolError(`Not Found: ${path} does not exist in ${repo.full_name}`);
        if (i === segments.length - 1) {
          if (entry.mode === '40000') {
            const dirObject = repo.objects.get(entry.sha);
            if (dirObject === undefined || dirObject.type !== 'tree') throw new ToolError(`Not Found: ${path} does not exist in ${repo.full_name}`);
            return parseTree(dirObject.data).map((child) => ({
              type: child.mode === '40000' ? 'dir' : 'file',
              name: child.name,
              path: `${path}/${child.name}`,
              sha: child.sha,
            }));
          }
          const blob = repo.objects.get(entry.sha);
          if (blob === undefined || blob.type !== 'blob') throw new ToolError(`Not Found: ${path} does not exist in ${repo.full_name}`);
          return {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: segment,
            path,
            content: blob.data.toString('base64'),
            sha: entry.sha,
          };
        }
        if (entry.mode !== '40000') throw new ToolError(`Not Found: ${path} does not exist in ${repo.full_name}`);
        treeSha = entry.sha;
      }
      const root = repo.objects.get(treeSha);
      if (root === undefined || root.type !== 'tree') throw new ToolError(`Not Found: ${path} does not exist in ${repo.full_name}`);
      return parseTree(root.data).map((child) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: child.name,
        sha: child.sha,
      }));
    },
  },
]);

/** The public tool descriptors, built once so tools/list is byte-identical every call. */
const TOOLS_LIST: readonly Record<string, unknown>[] = Object.freeze(
  TOOLS.map((tool) => Object.freeze({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
);

const TOOL_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Check a call's arguments against the tool's required properties. */
function missingRequired(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

// ---------------------------------------------------------------- method dispatch

/** Answer one JSON-RPC request object (not a notification). */
function dispatch(request: JsonRpcRequest, id: JsonRpcId, ctx: ToolContext, res: ServerResponse, requestId: string): void {
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    sendRpcError(res, id, INVALID_REQUEST, 'Invalid Request: method must be a non-empty string', requestId);
    return;
  }
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = ACCEPTED_REVISIONS.includes(offered) ? offered : '2025-11-25';
    sendRpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }, requestId);
    return;
  }

  if (method === 'ping') {
    sendRpcResult(res, id, {}, requestId);
    return;
  }

  if (method === 'server/discover') {
    // This server predates the 2026-07-28 discover era: method-not-found is the
    // legal answer, and the client then falls back to the initialize handshake.
    sendRpcError(res, id, METHOD_NOT_FOUND, 'Method not found: server/discover', requestId);
    return;
  }

  if (method === 'tools/list') {
    sendRpcResult(res, id, { tools: TOOLS_LIST }, requestId);
    return;
  }

  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      sendRpcError(res, id, INVALID_PARAMS, 'Invalid params: tools/call requires a tool name', requestId);
      return;
    }
    const tool = TOOL_BY_NAME.get(name);
    if (tool === undefined) {
      sendRpcError(res, id, INVALID_PARAMS, `Unknown tool: ${name}`, requestId);
      return;
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const missing = missingRequired(tool, args);
    if (missing.length > 0) {
      sendRpcError(res, id, INVALID_PARAMS, `Missing required argument: ${missing.join(', ')} for tool ${name}`, requestId);
      return;
    }
    try {
      const value = tool.handler(args, ctx);
      sendRpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }, requestId);
    } catch (error) {
      if (error instanceof ToolError) {
        sendRpcResult(res, id, { content: [{ type: 'text', text: error.message }], isError: true }, requestId);
        return;
      }
      throw error;
    }
    return;
  }

  sendRpcError(res, id, METHOD_NOT_FOUND, `Method not found: ${method}`, requestId);
}

// ---------------------------------------------------------------- the handler

/** Read the whole request body (bounded). */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serve the MCP endpoint. Returns true when the path is /mcp (the request was
 * answered here, whatever the method), false for any other path.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store, origin: string): Promise<boolean> {
  let path: string;
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/mcp') return false;

  const requestId = newRequestId();
  try {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
      return true;
    }
    if (!authOk(req)) {
      sendJson(res, 401, { message: 'Bad credentials' }, requestId);
      return true;
    }
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      sendRpcError(res, null, PARSE_ERROR, 'Parse error', requestId, 400);
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText) as unknown;
    } catch {
      sendRpcError(res, null, PARSE_ERROR, 'Parse error', requestId, 400);
      return true;
    }
    if (Array.isArray(parsed)) {
      // Batch requests are not part of this transport: refuse, never half-answer.
      sendRpcError(res, null, INVALID_REQUEST, 'Invalid Request: batch requests are not supported', requestId, 400);
      return true;
    }
    if (!isRecord(parsed)) {
      sendRpcError(res, null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object', requestId, 400);
      return true;
    }
    const request = parsed as JsonRpcRequest;
    // A notification (no id) gets no JSON-RPC response: 202, empty body.
    if (request.id === undefined || request.id === null) {
      res.writeHead(202, { 'x-github-request-id': requestId });
      res.end();
      return true;
    }
    const id: JsonRpcId = request.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      sendRpcError(res, null, INVALID_REQUEST, 'Invalid Request: id must be a string or number', requestId);
      return true;
    }
    dispatch(request, id, { store, origin }, res, requestId);
    return true;
  } catch (error) {
    // Never throw out of the handler: answer a JSON-RPC error instead.
    try {
      if (!res.headersSent) {
        sendRpcError(res, null, INTERNAL_ERROR, error instanceof Error ? error.message : 'Internal error', requestId);
      } else {
        res.end();
      }
    } catch {
      // The socket is already gone; nothing left to do.
    }
    return true;
  }
}
