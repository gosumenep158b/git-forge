// server.ts — the one HTTP server all four surfaces share.
//
//   GET  /healthz            boot probe, unauthenticated
//   /api/v3(, /meta)         REST root, public like api.github.com
//   /api/v3/*                REST surface, bearer-gated
//   /{owner}/{repo}.git/...  git smart HTTP, bearer-gated
//   POST /api/graphql        GraphQL, bearer-gated
//   /mcp                     MCP, does its own auth
//
// Every reply carries a non-empty X-GitHub-Request-Id; every failure is JSON, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Forge } from './model.ts';
import { Router, bearerOf, jsonReply, readBody, type Ctx, type Reply } from './webkernel.ts';
import { installRest } from './restapi.ts';
import { infoRefs, uploadPack, receivePack, type RawReply } from './gitsmart.ts';
import { handleGraphql } from './gqlapi.ts';
import { handleMcp } from './mcpapi.ts';

const VIEWER = process.env.MAKEFUN_OWNER ?? 'adaiversen';
const forge = new Forge(VIEWER);

const router = new Router();
installRest(forge, router);

const mcpSessions = new Set<string>();

// ---------------------------------------------------------------- plumbing

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

async function buildCtx(req: IncomingMessage, res: ServerResponse): Promise<Ctx> {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'entry';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const body = await readBody(req);
  return {
    req,
    res,
    url,
    method: req.method ?? 'GET',
    params: {},
    query: url.searchParams,
    body,
    json<T>(): T | undefined {
      if (body.length === 0) return undefined;
      try {
        return JSON.parse(body.toString('utf8')) as T;
      } catch {
        return undefined;
      }
    },
  };
}

function send(ctx: Ctx, reply: Reply): void {
  const headers: Record<string, string> = {
    'x-github-request-id': randomUUID().replace(/-/g, '').slice(0, 16),
    ...reply.headers,
  };
  if (reply.status === 204) {
    ctx.res.writeHead(204, headers);
    ctx.res.end();
    return;
  }
  const body = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body as Uint8Array);
  headers['content-length'] = String(body.length);
  ctx.res.writeHead(reply.status, headers);
  ctx.res.end(body);
}

function gitReply(reply: RawReply): Reply {
  return {
    status: reply.status,
    headers: {
      'content-type': reply.contentType,
      'cache-control': 'no-cache, max-age=0, must-revalidate',
      pragma: 'no-cache',
      expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    },
    body: reply.body,
  };
}

function fail(ctx: Ctx, status: number, message: string): void {
  const reply = jsonReply(status, { message });
  if (status === 401) reply.headers = { ...reply.headers, 'www-authenticate': 'Basic realm="forge"' };
  send(ctx, reply);
}

/** `Git-Protocol: version=2` promotes upload-pack to protocol v2. */
const wantsV2 = (req: IncomingMessage): boolean => req.headers['git-protocol'] === 'version=2';

/** Split `/{owner}/{repo}.git/{tail}`; null when it is not a git URL. */
function gitPath(path: string): { owner: string; repo: string; tail: string } | null {
  const hit = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}?\.git)(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/.exec(path);
  if (hit === null) return null;
  return { owner: hit[1]!, repo: hit[2]!.slice(0, -4), tail: hit[3]! };
}

// ---------------------------------------------------------------- dispatch

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = await buildCtx(req, res);
  const path = pathOf(req);
  const method = ctx.method;

  if (method === 'GET' && path === '/healthz') {
    send(ctx, jsonReply(200, { ok: true }));
    return;
  }

  // Public REST root and meta (api.github.com is anonymous there too).
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta')) {
    const matched = router.match(method, path === '/api/v3' ? '/api/v3/' : path);
    if (matched !== null) {
      ctx.params = matched.params;
      send(ctx, await matched.handler(ctx));
      return;
    }
  }

  // MCP authenticates itself.
  if (path === '/mcp') {
    send(ctx, handleMcp(forge, ctx, mcpSessions));
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      fail(ctx, 405, 'Method Not Allowed');
      return;
    }
    send(ctx, handleGraphql(forge, ctx));
    return;
  }

  const git = gitPath(path);
  if (git !== null) {
    if (bearerOf(req) === null) {
      fail(ctx, 401, 'Requires authentication');
      return;
    }
    if (git.tail === '/info/refs') {
      send(ctx, gitReply(infoRefs(forge, git.owner, git.repo, ctx.query.get('service') ?? 'git-upload-pack', wantsV2(req))));
      return;
    }
    if (git.tail === '/git-upload-pack') {
      send(ctx, gitReply(uploadPack(forge, git.owner, git.repo, ctx.body, wantsV2(req))));
      return;
    }
    send(ctx, gitReply(receivePack(forge, git.owner, git.repo, ctx.body)));
    return;
  }

  const matched = router.match(method, path);
  if (matched !== null) {
    if (bearerOf(req) === null) {
      fail(ctx, 401, 'Requires authentication');
      return;
    }
    ctx.params = matched.params;
    send(ctx, await matched.handler(ctx));
    return;
  }

  fail(ctx, 404, 'Not Found');
}

/** Build the server; the caller picks the port and listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    dispatch(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(`${JSON.stringify({ message })}\n`);
      } catch {
        // The socket may already be gone.
      }
    });
  });
}
