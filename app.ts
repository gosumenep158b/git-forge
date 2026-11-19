// The forge's HTTP surface: the lifecycle routes (health probe, API root) plus the
// four scored surfaces, each in its own module sharing one Store.
//
// Routing order: /healthz and the /api/v3/ root are answered here; everything else
// is offered to each surface handler in turn (git smart HTTP, REST v3, GraphQL v4,
// MCP). A handler returns true when the path is its own, even when it answers 404
// or 401 inside its surface. Anything no handler claims is GitHub's JSON 404.
//
// Erasable TypeScript only (node --experimental-strip-types). Node builtins only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store, newRequestId, originOf } from './src/store.ts';
import { handleGit } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const origin = originOf(req.headers.host);
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No token.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        if (await handleGit(req, res, store, origin)) return;
        if (await handleRest(req, res, store, origin)) return;
        if (await handleGraphql(req, res, store, origin)) return;
        if (await handleMcp(req, res, store, origin)) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else if (!res.writableEnded) res.end();
      }
    })();
  });
}
