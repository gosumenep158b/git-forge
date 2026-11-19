// Git smart-HTTP surface (protocol v2 + v0) for the forge.
//
// Serves, per repository:
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /<owner>/<repo>.git/git-upload-pack    (fetch / ls-refs, v2 and v0)
//   POST /<owner>/<repo>.git/git-receive-pack   (push, v0, report-status)
//
// Pure TypeScript, Node builtins only (node:crypto, node:zlib). No `git`
// binary at runtime. Objects live in the shared Store (repo.objects /
// repo.refs); this module only reads and writes through it.
//
// Erasable TypeScript only (node --experimental-strip-types): no enums,
// namespaces or parameter properties.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authOk, hashObject, newRequestId, nowIso, parseCommit, parseTree } from './store.ts';
import type { GitObject, GitObjectType, Repo, Store } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const PKT_LINE_MAX = 65520;
const AGENT = 'forge-git/1.0';

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': newRequestId(),
  });
  res.end(body);
}

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'X-GitHub-Request-Id': newRequestId(),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line too long');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Pkt =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from `buf` starting at `start`. When `stopAtFlush` is
 * set, decoding stops just after the first flush packet and `end` is the
 * offset past it (the bytes after it — a packfile — are left untouched).
 * Throws on any malformed or truncated framing.
 */
function decodePktLines(
  buf: Buffer,
  start = 0,
  stopAtFlush = false,
): { packets: Pkt[]; end: number; sawFlush: boolean } {
  const packets: Pkt[] = [];
  let i = start;
  let sawFlush = false;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line');
    const header = buf.subarray(i, i + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      i += 4;
      sawFlush = true;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      i += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error('bad pkt-line length');
    if (i + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + length) });
    i += length;
  }
  return { packets, end: i, sawFlush };
}

function dataLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/** Split one band's bytes into side-band pkt-lines (1-byte band + data). */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = PKT_LINE_MAX - 4 - 1;
  for (let i = 0; i < data.length; i += max) {
    out.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(i, i + max)])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// object graph helpers (all reads go through the repo's objects Map)
// ---------------------------------------------------------------------------

function tagTarget(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? match[1] : null;
}

/** Follow annotated tags to the object they ultimately point at. */
function peel(repo: Repo, oid: string): string | undefined {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj) return undefined;
    if (obj.type !== 'tag') return cur;
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    const target = tagTarget(obj.data);
    if (!target) return undefined;
    cur = target;
  }
}

/** Expand `oid` into `out` (commit -> tree + parents, tag -> target, tree -> entries). */
function expandInto(
  repo: Repo,
  oid: string,
  out: Set<string>,
  followParents: (commitOid: string) => boolean,
): void {
  const stack: string[] = [oid];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (followParents(cur)) for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target) stack.push(target);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.sha);
      }
    }
  }
}

/** True when `ancestor` (peeled) is `descendant` (peeled) or one of its parents. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const start = peel(repo, descendant);
  if (!start) return false;
  const target = peel(repo, ancestor) ?? ancestor;
  if (start === target) return true;
  const stack: string[] = [start];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// delta codec (git delta format)
// ---------------------------------------------------------------------------

function encodeVarintLE(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

/**
 * Build a delta from `base` to `target`, or null when no useful match was
 * found. Greedy longest-match scan over a 4-byte hash index of the base
 * (matches are verified byte-for-byte, so a hash collision can only miss a
 * match, never corrupt one). Callers verify with applyDelta before use.
 */
function makeDelta(base: Buffer, target: Buffer): Buffer | null {
  const index = new Map<number, number>();
  for (let i = 0; i + 8 <= base.length; i += 1) {
    const key = base.readUInt32BE(i);
    if (!index.has(key)) index.set(key, i);
  }
  if (index.size === 0) return null;
  const out: Buffer[] = [encodeVarintLE(base.length), encodeVarintLE(target.length)];
  let pos = 0;
  let litStart = 0;
  const flushLiteral = (end: number): void => {
    let s = litStart;
    while (s < end) {
      const n = Math.min(127, end - s);
      out.push(Buffer.from([n]), target.subarray(s, s + n));
      s += n;
    }
  };
  let matched = false;
  while (pos < target.length) {
    let match: { off: number; len: number } | null = null;
    if (pos + 8 <= target.length) {
      const cand = index.get(target.readUInt32BE(pos));
      if (cand !== undefined) {
        let len = 0;
        while (
          pos + len < target.length &&
          cand + len < base.length &&
          target[pos + len] === base[cand + len] &&
          len < 0x10000
        ) {
          len += 1;
        }
        if (len >= 8) match = { off: cand, len };
      }
    }
    if (match) {
      matched = true;
      flushLiteral(pos);
      let off = match.off;
      let len = match.len;
      while (len > 0) {
        const chunk = Math.min(len, 0x10000);
        let op = 0x80;
        const opBytes: number[] = [];
        for (let b = 0; b < 4; b += 1) {
          const byte = (off >> (8 * b)) & 0xff;
          if (byte) {
            op |= 1 << b;
            opBytes.push(byte);
          }
        }
        const sizeVal = chunk === 0x10000 ? 0 : chunk;
        for (let b = 0; b < 3; b += 1) {
          const byte = (sizeVal >> (8 * b)) & 0xff;
          if (byte) {
            op |= 1 << (4 + b);
            opBytes.push(byte);
          }
        }
        out.push(Buffer.from([op, ...opBytes]));
        off += chunk;
        len -= chunk;
      }
      pos += match.len;
      litStart = pos;
    } else {
      pos += 1;
    }
  }
  flushLiteral(target.length);
  return matched ? Buffer.concat(out) : null;
}

/** Apply a git delta to a base object's bytes. Throws on malformed input. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// ---------------------------------------------------------------------------
// packfile write (v2, OFS_DELTA with a bounded same-type window)
// ---------------------------------------------------------------------------

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function encodeOfsOffset(diff: number): Buffer {
  const bytes: number[] = [diff & 0x7f];
  let n = Math.floor(diff / 128);
  while (n) {
    n -= 1;
    bytes.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  bytes.reverse();
  return Buffer.from(bytes);
}

/**
 * Order objects for the pack so delta bases precede their deltas: tags
 * first, then commits oldest-first (largest distance from the wants), each
 * followed by its tree closure in stored order. Anything left over (a bare
 * blob/tree/tag want) is appended in oid order.
 */
function orderForPack(
  repo: Repo,
  send: ReadonlyMap<string, GitObject>,
  commitDepth: ReadonlyMap<string, number>,
): string[] {
  const order: string[] = [];
  const emitted = new Set<string>();
  const emitTree = (oid: string): void => {
    if (emitted.has(oid) || !send.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    emitted.add(oid);
    order.push(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        const child = repo.objects.get(entry.sha);
        if (!child) continue;
        if (child.type === 'tree') emitTree(entry.sha);
        else if (send.has(entry.sha) && !emitted.has(entry.sha)) {
          emitted.add(entry.sha);
          order.push(entry.sha);
        }
      }
    }
  };
  const tags = [...send.keys()]
    .filter((oid) => send.get(oid)?.type === 'tag')
    .sort();
  for (const oid of tags) {
    emitted.add(oid);
    order.push(oid);
  }
  const commits = [...commitDepth.keys()]
    .filter((oid) => send.has(oid))
    .sort((a, b) => (commitDepth.get(b) as number) - (commitDepth.get(a) as number) || (a < b ? -1 : 1));
  for (const oid of commits) {
    if (emitted.has(oid)) continue;
    emitted.add(oid);
    order.push(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') emitTree(parseCommit(obj.data).tree);
  }
  for (const oid of [...send.keys()].sort()) {
    if (!emitted.has(oid)) {
      emitted.add(oid);
      order.push(oid);
    }
  }
  return order;
}

function buildPack(
  repo: Repo,
  send: ReadonlyMap<string, GitObject>,
  commitDepth: ReadonlyMap<string, number>,
): Buffer {
  const order = orderForPack(repo, send, commitDepth);
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(order.length, 8);
  const parts: Buffer[] = [header];
  let offset = 12;
  // Bounded delta search: the last 32 emitted objects of each type; at
  // most 4 candidates tried per object, only for objects >= 256 bytes.
  const recentByType = new Map<GitObjectType, Array<{ oid: string; data: Buffer; offset: number }>>();
  for (const oid of order) {
    const obj = send.get(oid) as GitObject;
    let deltaEntry: { baseOffset: number; delta: Buffer } | null = null;
    if (obj.data.length >= 256) {
      const recents = recentByType.get(obj.type) ?? [];
      let attempts = 0;
      for (let i = recents.length - 1; i >= 0 && attempts < 4; i -= 1) {
        const cand = recents[i] as { oid: string; data: Buffer; offset: number };
        if (cand.oid === oid) continue;
        if (cand.data.length < obj.data.length / 4 || cand.data.length > obj.data.length * 4) continue;
        attempts += 1;
        const delta = makeDelta(cand.data, obj.data);
        if (!delta || delta.length >= obj.data.length * 0.8) continue;
        try {
          if (applyDelta(cand.data, delta).equals(obj.data)) {
            deltaEntry = { baseOffset: cand.offset, delta };
            break;
          }
        } catch {
          // A delta that does not round-trip is discarded; store plain.
        }
      }
    }
    let entry: Buffer;
    if (deltaEntry) {
      entry = Buffer.concat([
        packObjectHeader(6, deltaEntry.delta.length),
        encodeOfsOffset(offset - deltaEntry.baseOffset),
        deflateSync(deltaEntry.delta),
      ]);
    } else {
      entry = Buffer.concat([packObjectHeader(TYPE_CODE[obj.type], obj.data.length), deflateSync(obj.data)]);
    }
    parts.push(entry);
    const recents = recentByType.get(obj.type) ?? [];
    recents.push({ oid, data: obj.data, offset });
    if (recents.length > 32) recents.shift();
    recentByType.set(obj.type, recents);
    offset += entry.length;
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// packfile read (v2/v3, OFS_DELTA + REF_DELTA; thin-pack bases fall back to
// the repo's own objects, as a real git push does)
// ---------------------------------------------------------------------------

function inflateAt(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const view = pack.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readPackObjects(repo: Repo, pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is shorter than its trailer');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: { type: GitObjectType; data: Buffer; oid: string };
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        b = pack[offset++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = repo.objects.get(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not in the pack or the repo`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved = { type, data, oid };
    entry.resolved = resolved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };

  const out = new Map<string, GitObject>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!out.has(resolved.oid)) out.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  send: Map<string, GitObject>;
  commitDepth: Map<string, number>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out what a fetch sends. `haves` are objects the client already holds;
 * a have listed in `oldShallow` is a shallow boundary, so its parents are
 * NOT held (the closure walk does not follow that commit's parents).
 * `depth` truncates the commit walk at that many generations from the wants.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): FetchPlan {
  const oldShallowSet = new Set(oldShallow);
  const haveReach = new Set<string>();
  for (const have of haves) expandInto(repo, have, haveReach, (oid) => !oldShallowSet.has(oid));

  const included = new Set<string>();
  const commitDepth = new Map<string, number>();
  const shallowSet = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = wants.map((oid) => ({ oid, d: 1 }));
  for (let qi = 0; qi < queue.length; qi += 1) {
    const { oid, d } = queue[qi] as { oid: string; d: number };
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (included.has(oid)) continue;
      included.add(oid);
      const target = tagTarget(obj.data);
      if (target) queue.push({ oid: target, d });
      continue;
    }
    if (obj.type === 'tree') {
      expandInto(repo, oid, included, () => true);
      continue;
    }
    if (obj.type === 'blob') {
      included.add(oid);
      continue;
    }
    const prev = commitDepth.get(oid);
    if (prev !== undefined && prev <= d) continue;
    commitDepth.set(oid, d);
    included.add(oid);
    shallowSet.delete(oid);
    const commit = parseCommit(obj.data);
    expandInto(repo, commit.tree, included, () => true);
    if (depth === undefined || d < depth) {
      for (const parent of commit.parents) {
        if (haveReach.has(parent)) continue;
        queue.push({ oid: parent, d: d + 1 });
      }
    } else {
      for (const parent of commit.parents) {
        if (!haveReach.has(parent) && !included.has(parent)) shallowSet.add(oid);
      }
    }
  }

  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    if (!haveReach.has(boundary) && !included.has(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (!obj || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.every((p) => haveReach.has(p) || included.has(p))) {
      unshallow.push(boundary);
    }
  }

  const send = new Map<string, GitObject>();
  for (const oid of included) {
    if (haveReach.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) send.set(oid, obj);
  }
  return { send, commitDepth, shallow: [...shallowSet], unshallow };
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function advertisementV2(service: string): Buffer {
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

function advertisementV0(repo: Repo, service: string): Buffer {
  const headTarget = `refs/heads/${repo.default_branch}`;
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta thin-pack shallow multi_ack agent=${AGENT} symref=HEAD:${headTarget}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headTarget}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peel(repo, oid);
      if (peeled && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  sendGit(res, 200, contentType, wantsV2 ? advertisementV2(service) : advertisementV0(repo, service));
}

// ---------------------------------------------------------------------------
// upload-pack: v2 ls-refs / fetch, and v0 fetch
// ---------------------------------------------------------------------------

function handleLsRefsV2(res: ServerResponse, repo: Repo, args: readonly string[]): void {
  const peelArg = args.includes('peel');
  const symrefsArg = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headTarget = `refs/heads/${repo.default_branch}`;
  const headOid = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    lines.push(
      headOid
        ? `${headOid} HEAD${symrefsArg ? ` symref-target:${headTarget}` : ''}\n`
        : `unborn HEAD${symrefsArg ? ` symref-target:${headTarget}` : ''}\n`,
    );
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peelArg) {
      const peeled = peel(repo, oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
  sendGit(res, 200, 'application/x-git-upload-pack-result', body);
}

function handleFetchV2(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  args: readonly string[],
): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not,
    // done: accepted and (where they need no action) ignored. A thin pack
    // is never produced: deltas only ever reference bases inside the pack.
  }
  void req;
  if (wants.length === 0) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  for (const want of wants) {
    if (!/^[0-9a-f]{40}$/.test(want) || !repo.objects.has(want)) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const pack = buildPack(repo, plan.send, plan.commitDepth);
  // ACK the haves that lie in the closure of the wants (the shared history).
  const wantClosure = new Set<string>();
  for (const want of wants) expandInto(repo, want, wantClosure, () => true);
  const acked = haves.filter((have) => wantClosure.has(have));
  const ackLines: string[] = acked.length
    ? [...acked.map((have) => `ACK ${have}\n`), 'ready\n']
    : ['NAK\n'];
  const parts: Buffer[] = [];
  // Real git rejects an "acknowledgments" section when the request carried
  // no "have" lines (it expects shallow-info/packfile straight away), so
  // the section is only sent when the client actually offered haves. The
  // kit client tolerates a missing section either way.
  if (haves.length) {
    parts.push(pktLine('acknowledgments\n'));
    for (const line of ackLines) parts.push(pktLine(line));
    parts.push(DELIM);
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(FLUSH);
  sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(res: ServerResponse, repo: Repo, packets: readonly Pkt[]): void {
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') {
      (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const first = sections[0] ?? [];
  const second = sections[1] ?? [];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of first) {
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      wants.push(line.slice(5).trim().split(/\s+/)[0] as string);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  for (const line of second) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  if (wants.length === 0) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  for (const want of wants) {
    if (!/^[0-9a-f]{40}$/.test(want) || !repo.objects.has(want)) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const pack = buildPack(repo, plan.send, plan.commitDepth);
  const wantClosure = new Set<string>();
  for (const want of wants) expandInto(repo, want, wantClosure, () => true);
  const parts: Buffer[] = [];
  const acked = haves.filter((have) => wantClosure.has(have));
  if (acked.length) for (const have of acked) parts.push(pktLine(`ACK ${have}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(FLUSH);
  sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets: Pkt[];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    let command = '';
    const args: string[] = [];
    let seenDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        seenDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!command && line.startsWith('command=')) {
        command = line.slice('command='.length);
        continue;
      }
      if (seenDelim) args.push(line);
      // Pre-delim lines (agent=, object-format=) are accepted and ignored.
    }
    if (command === 'ls-refs') {
      handleLsRefsV2(res, repo, args);
      return;
    }
    if (command === 'fetch') {
      handleFetchV2(req, res, repo, args);
      return;
    }
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  handleFetchV0(res, repo, packets);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(
  res: ServerResponse,
  store: Store,
  repo: Repo,
  body: Buffer,
): void {
  let decoded: { packets: Pkt[]; end: number; sawFlush: boolean };
  try {
    decoded = decodePktLines(body, 0, true);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  if (!decoded.sawFlush) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const token of line.slice(nul + 1).trim().split(/\s+/)) {
        if (token) caps.add(token.split('=')[0] as string);
      }
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (commands.length === 0) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const sideband = caps.has('side-band-64k');
  const packBytes = body.subarray(decoded.end);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const unpacked = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      for (const [oid, obj] of readPackObjects(repo, packBytes)) unpacked.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message;
    }
  }
  if (unpackOk) {
    for (const [oid, obj] of unpacked) store.putObject(repo, oid, obj);
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const apply: Array<{ ref: string; newOid: string | null }> = [];
  for (const cmd of commands) {
    if (!cmd.ref.startsWith('refs/')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        apply.push({ ref: cmd.ref, newOid: null });
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      } else if (!repo.objects.has(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      } else {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        apply.push({ ref: cmd.ref, newOid: cmd.newOid });
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
    } else if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else if (cmd.newOid === current) {
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
    } else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      apply.push({ ref: cmd.ref, newOid: cmd.newOid });
    }
  }
  for (const change of apply) {
    if (change.newOid === null) repo.refs.delete(change.ref);
    else repo.refs.set(change.ref, change.newOid);
  }
  if (apply.length) {
    repo.updated_at = nowIso();
    repo.pushed_at = nowIso();
  }

  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([...lines.map((line) => pktLine(line)), FLUSH]);
  const out = sideband
    ? Buffer.concat([...sidebandPackets(1, report), FLUSH])
    : report;
  sendGit(res, 200, 'application/x-git-receive-pack-result', out);
}

// ---------------------------------------------------------------------------
// entry point (wired into app.ts by the coordinator)
// ---------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  origin: string,
): Promise<boolean> {
  void origin;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
    if (!match) return false;
    const rest = match[3] as string | undefined;
    if (!rest || rest === '/') return false;
    const owner = safeDecode(match[1] as string);
    const repoName = safeDecode(match[2] as string);
    if (owner === null || repoName === null || owner === '' || repoName === '') {
      sendJson(res, 400, { message: 'Bad Request' });
      return true;
    }
    if (!authOk(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (rest === '/info/refs') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Bad Request' });
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      handleInfoRefs(req, res, repo, service);
      return true;
    }
    if (rest === '/git-upload-pack' || rest === '/git-receive-pack') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const body = await readBody(req);
      if (rest === '/git-upload-pack') handleUploadPack(req, res, repo, body);
      else handleReceivePack(res, store, repo, body);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch {
    try {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    } catch {
      // The socket is already gone; nothing more can be done.
    }
    return true;
  }
}
