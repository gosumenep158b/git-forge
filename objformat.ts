// objformat.ts — pure git object plumbing: hashing, trees, commits, tags, packs, pkt-lines.
// No I/O, no clock: every function here is deterministic over its inputs.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjKind = 'blob' | 'tree' | 'commit' | 'tag';
export type GitObj = { kind: ObjKind; data: Buffer };

export const NULL_SHA = '0'.repeat(40);
export const SHA_RE = /^[0-9a-f]{40}$/;

/** SHA-1 of the canonical `<type> <size>\0<body>` framing. */
export function objSha(kind: ObjKind, data: Buffer): string {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`${kind} ${data.length}\0`), data]))
    .digest('hex');
}

// ---------------------------------------------------------------------- trees

export interface TreeRow { mode: string; name: string; sha: string }

/** Sort by raw name (dir-vs-file mixing is single-level in this forge's own writes). */
export function serializeTree(rows: readonly TreeRow[]): Buffer {
  const ordered = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks = ordered.flatMap((row) => [
    Buffer.from(`${row.mode} ${row.name}\0`),
    Buffer.from(row.sha, 'hex'),
  ]);
  return Buffer.concat(chunks);
}

export function parseTreeEntries(data: Buffer): TreeRow[] {
  const rows: TreeRow[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0) throw new Error('malformed tree entry');
    rows.push({
      mode: data.toString('ascii', at, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return rows;
}

export function flattenTreeDeep(
  rootSha: string,
  get: (sha: string) => GitObj | undefined,
  prefix = '',
): Map<string, TreeRow> {
  const found = new Map<string, TreeRow>();
  const root = get(rootSha);
  if (root === undefined) return found;
  for (const row of parseTreeEntries(root.data)) {
    const path = prefix === '' ? row.name : `${prefix}/${row.name}`;
    found.set(path, row);
    if (row.mode === '40000') {
      for (const [sub, subRow] of flattenTreeDeep(row.sha, get, path)) found.set(sub, subRow);
    }
  }
  return found;
}

// -------------------------------------------------------------------- commits

/** `<Name> <email> <unix-time> +0000` */
export function identLine(person: string, seconds: number): string {
  return `${person} ${seconds} +0000`;
}

export function makeCommit(spec: {
  tree: string; parents: readonly string[]; message: string;
  author: string; committer: string; when: number;
}): Buffer {
  const head = [`tree ${spec.tree}`];
  for (const parent of spec.parents) head.push(`parent ${parent}`);
  head.push(`author ${identLine(spec.author, spec.when)}`);
  head.push(`committer ${identLine(spec.committer, spec.when)}`);
  const message = spec.message.endsWith('\n') ? spec.message : `${spec.message}\n`;
  return Buffer.from(`${head.join('\n')}\n\n${message}`);
}

export function readCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const cut = text.indexOf('\n\n');
  const header = cut >= 0 ? text.slice(0, cut) : text;
  const message = cut >= 0 ? text.slice(cut + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents, message };
}

export function readTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const cut = text.indexOf('\n\n');
  const header = cut >= 0 ? text.slice(0, cut) : text;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
  }
  return { object, type, tag };
}

// ------------------------------------------------------- trees from file sets

export interface FileSpec { path: string; data: Buffer }

/** Build nested trees from flat paths; `store` persists each blob/tree and returns its sha. */
export function treeFromPaths(files: readonly FileSpec[], store: (kind: ObjKind, data: Buffer) => string): string {
  type Node = { blobs: Map<string, Buffer>; dirs: Map<string, Node> };
  const fresh = (): Node => ({ blobs: new Map(), dirs: new Map() });
  const root = fresh();
  for (const file of files) {
    const segs = file.path.split('/').filter((s) => s !== '');
    if (segs.length === 0) continue;
    let node = root;
    for (const dir of segs.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, fresh());
      node = node.dirs.get(dir)!;
    }
    node.blobs.set(segs[segs.length - 1]!, file.data);
  }
  const emit = (node: Node): string => {
    const rows: TreeRow[] = [];
    for (const [name, data] of node.blobs) rows.push({ mode: '100644', name, sha: store('blob', data) });
    for (const [name, child] of node.dirs) rows.push({ mode: '40000', name, sha: emit(child) });
    return store('tree', serializeTree(rows));
  };
  return emit(root);
}

// -------------------------------------------------------------- reachability

/** Every object reachable from the tips (commits, trees, blobs, tags). */
export function walkReachable(tips: Iterable<string>, get: (sha: string) => GitObj | undefined): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips].filter((s) => s !== '' && s !== NULL_SHA);
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const obj = get(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (obj.kind === 'commit') stack.push(readCommit(obj.data).tree, ...readCommit(obj.data).parents);
    else if (obj.kind === 'tree') for (const row of parseTreeEntries(obj.data)) stack.push(row.sha);
    else if (obj.kind === 'tag') stack.push(readTag(obj.data).object);
  }
  return seen;
}

// ---------------------------------------------------------------------- packs

const KIND_CODE: Record<ObjKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Record<number, ObjKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

function entryHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let current = (code << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(current | 0x80);
    current = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

/** Canonical v2 pack, all-full objects, deflate per entry, SHA-1 trailer. */
export function makePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const obj of list) {
    parts.push(entryHeader(KIND_CODE[obj.kind], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packTrailerOk(pack: Uint8Array): boolean {
  if (pack.length < 32) return false;
  const bytes = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  const actual = bytes.subarray(bytes.length - 20).toString('hex');
  return createHash('sha1').update(bytes.subarray(0, bytes.length - 20)).digest('hex') === actual;
}

/** Inflate one zlib stream and report exactly how many input bytes it consumed. */
function inflateAt(buffer: Buffer, from: number, until: number): { data: Buffer; next: number } {
  if (from >= until) throw new Error('entry begins past the trailer');
  let info: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    info = inflateSync(buffer.subarray(from, until), { info: true }) as never;
  } catch (err) {
    throw new Error(`bad zlib stream at ${from}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const used = info.engine.bytesWritten;
  if (used <= 0 || used > until - from) throw new Error(`zlib stream at ${from} consumed ${used} bytes`);
  return { data: info.buffer, next: from + used };
}

export interface PackOutcome {
  objects: Map<string, GitObj>;
  count: number;
}

/**
 * Parse a v2/v3 pack, resolving ofs- and ref-deltas (thin-pack bases resolved via `external`).
 * Packfiles are parsed once per push; callers may cache the returned map.
 */
export function readPackFile(pack: Uint8Array, external?: (sha: string) => GitObj | undefined): PackOutcome {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.length - 20;

  type Raw = { at: number; code: number; body: Buffer; baseAt?: number; baseSha?: string; full?: { kind: ObjKind; data: Buffer } };
  const raws: Raw[] = [];
  const byAt = new Map<number, Raw>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const here = at;
    let byte = buf[at];
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[++at];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    at += 1;
    const entry: Raw = { at: here, code, body: Buffer.alloc(0) };
    if (code === OFS_DELTA) {
      let b = buf[at];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = buf[++at];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      at += 1;
      const baseAt = here - value;
      if (baseAt <= 0 || baseAt >= here) throw new Error(`ofs-delta at ${here} names a bad base`);
      entry.baseAt = baseAt;
    } else if (code === REF_DELTA) {
      if (at + 20 > trailer) throw new Error('ref-delta base truncated');
      entry.baseSha = buf.toString('hex', at, at + 20);
      at += 20;
    } else if (CODE_KIND[code] === undefined) {
      throw new Error(`unknown pack entry type ${code}`);
    }
    const inflated = inflateAt(buf, at, trailer);
    if (inflated.data.length !== size) {
      throw new Error(`entry at ${here} declares ${size} bytes, inflated to ${inflated.data.length}`);
    }
    entry.body = inflated.data;
    at = inflated.next;
    raws.push(entry);
    byAt.set(here, entry);
  }
  if (at !== trailer) throw new Error('stray bytes before the pack trailer');

  const resolving = new Set<number>();
  const finish = (entry: Raw): { kind: ObjKind; data: Buffer } => {
    if (entry.full !== undefined) return entry.full;
    if (resolving.has(entry.at)) throw new Error(`delta cycle at ${entry.at}`);
    resolving.add(entry.at);
    let base: { kind: ObjKind; data: Buffer } | undefined;
    if (entry.code === OFS_DELTA) {
      const parent = byAt.get(entry.baseAt!);
      if (parent !== undefined) base = finish(parent);
    } else if (entry.code === REF_DELTA) {
      const want = entry.baseSha!;
      for (const other of raws) {
        if (other.code === OFS_DELTA || other.code === REF_DELTA) continue;
        if (objSha(CODE_KIND[other.code], other.body) === want) {
          base = { kind: CODE_KIND[other.code], data: other.body };
          break;
        }
      }
      if (base === undefined && external !== undefined) {
        const outside = external(want);
        if (outside !== undefined) base = { kind: outside.kind, data: outside.data };
      }
    } else {
      base = { kind: CODE_KIND[entry.code], data: entry.body };
    }
    resolving.delete(entry.at);
    if (base === undefined) throw new Error(`delta base missing for entry at ${entry.at}`);
    const kind = base.kind;
    entry.full = entry.code === OFS_DELTA || entry.code === REF_DELTA
      ? { kind, data: applyDeltaBuf(base.data, entry.body) }
      : { kind, data: base.data };
    return entry.full;
  };

  const objects = new Map<string, GitObj>();
  for (const entry of raws) {
    const { kind, data } = finish(entry);
    const sha = objSha(kind, data);
    if (!objects.has(sha)) objects.set(sha, { kind, data });
  }
  return { objects, count };
}

/** Git copy/insert delta over `base`. */
export function applyDeltaBuf(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readLen = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
      shift += 7;
    }
  };
  if (readLen() !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readLen();
  const pieces: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 0x01) off += delta[at++];
      if (op & 0x02) off += delta[at++] * 0x100;
      if (op & 0x04) off += delta[at++] * 0x10000;
      if (op & 0x08) off += delta[at++] * 0x1000000;
      if (op & 0x10) len += delta[at++];
      if (op & 0x20) len += delta[at++] * 0x100;
      if (op & 0x40) len += delta[at++] * 0x10000;
      if (len === 0) len = 0x10000;
      if (off + len > base.length) throw new Error('delta copy past the base');
      pieces.push(base.subarray(off, off + len));
      produced += len;
    } else if (op > 0) {
      if (at + op > delta.length) throw new Error('delta insert past the delta');
      pieces.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(pieces, produced);
  if (out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// ------------------------------------------------------------------ pkt-lines

/** Encode data pkt-lines; `flush` and `delim` map to 0000 / 0001. */
export function framePkts(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of lines) {
    if (item === 'flush') { parts.push(Buffer.from('0000')); continue; }
    if (item === 'delim') { parts.push(Buffer.from('0001')); continue; }
    const payload = Buffer.from(item, 'utf8');
    parts.push(Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload);
  }
  return Buffer.concat(parts);
}

export function onePkt(payload: Buffer | string): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([
    Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'),
    data,
  ]);
}

export type Pkt = { kind: 'data' | 'flush' | 'delim' | 'end'; body: Buffer };

/** Decode a pkt-line stream; null on malformed framing. */
export function unframePkts(body: Buffer): Pkt[] | null {
  const out: Pkt[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const head = body.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = Number.parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush', body: Buffer.alloc(0) }); at += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', body: Buffer.alloc(0) }); at += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', body: Buffer.alloc(0) }); at += 4; continue; }
    if (len < 4 || at + len > body.length) return null;
    out.push({ kind: 'data', body: body.subarray(at + 4, at + len) });
    at += len;
  }
  return out;
}
