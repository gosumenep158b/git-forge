// webkernel.ts — the small HTTP layer every surface rides on: a router, the request
// context, JSON/text reply helpers, bearer parsing, and GitHub-style Link pagination.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Buffer;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  json<T>(): T | undefined;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string | Uint8Array;
}

export type RouteHandler = (ctx: Ctx) => Reply | Promise<Reply>;

export function jsonReply(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

export function textReply(status: number, value: string, headers: Record<string, string> = {}): Reply {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body: value };
}

// -------------------------------------------------------------------- routing

interface Route { method: string; regex: RegExp; names: string[]; handler: RouteHandler }

function compile(pattern: string): { regex: RegExp; names: string[] } {
  // A trailing `*` swallows the rest of the path, slashes included.
  if (pattern.endsWith('*')) {
    const prefix = compile(pattern.slice(0, -1).replace(/\/$/, ''));
    const inner = prefix.regex.source.slice(2, -1);
    return { regex: new RegExp(`^${inner}/?(.+)$`), names: [...prefix.names, '*'] };
  }
  const names: string[] = [];
  const body = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${body}$`), names };
}

export class Router {
  readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const compiled = compile(pattern);
    this.routes.push({ method, regex: compiled.regex, names: compiled.names, handler });
  }

  match(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const hit = route.regex.exec(path);
      if (hit === null) continue;
      const params: Record<string, string> = {};
      route.names.forEach((name, index) => { params[name] = decodeURIComponent(hit[index + 1]!); });
      return { handler: route.handler, params };
    }
    return null;
  }
}

// ----------------------------------------------------------------------- auth

/** The token from `Authorization: Bearer …`, or null when absent or malformed. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const hit = /^Bearer\s+(.+)$/i.exec(header.trim());
  return hit === null ? null : hit[1]!.trim();
}

// ------------------------------------------------------------------------ I/O

export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ----------------------------------------------------------------- pagination

/** GitHub's Link header: next/last going forward, prev/first once past page 1. */
export function linkHeader(url: URL, page: number, perPage: number, total: number, path: string): Record<string, string> {
  const last = Math.max(1, Math.ceil(total / perPage));
  const target = (p: number, rel: string): string => `<${url.origin}${path}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < last) parts.push(target(page + 1, 'next'), target(last, 'last'));
  if (page > 1) parts.push(target(page - 1, 'prev'), target(1, 'first'));
  return parts.length === 0 ? {} : { Link: parts.join(', ') };
}
