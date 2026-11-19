// gqlapi.ts — GraphQL v4 at POST /api/graphql: a tokenizer + selection-set reader and an
// executor over the Forge. Documents come from gh and github-mcp-server, so the surface
// supports viewer, repository (+issues/issue/pullRequests/pullRequest), __type introspection
// with gh's aliases, node(id:), the create/close/merge/addComment mutations, inline arguments,
// variables, and batched bodies (a JSON array answered in order).

import type { Forge, IssueRecord, PullRecord, RepoRecord } from './model.ts';
import { jsonReply, type Ctx, type Reply } from './webkernel.ts';

type Json = Record<string, unknown>;

interface GqlError { message: string }

/** Relay-style opaque id: base64 of `Kind:numericId`. */
function encodeGid(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

function decodeGid(id: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const numeric = Number.parseInt(text.slice(colon + 1), 10);
    if (!Number.isFinite(numeric)) return null;
    return { kind: text.slice(0, colon), id: numeric };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- parsing

interface Field {
  name: string;
  alias: string;
  args: Json;
  selections: Field[];
}

interface Doc { op: 'query' | 'mutation'; selections: Field[] }

const NAME_RE = /[A-Za-z0-9_$]/;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (/\s/.test(char)) { at += 1; continue; }
    if (char === '#') { while (at < text.length && text[at] !== '\n') at += 1; continue; }
    if (char === '"') {
      if (text.slice(at, at + 3) === '"""') {
        const end = text.indexOf('"""', at + 3);
        tokens.push(text.slice(at, end === -1 ? text.length : end + 3));
        at = end === -1 ? text.length : end + 3;
        continue;
      }
      let end = at + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '"') break;
        end += 1;
      }
      tokens.push(text.slice(at, Math.min(end + 1, text.length)));
      at = end + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = at + 1;
      while (end < text.length && NAME_RE.test(text[end]!)) end += 1;
      tokens.push(text.slice(at, end));
      at = end;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = at + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end]!)) end += 1;
      tokens.push(text.slice(at, end));
      at = end;
      continue;
    }
    tokens.push(char);
    at += 1;
  }
  return tokens;
}

function readValue(tokens: string[], position: number, variables: Json): { value: unknown; next: number } | null {
  let at = position;
  const token = tokens[at];
  if (token === undefined) return null;
  if (token === '$' || token.startsWith('$')) {
    const name = token.startsWith('$') ? token.slice(1) : tokens[at + 1];
    at += token.startsWith('$') ? 1 : 2;
    const value = name === undefined ? null : variables[name];
    return { value: value === undefined ? null : value, next: at };
  }
  if (token === '[') {
    at += 1;
    const list: unknown[] = [];
    while (at < tokens.length && tokens[at] !== ']') {
      const item = readValue(tokens, at, variables);
      if (item === null) return null;
      list.push(item.value);
      at = item.next;
    }
    return { value: list, next: at + 1 };
  }
  if (token === '{') {
    at += 1;
    const object: Json = {};
    while (at < tokens.length && tokens[at] !== '}') {
      const key = tokens[at];
      if (key === undefined || key === ':' || key === ',') { at += 1; continue; }
      at += 1;
      if (tokens[at] === ':') at += 1;
      const item = readValue(tokens, at, variables);
      if (item === null) return null;
      object[key] = item.value;
      at = item.next;
    }
    return { value: object, next: at + 1 };
  }
  if (token.startsWith('"')) {
    const text = token.slice(1, -1);
    return {
      value: text.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\'),
      next: at + 1,
    };
  }
  if (token === 'true') return { value: true, next: at + 1 };
  if (token === 'false') return { value: false, next: at + 1 };
  if (token === 'null') return { value: null, next: at + 1 };
  if (/^-?\d+(\.\d+)?$/.test(token)) return { value: Number.parseFloat(token), next: at + 1 };
  return { value: token, next: at + 1 }; // enum or bare word
}

function readSelections(tokens: string[], position: number, variables: Json): { fields: Field[]; next: number } | null {
  let at = position;
  if (tokens[at] !== '{') return null;
  at += 1;
  const fields: Field[] = [];
  while (at < tokens.length && tokens[at] !== '}') {
    const token = tokens[at]!;
    if (token === '...' || token === 'on') {
      if (token === '...') at += 1;
      if (tokens[at] === 'on') at += 1;
      if (tokens[at] !== undefined && tokens[at] !== '{') at += 1;
      const nested = readSelections(tokens, at, variables);
      if (nested === null) return null;
      fields.push(...nested.fields);
      at = nested.next;
      continue;
    }
    let name = token;
    at += 1;
    let alias = name;
    if (tokens[at] === ':') {
      alias = name;
      name = tokens[at + 1]!;
      at += 2;
    }
    const args: Json = {};
    if (tokens[at] === '(') {
      at += 1;
      while (at < tokens.length && tokens[at] !== ')') {
        const key = tokens[at]!;
        if (key === ',' || key === ':') { at += 1; continue; }
        at += 1;
        if (tokens[at] === ':') at += 1;
        const item = readValue(tokens, at, variables);
        if (item === null) return null;
        args[key] = item.value;
        at = item.next;
      }
      at += 1;
    }
    let selections: Field[] = [];
    if (tokens[at] === '{') {
      const nested = readSelections(tokens, at, variables);
      if (nested === null) return null;
      selections = nested.fields;
      at = nested.next;
    }
    fields.push({ name, alias, args, selections });
  }
  return { fields, next: at + 1 };
}

function parseDoc(query: string, variables: Json): Doc | null {
  const tokens = tokenize(query);
  let at = 0;
  let op: 'query' | 'mutation' = 'query';
  while (at < tokens.length) {
    const token = tokens[at]!;
    if (token === 'query' || token === 'mutation') {
      op = token;
      at += 1;
      // Optional operation name and variable-definition list.
      if (tokens[at] !== undefined && /^[A-Za-z_]/.test(tokens[at]!) && tokens[at] !== '{') at += 1;
      if (tokens[at] === '(') {
        let depth = 0;
        while (at < tokens.length) {
          if (tokens[at] === '(') depth += 1;
          if (tokens[at] === ')') {
            depth -= 1;
            if (depth === 0) { at += 1; break; }
          }
          at += 1;
        }
      }
      continue;
    }
    if (token === '{') {
      const parsed = readSelections(tokens, at, variables);
      if (parsed === null) return null;
      return { op, selections: parsed.fields };
    }
    at += 1; // fragment definitions and stray tokens
  }
  return null;
}

// -------------------------------------------------------------------- schema

const ISSUE_FIELDS = ['body', 'closedAt', 'createdAt', 'id', 'labels', 'number', 'repository', 'state', 'title', 'updatedAt', 'url', 'author', 'comments'];
const USER_FIELDS = ['login', 'name', 'id', 'databaseId', 'url', 'avatarUrl', 'email', 'bio', 'createdAt', 'updatedAt'];
const PULL_FIELDS = ['baseRefName', 'body', 'createdAt', 'files', 'headRefName', 'id', 'mergeable', 'merged', 'mergedAt', 'number', 'repository', 'state', 'title', 'url', 'author'];
const REPO_FIELDS = ['createdAt', 'databaseId', 'defaultBranchRef', 'description', 'hasIssuesEnabled', 'id', 'isPrivate', 'issue', 'issues', 'name', 'nameWithOwner', 'owner', 'pullRequest', 'pullRequests', 'updatedAt', 'url', 'viewerPermission'];
const SEARCH_ENUMS = ['DISCUSSION', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'];

function issueOf(issue: IssueRecord, forge: Forge): Json {
  return {
    id: encodeGid('Issue', issue.gid),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    author: { login: forge.viewerLogin },
    createdAt: new Date(issue.createdAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    updatedAt: new Date(issue.updatedAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    closedAt: issue.closedAt === null ? null : new Date(issue.closedAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    url: '',
    comments: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } },
    labels: { nodes: [], totalCount: 0 },
  };
}

function pullOf(pull: PullRecord, forge: Forge): Json {
  return {
    id: encodeGid('PullRequest', pull.gid),
    number: pull.number,
    title: pull.title,
    state: pull.state === 'open' ? 'OPEN' : (pull.merged ? 'MERGED' : 'CLOSED'),
    body: pull.body,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.mergeable === 'CONFLICTING' ? 'CONFLICTING' : 'MERGEABLE',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    author: { login: forge.viewerLogin },
    createdAt: new Date(pull.createdAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    url: '',
  };
}

// ------------------------------------------------------------------ projection

const EMPTY_SEL: Field = { name: 'nodes', alias: 'nodes', args: {}, selections: [] };

function project(node: Json, field: Field): Json {
  if (field.selections.length === 0) return node;
  const out: Json = {};
  for (const sub of field.selections) {
    if (sub.name === 'nodes') {
      const list = node.nodes;
      out.nodes = Array.isArray(list) ? list.map((entry) => project(entry as Json, sub)) : null;
      continue;
    }
    const value = node[sub.name];
    out[sub.alias] = value === undefined ? null : value;
  }
  return out;
}

function cursorAt(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function cursorFrom(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const value = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function repoByGid(forge: Forge, id: string): RepoRecord | undefined {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'Repository') return undefined;
  return [...forge.repos.values()].find((candidate) => candidate.id === decoded.id);
}

function issueByGid(forge: Forge, id: string): { repo: RepoRecord; issue: IssueRecord } | undefined {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'Issue') return undefined;
  for (const repo of forge.repos.values()) {
    const issue = repo.issues.find((candidate) => candidate.gid === decoded.id);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function pullByGid(forge: Forge, id: string): { repo: RepoRecord; pull: PullRecord } | undefined {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return undefined;
  for (const repo of forge.repos.values()) {
    const pull = repo.pulls.find((candidate) => candidate.gid === decoded.id);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

/** `issues(first, after, states, orderBy)`: filter, order, page, project. */
function issuesConnection(forge: Forge, repo: RepoRecord, field: Field): Json {
  const states = Array.isArray(field.args.states) ? (field.args.states as string[]) : null;
  let list = repo.issues.slice();
  if (states !== null) {
    if (!states.includes('OPEN')) list = list.filter((issue) => issue.state !== 'open');
    if (!states.includes('CLOSED')) list = list.filter((issue) => issue.state !== 'closed');
  }
  const orderBy = (field.args.orderBy ?? {}) as Json;
  const direction = String(orderBy.direction ?? 'ASC');
  const field2 = String(orderBy.field ?? 'CREATED_AT');
  list = [...list].sort((a, b) => {
    const primary = field2 === 'UPDATED_AT' ? a.updatedAt - b.updatedAt : a.createdAt - b.createdAt;
    if (primary !== 0) return direction === 'DESC' ? -primary : primary;
    // Ties break by number, following the same direction.
    return direction === 'DESC' ? b.number - a.number : a.number - b.number;
  });
  const first = Number(field.args.first ?? 30);
  const after = cursorFrom(field.args.after);
  const start = after === null ? 0 : after + 1;
  const pageList = list.slice(start, start + first);
  const end = start + pageList.length - 1;
  const nodesSel = field.selections.find((sub) => sub.name === 'nodes');
  return {
    nodes: pageList.map((issue) => project(issueOf(issue, forge), nodesSel ?? EMPTY_SEL)),
    pageInfo: { hasNextPage: end < list.length - 1, endCursor: pageList.length === 0 ? null : cursorAt(end) },
    totalCount: list.length,
  };
}

function resolveRepoField(forge: Forge, repo: RepoRecord, field: Field): Json {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const node: Json = {
    id: encodeGid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    defaultBranchRef: tip === undefined ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.isPrivate,
    createdAt: new Date(repo.createdAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    updatedAt: new Date(repo.updatedAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    url: '',
    issue: null,
    issues: null,
    pullRequest: null,
    pullRequests: null,
  };
  for (const sub of field.selections) {
    switch (sub.name) {
      case 'issues': {
        node.issues = issuesConnection(forge, repo, sub);
        break;
      }
      case 'issue': {
        const number = Number(sub.args.number);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        node.issue = issue === undefined ? null : project(issueOf(issue, forge), sub);
        break;
      }
      case 'pullRequests': {
        const first = Number(sub.args.first ?? 20);
        const open = repo.pulls.filter((pull) => pull.state === 'open').slice(0, first);
        const nodesSel = sub.selections.find((inner) => inner.name === 'nodes');
        node.pullRequests = {
          nodes: open.map((pull) => project(pullOf(pull, forge), nodesSel ?? EMPTY_SEL)),
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: open.length,
        };
        break;
      }
      case 'pullRequest': {
        const number = Number(sub.args.number);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (pull === undefined) { node.pullRequest = null; break; }
        const pullJson = pullOf(pull, forge);
        const files = forge.pullDiffs(repo, pull).slice(0, 10);
        pullJson.files = { nodes: files.map((file) => ({ path: file.filename })), pageInfo: { hasNextPage: false, endCursor: null } };
        node.pullRequest = project(pullJson, sub);
        break;
      }
      default:
        break;
    }
  }
  return node;
}

// ------------------------------------------------------------------- executor

function resolveField(forge: Forge, field: Field, op: 'query' | 'mutation', errors: GqlError[]): unknown {
  switch (field.name) {
    case 'viewer': {
      for (const sub of field.selections) {
        if (!USER_FIELDS.includes(sub.name)) {
          errors.push({ message: `Field '${sub.name}' doesn't exist on type 'User'` });
        }
      }
      return {
        login: forge.viewerLogin,
        name: forge.viewerLogin,
        id: encodeGid('User', 1000),
        databaseId: 1000,
        url: '',
        avatarUrl: '',
        email: '',
        bio: '',
      };
    }
    case '__typename':
      return op === 'mutation' ? 'Mutation' : 'Query';
    case '__type': {
      const name = String(field.args.name ?? '');
      if (name === 'Issue') return { name: 'Issue', fields: ISSUE_FIELDS.map((entry) => ({ name: entry })), enumValues: null };
      if (name === 'PullRequest') return { name: 'PullRequest', fields: PULL_FIELDS.map((entry) => ({ name: entry })), enumValues: null };
      if (name === 'Repository') return { name: 'Repository', fields: REPO_FIELDS.map((entry) => ({ name: entry })), enumValues: null };
      if (name === 'SearchType') return { name: 'SearchType', fields: null, enumValues: SEARCH_ENUMS.map((entry) => ({ name: entry })) };
      return null;
    }
    case 'node': {
      const decoded = decodeGid(String(field.args.id ?? ''));
      if (decoded === null) {
        errors.push({ message: `Could not resolve to a node with the global id of '${String(field.args.id ?? '')}'` });
        return null;
      }
      if (decoded.kind === 'Repository') {
        const repo = [...forge.repos.values()].find((candidate) => candidate.id === decoded.id);
        if (repo === undefined) return null;
        return { id: encodeGid('Repository', repo.id), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` };
      }
      return null;
    }
    case 'repository': {
      const owner = String(field.args.owner ?? forge.viewerLogin);
      const name = String(field.args.name ?? '');
      const repo = forge.getRepo(owner, name);
      if (repo === undefined || repo.owner !== owner) return null;
      return resolveRepoField(forge, repo, field);
    }
    case 'createIssue': {
      const input = (field.args.input ?? {}) as Json;
      const repo = repoByGid(forge, String(input.repositoryId ?? ''));
      if (repo === undefined) {
        errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
        return { issue: null };
      }
      const issue = forge.addIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { issue: { number: issue.number, id: encodeGid('Issue', issue.gid) } };
    }
    case 'closeIssue': {
      const input = (field.args.input ?? {}) as Json;
      const located = issueByGid(forge, String(input.issueId ?? ''));
      if (located === undefined) {
        errors.push({ message: 'Could not resolve to a node with the global id of the issue' });
        return { issue: null };
      }
      located.issue.state = 'closed';
      located.issue.closedAt = forge.tick();
      located.issue.updatedAt = forge.tick();
      return { issue: { number: located.issue.number, id: encodeGid('Issue', located.issue.gid), state: 'CLOSED' } };
    }
    case 'createPullRequest': {
      const input = (field.args.input ?? {}) as Json;
      const repo = repoByGid(forge, String(input.repositoryId ?? ''));
      if (repo === undefined) {
        errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
        return { pullRequest: null };
      }
      const result = forge.openPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (typeof result === 'string') {
        errors.push({ message: result });
        return { pullRequest: null };
      }
      return {
        pullRequest: {
          number: result.number,
          id: encodeGid('PullRequest', result.gid),
          state: 'OPEN',
          headRefName: result.headRef,
          baseRefName: result.baseRef,
        },
      };
    }
    case 'mergePullRequest': {
      const input = (field.args.input ?? {}) as Json;
      const located = pullByGid(forge, String(input.pullRequestId ?? ''));
      if (located === undefined) {
        errors.push({ message: 'Could not resolve to a node with the global id of the pull request' });
        return { pullRequest: null };
      }
      const result = forge.mergePull(located.repo, located.pull);
      if (!result.ok) {
        errors.push({ message: result.reason });
        return { pullRequest: null };
      }
      return { pullRequest: { number: located.pull.number, merged: true, state: 'MERGED' } };
    }
    case 'addComment': {
      const input = (field.args.input ?? {}) as Json;
      const located = issueByGid(forge, String(input.subjectId ?? ''));
      if (located === undefined) {
        errors.push({ message: 'Could not resolve to a node with the global id of the subject' });
        return { commentEdge: { node: null } };
      }
      const comment = forge.addComment(located.repo, located.issue, String(input.body ?? ''));
      return { commentEdge: { node: { id: encodeGid('IssueComment', comment.gid), body: comment.body } } };
    }
    default:
      errors.push({ message: `Field '${field.name}' does not exist on type '${op === 'mutation' ? 'Mutation' : 'Query'}'` });
      return null;
  }
}

function validateDoc(query: unknown): GqlError | null {
  if (typeof query !== 'string' || query.trim() === '') {
    return { message: 'A query attribute must be specified and must be a string' };
  }
  const braces = (query.match(/\{/g) ?? []).length - (query.match(/\}/g) ?? []).length;
  if (braces !== 0) return { message: 'Syntax error: unbalanced braces in the document' };
  return null;
}

function runOne(forge: Forge, request: Json): Json {
  const invalid = validateDoc(request.query);
  if (invalid !== null) return { errors: [invalid] };
  const variables = (request.variables ?? {}) as Json;
  const parsed = parseDoc(String(request.query), variables);
  if (parsed === null) return { errors: [{ message: 'Syntax error: the document does not parse' }] };
  const errors: GqlError[] = [];
  const data: Json = {};
  for (const field of parsed.selections) {
    data[field.alias] = resolveField(forge, field, parsed.op, errors);
  }
  return errors.length > 0 ? { data, errors } : { data };
}

/** POST /api/graphql — bearer gate, then one envelope or a batch answered in order. */
export function handleGraphql(forge: Forge, ctx: Ctx): Reply {
  const auth = ctx.req.headers.authorization;
  if (typeof auth !== 'string' || !/^Bearer\s+\S+/.test(auth.trim())) {
    return jsonReply(401, { message: 'Bad credentials' });
  }
  const body = ctx.json<unknown>();
  if (body === undefined || body === null || typeof body !== 'object') {
    return jsonReply(400, { message: 'Problems parsing JSON' });
  }
  if (Array.isArray(body)) {
    return jsonReply(200, body.map((entry) => runOne(forge, (entry ?? {}) as Json)));
  }
  return jsonReply(200, runOne(forge, body as Json));
}
