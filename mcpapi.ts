// mcpapi.ts — MCP at POST /mcp, JSON-RPC 2.0 over Streamable HTTP.
//
// Two eras: the modern 2026-07-28 revision (server/discover answers supportedVersions, every
// request declares _meta) and the legacy handshake (initialize + notifications/initialized,
// optional Mcp-Session-Id). Six tools act on the same Forge the REST surface serves, so ids
// match across reads. All replies are application/json; every answer lands within 3 seconds
// because nothing here blocks.

import type { Forge, RepoRecord } from './model.ts';
import { jsonReply, type Ctx, type Reply } from './webkernel.ts';

const REVISION = '2026-07-28';
const SERVER_NAME = 'r4-forge-mcp';
const SERVER_VERSION = '1.0.0';
const KNOWN_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DISCOVER_VERSIONS = [REVISION, '2025-11-25', '2025-06-18'];

type Json = Record<string, unknown>;

const PARSE_ERROR = -32700;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

function rpcResult(id: unknown, result: Json): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id, error: { code, message } });
}

// ---------------------------------------------------------------- tool catalogue

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, Json>;
  required: string[];
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'The repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by its owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository with a title and optional body.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'open, closed or all (default open)' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch' },
      base: { type: 'string', description: 'The base branch' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request on the base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

// Byte-stable listing: two tools/list answers must be identical, so this serializes once.
const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
});

function textResult(value: unknown, isError = false): Json {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

// ------------------------------------------------------------------ tool calls

function findRepo(forge: Forge, owner: unknown, repo: unknown): RepoRecord | undefined {
  if (typeof owner !== 'string' || typeof repo !== 'string') return undefined;
  const found = forge.getRepo(owner, repo);
  return found !== undefined && found.owner === owner ? found : undefined;
}

function runTool(forge: Forge, name: string, args: Json): Json {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') return textResult('create_repo needs a name', true);
      if (forge.getRepo(forge.viewerLogin, repoName) !== undefined) {
        return textResult(`repository ${repoName} already exists`, true);
      }
      const repo = forge.createRepo(forge.viewerLogin, repoName, {
        private: args.private === undefined ? true : args.private === true,
        description: typeof args.description === 'string' ? args.description : null,
      });
      return textResult({
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.isPrivate,
        id: repo.id,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === undefined) return textResult(`repository ${String(args.owner)}/${String(args.repo)} not found`, true);
      return textResult({
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        id: repo.id,
      });
    }
    case 'create_issue': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === undefined) return textResult(`repository ${String(args.owner)}/${String(args.repo)} not found`, true);
      if (typeof args.title !== 'string' || args.title === '') return textResult('create_issue needs a title', true);
      const issue = forge.addIssue(repo, { title: args.title, body: typeof args.body === 'string' ? args.body : '' });
      return textResult({ number: issue.number, title: issue.title, state: issue.state, id: issue.gid });
    }
    case 'list_issues': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === undefined) return textResult(`repository ${String(args.owner)}/${String(args.repo)} not found`, true);
      const state = args.state === 'closed' || args.state === 'all' ? args.state : 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return textResult(list.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state })));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === undefined) return textResult(`repository ${String(args.owner)}/${String(args.repo)} not found`, true);
      for (const field of ['title', 'head', 'base'] as const) {
        if (typeof args[field] !== 'string' || args[field] === '') return textResult(`create_pull_request needs ${field}`, true);
      }
      const result = forge.openPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if (typeof result === 'string') return textResult(result, true);
      return textResult({ number: result.number, state: result.state, head: result.headRef, base: result.baseRef, id: result.gid });
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === undefined) return textResult(`repository ${String(args.owner)}/${String(args.repo)} not found`, true);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return textResult(`pull request ${String(args.pull_number)} not found`, true);
      const result = forge.mergePull(repo, pull);
      if (!result.ok) return textResult(result.reason, true);
      return textResult({ merged: true, sha: result.sha, number: pull.number });
    }
    default:
      return textResult(`unknown tool ${name}`, true);
  }
}

function validateArgs(name: string, args: Json): number | null {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return null;
  for (const field of tool.required) {
    const value = args[field];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      return INVALID_PARAMS;
    }
  }
  return null;
}

// ------------------------------------------------------------------- transport

/**
 * POST /mcp. Auth first (401 without a bearer); then the JSON-RPC surface:
 * server/discover, initialize/initialized handshake, tools/list (byte-stable), tools/call,
 * ping, and the parse-error / unknown-method paths. Session ids echo the client's header
 * when present; otherwise one minted earlier is offered back.
 */
export function handleMcp(forge: Forge, ctx: Ctx, sessions: Set<string>): Reply {
  const auth = ctx.req.headers.authorization;
  if (typeof auth !== 'string' || !/^Bearer\s+\S+/.test(auth.trim())) {
    return jsonReply(401, { message: 'Bad credentials' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: the body is not JSON' } });
  }

  const sessionHeader = ctx.req.headers['mcp-session-id'];
  if (typeof sessionHeader === 'string' && sessionHeader !== '') sessions.add(sessionHeader);

  const headers: Record<string, string> = {};
  const token = sessions.values().next().value as string | undefined;
  if (token !== undefined) headers['mcp-session-id'] = token;

  const request = parsed as Json;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';

  switch (method) {
    case 'server/discover': {
      const reply = rpcResult(id, {
        resultType: 'discover',
        supportedVersions: DISCOVER_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests as MCP tools.',
      });
      return { ...reply, headers: { ...reply.headers, ...headers } };
    }
    case 'initialize': {
      const params = (request.params ?? {}) as Json;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
      const negotiated = KNOWN_REVISIONS.includes(requested) ? requested : REVISION;
      const reply = jsonReply(200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return { ...reply, headers: { ...reply.headers, ...headers } };
    }
    case 'notifications/initialized':
      return { status: 202, body: Buffer.alloc(0), headers };
    case 'tools/list': {
      const body2 = Buffer.from(TOOLS_LIST_JSON);
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: body2 };
    }
    case 'tools/call': {
      const params = (request.params ?? {}) as Json;
      const name = typeof params.name === 'string' ? params.name : '';
      if (name === '') return rpcError(id, INVALID_PARAMS, 'tools/call needs a tool name');
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, METHOD_NOT_FOUND, `tool ${name} does not exist`);
      }
      const args = (params.arguments ?? {}) as Json;
      const invalid = validateArgs(name, args);
      if (invalid !== null) return rpcError(id, invalid, `tools/call ${name} is missing a required argument`);
      try {
        return rpcResult(id, runTool(forge, name, args));
      } catch (error) {
        return rpcResult(id, textResult(error instanceof Error ? error.message : String(error), true));
      }
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, METHOD_NOT_FOUND, `method ${method || '(none)'} does not exist`);
  }
}
