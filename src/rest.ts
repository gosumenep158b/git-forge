// GitHub REST v3 surface for the forge (/api/v3).
//
// Handler interface (wired into app.ts by the coordinator):
//   handleRest(req, res, store, origin) -> true when the path is under /api/v3
//   (except /api/v3 itself, /api/v3/ and /api/graphql, which belong to app.ts /
//   the GraphQL agent), false otherwise. Never throws out of the handler.
//
// Every route here requires the bearer token (authOk); missing/wrong -> 401
// {"message":"Bad credentials"}. Every reply is application/json with a
// non-empty X-GitHub-Request-Id. Malformed JSON body -> 400
// {"message":"Problems parsing JSON"}. Unknown route inside the surface ->
// JSON 404 {"message":"Not Found"}.
//
// Erasable TypeScript only (node --experimental-strip-types). Node builtins only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  VIEWER_LOGIN,
  authOk,
  commentView,
  issueView,
  labelView,
  makeBlob,
  makeCommit,
  makeTree,
  newRequestId,
  nowIso,
  originOf,
  parseCommit,
  parseTree,
  pullView,
  repoView,
  userView,
  type Issue,
  type Label,
  type Pull,
  type PullFile,
  type Repo,
  type Store,
  type TreeEntry,
} from './store.ts';

type Json = Record<string, unknown>;

const JSON_TYPE = 'application/json; charset=utf-8';
const SHA40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// plumbing

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse, extra: Record<string, string> = {}): void {
  res.writeHead(204, { 'x-github-request-id': newRequestId(), ...extra });
  res.end();
}

function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}, errors?: unknown[]): void {
  const body: Json = { message };
  if (errors !== undefined) body.errors = errors;
  sendJson(res, status, body, extra);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/** Parse a request body. Returns { ok: true, body } or { ok: false } (already 400-able). */
function parseJsonBody(raw: Buffer): { ok: true; body: Json } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, body: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { ok: true, body: parsed as Json };
    return { ok: true, body: {} };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** per_page: default 30, cap 100, floor 1. page: default 1, floor 1. */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const rawPer = Number(query.get('per_page'));
  const perPage = Number.isFinite(rawPer) ? Math.min(100, Math.max(1, Math.floor(rawPer))) : 30;
  const rawPage = Number(query.get('page'));
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  return { page, perPage };
}

function b64wrap(b64: string): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 60) out.push(b64.slice(i, i + 60));
  return out.join('\n');
}

/**
 * Paginate `items`, returning the page slice plus a GitHub-style Link header
 * (absolute URLs on the entry's origin) or null when there is a single page.
 */
function paginate<T>(
  items: readonly T[],
  origin: string,
  path: string,
  query: URLSearchParams,
  page: number,
  perPage: number,
): { slice: T[]; link: string | null } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { slice, link: null };
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    const qs = q.toString();
    return `${origin}${path}${qs === '' ? '' : `?${qs}`}`;
  };
  const links: string[] = [];
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { slice, link: links.join(', ') };
}

// ---------------------------------------------------------------------------
// git object helpers

function getCommit(repo: Repo, sha: string): { tree: string; parents: string[]; message: string; authorLine: string } | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** All ancestors of `sha` (including `sha` itself), in discovery order. */
function ancestors(repo: Repo, sha: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack: string[] = [sha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    const commit = getCommit(repo, cur);
    if (commit !== null) for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

/** First common ancestor of a and b (walking b's history), or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = new Set(ancestors(repo, a));
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ancA.has(cur)) return cur;
    const commit = getCommit(repo, cur);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Resolve a ref-ish (branch, full ref, HEAD, or a raw commit sha) to a commit sha. */
function resolveCommitSha(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (SHA40.test(ref) && repo.objects.has(ref)) return ref;
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.default_branch}`);
  return repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
}

interface AuthorIdent {
  name: string;
  email: string;
  epoch: number;
}

function parseAuthorLine(line: string): AuthorIdent {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: VIEWER.name, email: VIEWER.email, epoch: Math.floor(Date.now() / 1000) };
  return { name: match[1] ?? VIEWER.name, email: match[2] ?? VIEWER.email, epoch: Number(match[3]) };
}

function commitView(repo: Repo, sha: string, origin: string): Json | null {
  const parsed = getCommit(repo, sha);
  if (parsed === null) return null;
  const author = parseAuthorLine(parsed.authorLine);
  const date = new Date(author.epoch * 1000).toISOString();
  const ident = { name: author.name, email: author.email, date };
  return {
    sha,
    node_id: `MDQ6Q29tbWl0${sha}`,
    commit: { message: parsed.message, tree: { sha: parsed.tree }, author: ident, committer: ident },
    author: userView(VIEWER, origin),
    committer: userView(VIEWER, origin),
    parents: parsed.parents.map((p) => ({ sha: p })),
    url: '',
    html_url: '',
  };
}

/** Commits reachable from `start`, newest first (epoch desc, discovery order breaks ties). */
function listCommits(repo: Repo, start: string): { sha: string; epoch: number; order: number }[] {
  const discovered = ancestors(repo, start);
  const rows: { sha: string; epoch: number; order: number }[] = [];
  discovered.forEach((sha, order) => {
    const parsed = getCommit(repo, sha);
    if (parsed !== null) rows.push({ sha, epoch: parseAuthorLine(parsed.authorLine).epoch, order });
  });
  rows.sort((a, b) => (b.epoch - a.epoch) || (a.order - b.order));
  return rows;
}

/** Flatten a tree (by sha) into path -> {sha, mode}. Missing tree -> empty. */
function flattenTree(repo: Repo, treeSha: string | null, prefix: string, out: Map<string, { sha: string; mode: string }>): void {
  if (treeSha === null) return;
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
}

function treeOfCommit(repo: Repo, commitSha: string | null): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  if (commitSha === null) return out;
  const parsed = getCommit(repo, commitSha);
  if (parsed === null) return out;
  flattenTree(repo, parsed.tree, '', out);
  return out;
}

/** Rebuild nested trees from a flat path map; stores every tree object. Returns the root tree sha. */
function buildTreeFromFlat(repo: Repo, flat: Map<string, { sha: string; mode: string }>): string {
  const buildDir = (prefix: string): string => {
    const files: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push({ mode: entry.mode, name: rest, sha: entry.sha });
      else dirs.add(rest.slice(0, slash));
    }
    const entries: TreeEntry[] = [...files];
    for (const dir of dirs) {
      const subSha = buildDir(prefix === '' ? `${dir}/` : `${prefix}${dir}/`);
      entries.push({ mode: '40000', name: dir, sha: subSha });
    }
    const { sha, object } = makeTree(entries);
    repo.objects.set(sha, object);
    return sha;
  };
  return buildDir('');
}

/** Walk a tree to one path's entry (blob or subtree), or null when absent. */
function lookupPath(repo: Repo, treeSha: string, segments: readonly string[]): { mode: string; sha: string } | null {
  let current = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { mode: entry.mode, sha: entry.sha };
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Added/removed line counts between two blob texts (LCS; capped inputs fall back to full counts). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[b.length];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function blobText(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  if (obj === undefined) return '';
  return obj.data.toString('utf8');
}

/** Diff base tree vs head tree (flat maps) into per-file PullFiles plus totals. */
function diffMaps(repo: Repo, baseMap: Map<string, { sha: string; mode: string }>, headMap: Map<string, { sha: string; mode: string }>): { files: PullFile[]; additions: number; deletions: number } {
  const files: PullFile[] = [];
  let additions = 0;
  let deletions = 0;
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseMap.get(path);
    const head = headMap.get(path);
    if (base !== undefined && head !== undefined && base.sha === head.sha) continue;
    if (base === undefined && head !== undefined) {
      const count = lineDiff('', blobText(repo, head.sha));
      files.push({ filename: path, status: 'added', additions: count.additions, deletions: 0, changes: count.additions, sha: head.sha });
      additions += count.additions;
    } else if (base !== undefined && head === undefined) {
      const count = lineDiff(blobText(repo, base.sha), '');
      files.push({ filename: path, status: 'removed', additions: 0, deletions: count.deletions, changes: count.deletions, sha: base.sha });
      deletions += count.deletions;
    } else if (base !== undefined && head !== undefined) {
      const count = lineDiff(blobText(repo, base.sha), blobText(repo, head.sha));
      files.push({ filename: path, status: 'modified', additions: count.additions, deletions: count.deletions, changes: count.additions + count.deletions, sha: head.sha });
      additions += count.additions;
      deletions += count.deletions;
    }
  }
  return { files, additions, deletions };
}

/**
 * Conflict rule: with merge base M, a path changed on both sides (vs M) to
 * different resulting content (including one side deleting it) conflicts.
 * No merge base -> no conflict (a clean first merge).
 */
function isConflicted(repo: Repo, baseSha: string, headSha: string): boolean {
  const mb = mergeBase(repo, baseSha, headSha);
  if (mb === null) return false;
  const mbMap = treeOfCommit(repo, mb);
  const baseMap = treeOfCommit(repo, baseSha);
  const headMap = treeOfCommit(repo, headSha);
  const paths = new Set([...mbMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const mbEntry = mbMap.get(path);
    const baseEntry = baseMap.get(path);
    const headEntry = headMap.get(path);
    const baseChanged = (baseEntry?.sha ?? null) !== (mbEntry?.sha ?? null);
    const headChanged = (headEntry?.sha ?? null) !== (mbEntry?.sha ?? null);
    if (baseChanged && headChanged && (baseEntry?.sha ?? null) !== (headEntry?.sha ?? null)) return true;
  }
  return false;
}

/** Files for a pull: three-dot diff (merge base -> head). */
function pullFiles(repo: Repo, baseSha: string, headSha: string): { files: PullFile[]; additions: number; deletions: number } {
  const mb = mergeBase(repo, baseSha, headSha);
  const baseMap = mb === null ? new Map() : treeOfCommit(repo, mb);
  return diffMaps(repo, baseMap, treeOfCommit(repo, headSha));
}

function commitsAhead(repo: Repo, baseSha: string, headSha: string): number {
  const baseAnc = new Set(ancestors(repo, baseSha));
  let count = 0;
  for (const sha of ancestors(repo, headSha)) if (!baseAnc.has(sha)) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// contents helpers

function fileView(repo: Repo, origin: string, path: string, blobSha: string): Json {
  const obj = repo.objects.get(blobSha);
  const data = obj !== undefined ? obj.data : Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  const base = `${origin}/api/v3/repos/${repo.full_name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    sha: blobSha,
    content: b64wrap(data.toString('base64')),
    url: base,
    git_url: `${origin}/api/v3/repos/${repo.full_name}/git/blobs/${blobSha}`,
    html_url: `${origin}/${repo.full_name}/blob/${repo.default_branch}/${path}`,
    download_url: `${origin}/${repo.full_name}/raw/${repo.default_branch}/${path}`,
    _links: { self: base, git: `${origin}/api/v3/repos/${repo.full_name}/git/blobs/${blobSha}`, html: `${origin}/${repo.full_name}/blob/${repo.default_branch}/${path}` },
  };
}

function dirListing(repo: Repo, origin: string, treeSha: string, dirPath: string): Json[] {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  const out: Json[] = [];
  for (const entry of parseTree(obj.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({
        type: 'dir', name: entry.name, path, sha: entry.sha, size: 0,
        url: `${origin}/api/v3/repos/${repo.full_name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        git_url: `${origin}/api/v3/repos/${repo.full_name}/git/trees/${entry.sha}`,
        html_url: `${origin}/${repo.full_name}/tree/${repo.default_branch}/${path}`,
        download_url: null,
      });
    } else {
      const blob = repo.objects.get(entry.sha);
      out.push({
        type: 'file', name: entry.name, path, sha: entry.sha, size: blob !== undefined ? blob.data.length : 0,
        url: `${origin}/api/v3/repos/${repo.full_name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        git_url: `${origin}/api/v3/repos/${repo.full_name}/git/blobs/${entry.sha}`,
        html_url: `${origin}/${repo.full_name}/blob/${repo.default_branch}/${path}`,
        download_url: `${origin}/${repo.full_name}/raw/${repo.default_branch}/${path}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// handler

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, origin: string): Promise<boolean> {
  try {
    return await handleRestInner(req, res, store, origin);
  } catch {
    try {
      sendError(res, 500, 'Internal Server Error');
    } catch {
      // res already gone; nothing more to do
    }
    return true;
  }
}

async function handleRestInner(req: IncomingMessage, res: ServerResponse, store: Store, originIn: string): Promise<boolean> {
  const origin = originIn !== '' ? originIn : originOf(req.headers.host);
  let url: URL;
  try {
    url = new URL(req.url ?? '/', origin);
  } catch {
    return false;
  }
  const pathname = url.pathname;
  const query = url.searchParams;
  const method = (req.method ?? 'GET').toUpperCase();

  // Outside the surface, or the API root / GraphQL (app.ts / the GraphQL agent).
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  if (pathname === '/api/v3' || pathname === '/api/v3/') return false;

  const parts = pathname.split('/').filter((p) => p !== '').map(decodeSegment);
  // parts[0] === 'api', parts[1] === 'v3'

  // Every route below requires the token.
  if (!authOk(req)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  // Read + parse a JSON body for methods that carry one. Malformed -> 400.
  let body: Json = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    body = parsed.body;
  }

  const rest = parts.slice(2); // segments after /api/v3

  // ---- top-level -----------------------------------------------------------
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userView(VIEWER, origin));
    return true;
  }
  if (rest.length === 1 && rest[0] === 'rate_limit' && method === 'GET') {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    sendJson(res, 200, {
      resources: { core: { limit: 60, remaining: 59, reset }, search: { limit: 10, remaining: 10, reset }, graphql: { limit: 0, remaining: 0, reset } },
      rate: { limit: 60, remaining: 59, reset },
    });
    return true;
  }
  if (rest.length === 2 && rest[0] === 'users' && method === 'GET') {
    const found = rest[1] === VIEWER_LOGIN ? VIEWER : undefined;
    if (found === undefined) {
      // Known scenario users live in the store module's user list; only the
      // viewer is addressable here — anything else is a 404.
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, userView(found, origin));
    return true;
  }

  // ---- /user/repos ---------------------------------------------------------
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const views = store.listReposForUser(VIEWER_LOGIN).map((r) => repoView(r, origin, store));
      const { slice, link } = paginate(views, origin, pathname, query, page, perPage);
      sendJson(res, 200, slice, link === null ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (name === '' || name.includes('/')) {
        sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Repository', field: 'name', code: 'missing_field' }]);
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }]);
        return true;
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: str(body.description),
        private: typeof body.private === 'boolean' ? body.private : false,
        defaultBranch: str(body.default_branch) !== '' ? str(body.default_branch) : undefined,
      });
      sendJson(res, 201, repoView(repo, origin, store));
      return true;
    }
  }

  // ---- /repos/{owner}/{repo}/... ------------------------------------------
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const tail = rest.slice(3);

    // GET / PATCH / DELETE the repository itself.
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoView(repo, origin, store));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.default_branch = body.default_branch;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          const newName = body.name;
          if (store.getRepo(owner, newName) !== undefined) {
            sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }]);
            return true;
          }
          store.repos.delete(repo.full_name);
          repo.name = newName;
          repo.full_name = `${owner}/${newName}`;
          store.repos.set(repo.full_name, repo);
        }
        repo.updated_at = nowIso();
        sendJson(res, 200, repoView(repo, origin, store));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendNoContent(res);
        return true;
      }
    }

    // ---- git/refs ----
    if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (ref === '' || sha === '') {
          sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Reference', field: 'ref', code: 'missing_field' }]);
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: `MDM6UmVm${repo.id}`,
          url: `${origin}/api/v3/repos/${repo.full_name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
        });
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const out = [...repo.refs.entries()].map(([ref, sha]) => ({
          ref,
          node_id: `MDM6UmVm${repo.id}`,
          url: `${origin}/api/v3/repos/${repo.full_name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
        }));
        sendJson(res, 200, out);
        return true;
      }
      if (method === 'GET' && tail.length > 2) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, {
          ref,
          node_id: `MDM6UmVm${repo.id}`,
          url: `${origin}/api/v3/repos/${repo.full_name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: 'commit', url: `${origin}/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
        });
        return true;
      }
    }

    // ---- branches ----
    if (tail.length >= 1 && tail[0] === 'branches') {
      const branchEntries = [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/heads/'));
      if (method === 'GET' && tail.length === 1) {
        const out = branchEntries.map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${origin}/api/v3/repos/${repo.full_name}/commits/${sha}` },
          protected: false,
        }));
        sendJson(res, 200, out);
        return true;
      }
      if (method === 'GET' && tail.length > 1) {
        const branch = tail.slice(1).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, {
          name: branch,
          commit: { sha, url: `${origin}/api/v3/repos/${repo.full_name}/commits/${sha}` },
          protected: false,
        });
        return true;
      }
    }

    // ---- commits ----
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const refParam = query.get('sha') ?? undefined;
      const start = resolveCommitSha(repo, refParam);
      if (start === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const { page, perPage } = pageParams(query);
      const views: Json[] = [];
      for (const row of listCommits(repo, start)) {
        const view = commitView(repo, row.sha, origin);
        if (view !== null) {
          view.url = `${origin}/api/v3/repos/${repo.full_name}/commits/${row.sha}`;
          view.html_url = `${origin}/${repo.full_name}/commit/${row.sha}`;
          const authorObj = view.author as Json;
          authorObj.login = VIEWER_LOGIN;
          views.push(view);
        }
      }
      const { slice, link } = paginate(views, origin, pathname, query, page, perPage);
      sendJson(res, 200, slice, link === null ? {} : { link });
      return true;
    }

    // ---- contents ----
    if (tail.length >= 1 && tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') {
        const refParam = query.get('ref') ?? undefined;
        const headSha = resolveCommitSha(repo, refParam);
        if (headSha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const parsed = getCommit(repo, headSha);
        if (parsed === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (path === '') {
          sendJson(res, 200, dirListing(repo, origin, parsed.tree, ''));
          return true;
        }
        const segments = path.split('/');
        const found = lookupPath(repo, parsed.tree, segments);
        if (found === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (found.mode === '40000') {
          sendJson(res, 200, dirListing(repo, origin, found.sha, path));
          return true;
        }
        sendJson(res, 200, fileView(repo, origin, path, found.sha));
        return true;
      }
      if (method === 'PUT') {
        if (path === '') {
          sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Content', field: 'path', code: 'missing_field' }]);
          return true;
        }
        const message = str(body.message) !== '' ? str(body.message) : `Update ${path}`;
        const contentB64 = str(body.content);
        let contentBytes: Buffer;
        try {
          contentBytes = Buffer.from(contentB64, 'base64');
        } catch {
          sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Content', field: 'content', code: 'invalid' }]);
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
        const headSha = repo.refs.get(`refs/heads/${branch}`);
        if (body.branch !== undefined && headSha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const flat = treeOfCommit(repo, headSha ?? null);
        const existing = flat.get(path);
        const isUpdate = existing !== undefined;
        if (isUpdate && typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.sha) {
          sendError(res, 409, 'Conflict');
          return true;
        }
        const { sha: blobSha, object: blobObj } = makeBlob(contentBytes);
        repo.objects.set(blobSha, blobObj);
        flat.set(path, { sha: blobSha, mode: '100644' });
        const treeSha = buildTreeFromFlat(repo, flat);
        const parents = headSha !== undefined ? [headSha] : [];
        const { sha: commitSha, object: commitObj } = makeCommit({
          tree: treeSha,
          parents,
          author: { name: VIEWER.name, email: VIEWER.email },
          message,
        });
        repo.objects.set(commitSha, commitObj);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.updated_at = nowIso();
        repo.pushed_at = nowIso();
        sendJson(res, isUpdate ? 200 : 201, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobSha,
            size: contentBytes.length,
            url: `${origin}/api/v3/repos/${repo.full_name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
            git_url: `${origin}/api/v3/repos/${repo.full_name}/git/blobs/${blobSha}`,
            html_url: `${origin}/${repo.full_name}/blob/${branch}/${path}`,
            download_url: `${origin}/${repo.full_name}/raw/${branch}/${path}`,
            type: 'file',
            encoding: 'base64',
          },
          commit: {
            sha: commitSha,
            node_id: `MDQ6Q29tbWl0${commitSha}`,
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
            tree: { sha: treeSha },
            parents: parents.map((p) => ({ sha: p })),
            url: `${origin}/api/v3/repos/${repo.full_name}/commits/${commitSha}`,
            html_url: `${origin}/${repo.full_name}/commit/${commitSha}`,
          },
        });
        return true;
      }
      if (method === 'DELETE') {
        if (path === '') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
        const headSha = repo.refs.get(`refs/heads/${branch}`);
        if (headSha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const flat = treeOfCommit(repo, headSha);
        const existing = flat.get(path);
        if (existing === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.sha) {
          sendError(res, 409, 'Conflict');
          return true;
        }
        const message = str(body.message) !== '' ? str(body.message) : `Delete ${path}`;
        flat.delete(path);
        const treeSha = buildTreeFromFlat(repo, flat);
        const { sha: commitSha, object: commitObj } = makeCommit({
          tree: treeSha,
          parents: [headSha],
          author: { name: VIEWER.name, email: VIEWER.email },
          message,
        });
        repo.objects.set(commitSha, commitObj);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.updated_at = nowIso();
        repo.pushed_at = nowIso();
        sendJson(res, 200, {
          content: null,
          commit: {
            sha: commitSha,
            node_id: `MDQ6Q29tbWl0${commitSha}`,
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: nowIso() },
            tree: { sha: treeSha },
            parents: [{ sha: headSha }],
            url: `${origin}/api/v3/repos/${repo.full_name}/commits/${commitSha}`,
            html_url: `${origin}/${repo.full_name}/commit/${commitSha}`,
          },
        });
        return true;
      }
    }

    // ---- labels ----
    if (tail.length >= 1 && tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => labelView(l, repo, origin)));
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        const name = str(body.name);
        if (name === '') {
          sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Label', field: 'name', code: 'missing_field' }]);
          return true;
        }
        const color = str(body.color) !== '' ? str(body.color) : 'ededed';
        const description = str(body.description);
        const existing = repo.labels.get(name);
        if (existing !== undefined) {
          existing.color = color;
          existing.description = description;
          sendJson(res, 201, labelView(existing, repo, origin));
          return true;
        }
        const label: Label = { id: repo.nextLabelId, name, color, description };
        repo.nextLabelId += 1;
        repo.labels.set(name, label);
        sendJson(res, 201, labelView(label, repo, origin));
        return true;
      }
      if (tail.length === 2) {
        const labelName = tail[1] as string;
        const label = repo.labels.get(labelName);
        if (method === 'GET') {
          if (label === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, labelView(label, repo, origin));
          return true;
        }
        if (method === 'PATCH') {
          if (label === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          const newName = typeof body.new_name === 'string' && body.new_name !== '' ? body.new_name : typeof body.name === 'string' && body.name !== '' ? body.name : label.name;
          if (typeof body.color === 'string') label.color = body.color;
          if (typeof body.description === 'string') label.description = body.description;
          if (newName !== label.name) {
            repo.labels.delete(label.name);
            label.name = newName;
            repo.labels.set(newName, label);
          }
          sendJson(res, 200, labelView(label, repo, origin));
          return true;
        }
        if (method === 'DELETE') {
          if (label === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          repo.labels.delete(labelName);
          sendNoContent(res);
          return true;
        }
      }
    }

    // ---- issues ----
    if (tail.length >= 1 && tail[0] === 'issues') {
      // /issues/{n}/comments
      if (tail.length === 3 && tail[2] === 'comments') {
        const n = Number(tail[1]);
        const issue = repo.issues.get(n);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          const { page, perPage } = pageParams(query);
          const views = issue.comments.map((c) => commentView(c, repo, issue.number, origin));
          const { slice, link } = paginate(views, origin, pathname, query, page, perPage);
          sendJson(res, 200, slice, link === null ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const text = str(body.body);
          if (text === '') {
            sendError(res, 422, 'Validation Failed', {}, [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }]);
            return true;
          }
          const now = nowIso();
          const comment = { id: repo.nextCommentId, body: text, user: VIEWER, created_at: now, updated_at: now };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          issue.updated_at = now;
          sendJson(res, 201, commentView(comment, repo, issue.number, origin));
          return true;
        }
      }
      // /issues/{n}
      if (tail.length === 2) {
        const n = Number(tail[1]);
        const issue = repo.issues.get(n);
        if (method === 'GET') {
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issueView(issue, repo, origin));
          return true;
        }
        if (method === 'PATCH') {
          if (issue === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.labels !== undefined) {
            const resolved = resolveLabels(repo, body.labels);
            if (resolved === null) {
              sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Issue', field: 'labels', code: 'invalid' }]);
              return true;
            }
            issue.labels = resolved;
          }
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closed_at = body.state === 'closed' ? nowIso() : null;
          }
          issue.updated_at = nowIso();
          sendJson(res, 200, issueView(issue, repo, origin));
          return true;
        }
      }
      // /issues (list / create)
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          const dir = direction === 'asc' ? 1 : -1;
          list.sort((a, b) => {
            let cmp = 0;
            if (sort === 'updated') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
            else if (sort === 'comments') cmp = a.comments.length - b.comments.length;
            else cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
            if (cmp === 0) cmp = a.number - b.number;
            return cmp * dir;
          });
          const { page, perPage } = pageParams(query);
          const views = list.map((i) => issueView(i, repo, origin));
          const { slice, link } = paginate(views, origin, pathname, query, page, perPage);
          sendJson(res, 200, slice, link === null ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const title = str(body.title);
          if (title === '') {
            sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Issue', field: 'title', code: 'missing_field' }]);
            return true;
          }
          let labels: Label[] = [];
          if (body.labels !== undefined) {
            const resolved = resolveLabels(repo, body.labels);
            if (resolved === null) {
              const bad = Array.isArray(body.labels) ? String((body.labels as unknown[])[0] ?? '') : '';
              sendError(res, 422, 'Validation Failed', {}, [{ resource: 'Issue', field: 'labels', code: 'invalid', value: bad }]);
              return true;
            }
            labels = resolved;
          }
          const now = nowIso();
          const issue: Issue = {
            id: repo.nextIssueId,
            number: repo.nextIssue,
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            user: VIEWER,
            labels,
            assignees: [],
            comments: [],
            created_at: now,
            updated_at: now,
            closed_at: null,
          };
          repo.nextIssueId += 1;
          repo.nextIssue += 1;
          repo.issues.set(issue.number, issue);
          sendJson(res, 201, issueView(issue, repo, origin));
          return true;
        }
      }
    }

    // ---- pulls ----
    if (tail.length >= 1 && tail[0] === 'pulls') {
      // /pulls/{n}/files
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const n = Number(tail[1]);
        const pull = repo.pulls.get(n);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pull.files);
        return true;
      }
      // /pulls/{n}/merge
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const n = Number(tail[1]);
        const pull = repo.pulls.get(n);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pull.state === 'closed') {
          sendError(res, 405, 'Pull request is already closed');
          return true;
        }
        const baseSha = resolveCommitSha(repo, pull.baseRef) ?? pull.baseSha;
        const headSha = resolveCommitSha(repo, pull.headRef) ?? pull.headSha;
        if (isConflicted(repo, baseSha, headSha)) {
          sendError(res, 405, 'Merge conflict');
          return true;
        }
        const headParsed = getCommit(repo, headSha);
        if (headParsed === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
        const { sha: mergeSha, object: mergeObj } = makeCommit({
          tree: headParsed.tree,
          parents: [baseSha, headSha],
          author: { name: VIEWER.name, email: VIEWER.email },
          message,
        });
        repo.objects.set(mergeSha, mergeObj);
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        const now = nowIso();
        pull.state = 'closed';
        pull.merged = true;
        pull.mergeCommitSha = mergeSha;
        pull.mergedAt = now;
        pull.closed_at = now;
        pull.updated_at = now;
        pull.headSha = headSha;
        pull.baseSha = baseSha;
        repo.updated_at = now;
        repo.pushed_at = now;
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      // /pulls/{n}
      if (tail.length === 2 && method === 'GET') {
        const n = Number(tail[1]);
        const pull = repo.pulls.get(n);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullView(pull, repo, origin, store));
        return true;
      }
      // /pulls (list / create)
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          const { page, perPage } = pageParams(query);
          const views = list.map((p) => pullView(p, repo, origin, store));
          const { slice, link } = paginate(views, origin, pathname, query, page, perPage);
          sendJson(res, 200, slice, link === null ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const title = str(body.title);
          const headRef = str(body.head);
          const baseRef = str(body.base);
          if (title === '' || headRef === '' || baseRef === '') {
            sendError(res, 422, 'Validation Failed', {}, [{ resource: 'PullRequest', field: 'head', code: 'missing_field' }]);
            return true;
          }
          const headSha = resolveCommitSha(repo, headRef);
          const baseSha = resolveCommitSha(repo, baseRef);
          if (headSha === undefined || baseSha === undefined) {
            sendError(res, 422, 'Validation Failed', {}, [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]);
            return true;
          }
          const diff = pullFiles(repo, baseSha, headSha);
          const now = nowIso();
          const pull: Pull = {
            id: repo.nextPullId,
            number: repo.nextPull,
            title,
            body: typeof body.body === 'string' ? body.body : '',
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
            changedFiles: diff.files.length,
            commits: commitsAhead(repo, baseSha, headSha),
            mergeable: !isConflicted(repo, baseSha, headSha),
          };
          repo.nextPullId += 1;
          repo.nextPull += 1;
          repo.pulls.set(pull.number, pull);
          sendJson(res, 201, pullView(pull, repo, origin, store));
          return true;
        }
      }
    }
  }

  // Inside the surface but no route matched: JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}

/** Resolve a labels input (string names or {name} objects) to Label objects; null when any is unknown. */
function resolveLabels(repo: Repo, input: unknown): Label[] | null {
  if (!Array.isArray(input)) return null;
  const out: Label[] = [];
  for (const item of input) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? str((item as Json).name) : '';
    const label = repo.labels.get(name);
    if (label === undefined) return null;
    out.push(label);
  }
  return out;
}
