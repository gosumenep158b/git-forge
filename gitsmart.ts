// gitsmart.ts — the smart-HTTP protocol layer.
//
// upload-pack: protocol v2 (advertisement, ls-refs, fetch with shallow/deepen) and the v0
// fallback with side-band-64k framing. receive-pack: v0 only, advertising report-status,
// side-band-64k and delete-refs; per-ref ok/ng report, fast-forward only.
//
// Framing details that are load-bearing: the four-hex pkt length, the NUL before capabilities
// on the first ref line, `# service=...` preamble + flush on v0, `version 2` on the v2 ad.

import {
  type GitObj,
  NULL_SHA,
  framePkts,
  onePkt,
  packTrailerOk,
  readPackFile,
  readCommit,
  readTag,
  unframePkts,
  type Pkt,
} from './objformat.ts';
import { Forge, type RepoRecord } from './model.ts';

const BAND_MAX = 65515;
const AGENT_CAP = 'agent=r4-forge/1.0';

export interface RawReply {
  status: number;
  body: Buffer;
  contentType: string;
}

const NOT_FOUND: RawReply = { status: 404, body: Buffer.alloc(0), contentType: 'text/plain; charset=utf-8' };

function pktText(payload: Buffer): string {
  return payload.toString('utf8').replace(/\n$/, '');
}

// ------------------------------------------------------------------ ref listing

interface RefRow { name: string; sha: string; peeled?: string }

function refRows(repo: RepoRecord): RefRow[] {
  const rows: RefRow[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head !== undefined) rows.push({ name: 'HEAD', sha: head });
  for (const name of [...repo.refs.keys()].sort()) {
    const sha = repo.refs.get(name)!;
    const row: RefRow = { name, sha };
    const obj = repo.objects.get(sha);
    if (obj !== undefined && obj.kind === 'tag') row.peeled = readTag(obj.data).object;
    rows.push(row);
  }
  return rows;
}

function v0Ad(repo: RepoRecord, service: string): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k ofs-delta shallow multi_ack multi_ack_detailed report-status include-tag symref=HEAD:refs/heads/${repo.defaultBranch} ${AGENT_CAP}`
    : `report-status side-band-64k delete-refs ofs-delta ${AGENT_CAP}`;
  const parts = [onePkt(`# service=${service}\n`), Buffer.from('0000')];
  const rows = refRows(repo);
  if (rows.length === 0) {
    parts.push(onePkt(Buffer.concat([
      Buffer.from(`${NULL_SHA} capabilities^{}`),
      Buffer.from(`\0${caps}\n`),
    ])));
  } else {
    rows.forEach((row, index) => {
      const prefix = Buffer.from(`${row.sha} ${row.name}`);
      const suffix = Buffer.from(index === 0 ? `\0${caps}\n` : '\n');
      parts.push(onePkt(Buffer.concat([prefix, suffix])));
      if (row.peeled !== undefined) parts.push(onePkt(`${row.peeled} ${row.name}^{}\n`));
    });
  }
  parts.push(Buffer.from('0000'));
  return Buffer.concat(parts);
}

function v2Ad(): Buffer {
  const caps = ['ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1', AGENT_CAP];
  return Buffer.concat([
    onePkt('version 2\n'),
    ...caps.map((cap) => onePkt(`${cap}\n`)),
    Buffer.from('0000'),
  ]);
}

export function infoRefs(forge: Forge, owner: string, name: string, service: string, wantsV2: boolean): RawReply {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return NOT_FOUND;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 403, body: onePkt('ERR unsupported service\n'), contentType: 'text/plain' };
  }
  const v2 = wantsV2 && service === 'git-upload-pack';
  return {
    status: 200,
    body: v2 ? v2Ad() : v0Ad(repo, service),
    contentType: `application/x-${service}-advertisement`,
  };
}

// ------------------------------------------------------------------- pack build

function collectTree(repo: RepoRecord, treeSha: string, seen: Set<string>, out: GitObj[], skip?: Set<string>): void {
  if (seen.has(treeSha) || skip?.has(treeSha) === true) return;
  const obj = repo.objects.get(treeSha);
  if (obj === undefined) return;
  seen.add(treeSha);
  out.push(obj);
  if (obj.kind !== 'tree') return;
  const data = obj.data;
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('ascii', at, space);
    const sha = data.toString('hex', nul + 1, nul + 21);
    at = nul + 21;
    if (mode !== '160000') collectTree(repo, sha, seen, out, skip); // gitlink: not ours
  }
}

/** Everything the client already has, per its `have` tips. */
function haveClosure(repo: RepoRecord, haves: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (obj.kind === 'commit') stack.push(readCommit(obj.data).tree, ...readCommit(obj.data).parents);
    else if (obj.kind === 'tree') {
      const data = obj.data;
      let at = 0;
      while (at < data.length) {
        const space = data.indexOf(0x20, at);
        const nul = data.indexOf(0x00, space);
        stack.push(data.toString('hex', nul + 1, nul + 21));
        at = nul + 21;
      }
    }
  }
  return seen;
}

export interface FetchPlan {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
  caps: Set<string>;
}

function parseFetch(pkts: readonly Pkt[], capsOnWant: boolean): FetchPlan | null {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const caps = new Set<string>();
  let depth: number | null = null;
  for (const packet of pkts) {
    if (packet.kind !== 'data') continue;
    const text = pktText(packet.body);
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const space = rest.indexOf(' ');
      const sha = space === -1 ? rest : rest.slice(0, space);
      if (capsOnWant && caps.size === 0 && space !== -1) {
        for (const cap of rest.slice(space + 1).split(' ')) if (cap) caps.add(cap);
      }
      if (/^[0-9a-f]{40}$/.test(sha)) wants.push(sha);
    } else if (text.startsWith('have ')) {
      const sha = text.slice(5).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) haves.push(sha);
    } else if (text.startsWith('shallow ')) {
      shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const value = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  if (wants.length === 0) return null;
  return { wants, haves, depth, shallow, caps };
}

function badFetch(detail: string): RawReply {
  return { status: 400, body: onePkt(`ERR ${detail}\n`), contentType: 'application/x-git-upload-pack-result' };
}

/** Build the pack for a fetch, honouring haves, shallow boundaries and deepen semantics. */
function buildFetchPack(repo: RepoRecord, plan: FetchPlan): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const excluded = haveClosure(repo, plan.haves);
  // A shallow boundary the deepen now walks past becomes a depth-0 walk root.
  const boundaryRoots = plan.depth !== null ? plan.shallow.filter((sha) => repo.objects.has(sha)) : [];
  const rootDepth = new Map<string, number>(boundaryRoots.map((sha) => [sha, 0]));
  const deepening = plan.depth !== null && plan.shallow.length > 0;

  const seen = new Set<string>();
  const objects: GitObj[] = [];
  const shallows = new Set<string>();
  const take = (sha: string): void => {
    if (seen.has(sha)) return;
    const obj = repo.objects.get(sha);
    if (obj === undefined) return;
    seen.add(sha);
    objects.push(obj);
  };

  for (const want of plan.wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.kind !== 'commit') {
      take(want);
      if (obj.kind === 'tree') collectTree(repo, want, seen, objects);
      continue;
    }
    if (excluded.has(want) && plan.depth === null) continue;
    let level = [want];
    let depth = rootDepth.get(want) ?? 0;
    while (level.length > 0) {
      const next: string[] = [];
      for (const sha of level) {
        if (seen.has(sha)) continue;
        if (sha !== want && excluded.has(sha) && !deepening) continue;
        const commit = repo.objects.get(sha);
        if (commit === undefined || commit.kind !== 'commit') continue;
        take(sha);
        const parsed = readCommit(commit.data);
        collectTree(repo, parsed.tree, seen, objects, deepening ? undefined : excluded);
        if (plan.depth !== null && depth + 1 >= plan.depth) {
          shallows.add(sha);
          continue;
        }
        for (const parent of parsed.parents) {
          if (!seen.has(parent) && (!excluded.has(parent) || deepening)) next.push(parent);
        }
      }
      level = next;
      depth += 1;
    }
  }

  // A boundary the new pack walks past is unshallowed.
  const unshallow: string[] = [];
  for (const boundary of plan.shallow) {
    if (shallows.has(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.kind !== 'commit') continue;
    if (readCommit(obj.data).parents.some((parent) => seen.has(parent))) unshallow.push(boundary);
  }

  return { pack: Forge.packAll(objects), shallow: [...shallows], unshallow };
}

function sideBand(stream: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < stream.length; at += BAND_MAX) {
    const slice = stream.subarray(at, at + BAND_MAX);
    const frame = Buffer.allocUnsafe(slice.length + 1);
    frame[0] = 1;
    slice.copy(frame, 1);
    parts.push(onePkt(frame));
  }
  return Buffer.concat(parts);
}

function uploadPackV0(repo: RepoRecord, pkts: readonly Pkt[]): RawReply {
  const plan = parseFetch(pkts, true);
  if (plan === null) return badFetch('invalid request');
  const missing = plan.wants.find((sha) => !repo.objects.has(sha));
  if (missing !== undefined) return badFetch(`want ${missing} not our ref`);
  const { pack, shallow, unshallow } = buildFetchPack(repo, plan);
  const parts: Buffer[] = [];
  for (const sha of unshallow) parts.push(onePkt(`unshallow ${sha}\n`));
  for (const sha of shallow) parts.push(onePkt(`shallow ${sha}\n`));
  parts.push(onePkt('NAK\n'));
  parts.push(plan.caps.has('side-band-64k') ? sideBand(pack) : pack);
  parts.push(Buffer.from('0000'));
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

function uploadPackV2(repo: RepoRecord, pkts: readonly Pkt[]): RawReply {
  const plan = parseFetch(pkts, false);
  if (plan === null) return badFetch('invalid request');
  const missing = plan.wants.find((sha) => !repo.objects.has(sha));
  if (missing !== undefined) return badFetch(`want ${missing} not our ref`);
  const { pack, shallow, unshallow } = buildFetchPack(repo, plan);
  const parts: Buffer[] = [];
  if (plan.haves.length > 0) {
    parts.push(onePkt('acknowledgments\n'));
    const common = plan.haves.filter((sha) => repo.objects.has(sha));
    if (common.length === 0) parts.push(onePkt('NAK\n'));
    else for (const sha of common) parts.push(onePkt(`ACK ${sha}\n`));
    parts.push(Buffer.from('0001'));
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(onePkt('shallow-info\n'));
    for (const sha of shallow) parts.push(onePkt(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(onePkt(`unshallow ${sha}\n`));
    parts.push(Buffer.from('0001'));
  }
  parts.push(onePkt('packfile\n'));
  parts.push(sideBand(pack));
  parts.push(Buffer.from('0000'));
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

function lsRefs(repo: RepoRecord, pkts: readonly Pkt[]): RawReply {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const packet of pkts) {
    if (packet.kind !== 'data') continue;
    const text = pktText(packet.body);
    if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
    else if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  if (keep('HEAD')) {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const suffix = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    out.push(onePkt(tip === undefined ? `unborn HEAD${suffix}\n` : `${tip} HEAD${suffix}\n`));
  }
  for (const row of refRows(repo)) {
    if (row.name === 'HEAD' || !keep(row.name)) continue;
    const peeled = peel && row.peeled !== undefined ? ` peeled:${row.peeled}` : '';
    out.push(onePkt(`${row.sha} ${row.name}${peeled}\n`));
  }
  out.push(Buffer.from('0000'));
  return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
}

export function uploadPack(forge: Forge, owner: string, name: string, body: Buffer, wantsV2: boolean): RawReply {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return NOT_FOUND;
  const pkts = unframePkts(body);
  if (pkts === null) return badFetch('invalid request');
  if (!wantsV2) return uploadPackV0(repo, pkts);
  const first = pkts.find((packet) => packet.kind === 'data');
  const command = first === undefined ? '' : pktText(first.body);
  if (command === 'command=ls-refs') return lsRefs(repo, pkts);
  if (command === 'command=fetch') return uploadPackV2(repo, pkts);
  return badFetch('unknown v2 command');
}

// ----------------------------------------------------------------- receive-pack

interface PushCmd { oldSha: string; newSha: string; ref: string }

function parseReceive(body: Buffer): { commands: PushCmd[]; caps: Set<string>; packAt: number } | null {
  let at = 0;
  const commands: PushCmd[] = [];
  const caps = new Set<string>();
  while (at + 4 <= body.length) {
    const head = body.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = Number.parseInt(head, 16);
    if (len === 0) return { commands, caps, packAt: at + 4 };
    if (len < 4 || at + len > body.length) return null;
    const raw = body.toString('utf8', at + 4, at + len).replace(/\n$/, '');
    at += len;
    const nul = raw.indexOf('\0');
    const plain = nul === -1 ? raw : raw.slice(0, nul);
    if (nul !== -1 && commands.length === 0) {
      for (const cap of raw.slice(nul + 1).split(' ')) if (cap) caps.add(cap);
    }
    const hit = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/.+)$/.exec(plain);
    if (hit === null) return null;
    commands.push({ oldSha: hit[1]!, newSha: hit[2]!, ref: hit[3]! });
  }
  return null;
}

/** Apply one command; every update must fast-forward. */
function applyPush(repo: RepoRecord, cmd: PushCmd, report: Buffer[]): void {
  const current = repo.refs.get(cmd.ref);
  const existing = current ?? NULL_SHA;
  if (cmd.newSha === NULL_SHA) {
    if (current === undefined) { report.push(onePkt(`ng ${cmd.ref} ref does not exist\n`)); return; }
    if (cmd.oldSha !== NULL_SHA && cmd.oldSha !== current) {
      report.push(onePkt(`ng ${cmd.ref} stale info\n`));
      return;
    }
    repo.refs.delete(cmd.ref);
    repo.reach = null;
    report.push(onePkt(`ok ${cmd.ref}\n`));
    return;
  }
  if (!repo.objects.has(cmd.newSha)) {
    report.push(onePkt(`ng ${cmd.ref} missing necessary objects\n`));
    return;
  }
  if (cmd.oldSha !== NULL_SHA && cmd.oldSha !== existing) {
    report.push(onePkt(`ng ${cmd.ref} fetch first\n`));
    return;
  }
  if (existing !== NULL_SHA && cmd.newSha !== existing) {
    const target = repo.objects.get(cmd.newSha);
    if (target !== undefined && target.kind === 'commit' && !forgeIsAncestor(repo, existing, cmd.newSha)) {
      report.push(onePkt(`ng ${cmd.ref} non-fast-forward\n`));
      return;
    }
  }
  repo.refs.set(cmd.ref, cmd.newSha);
  repo.reach = null;
  report.push(onePkt(`ok ${cmd.ref}\n`));
}

function forgeIsAncestor(repo: RepoRecord, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.kind !== 'commit') continue;
    stack.push(...readCommit(obj.data).parents);
  }
  return false;
}

export function receivePack(forge: Forge, owner: string, name: string, body: Buffer): RawReply {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return NOT_FOUND;
  const parsed = parseReceive(body);
  if (parsed === null) {
    return { status: 400, body: onePkt('ERR invalid request\n'), contentType: 'application/x-git-receive-pack-result' };
  }

  const packBytes = body.subarray(parsed.packAt);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    if (!packTrailerOk(packBytes)) {
      unpackOk = false;
      unpackDetail = 'index-pack failed: bad trailer';
    } else {
      try {
        const { objects } = readPackFile(packBytes);
        for (const [sha, obj] of objects) {
          if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
        }
        repo.reach = null;
      } catch (err) {
        unpackOk = false;
        unpackDetail = `index-pack failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  const report: Buffer[] = [onePkt(`unpack ${unpackDetail}\n`)];
  if (unpackOk) for (const cmd of parsed.commands) applyPush(repo, cmd, report);
  if (parsed.commands.length > 0 && unpackOk) repo.updatedAt = forge.tick();

  const reportBytes = Buffer.concat([...report, Buffer.from('0000')]);
  const payload = parsed.caps.has('side-band-64k')
    ? Buffer.concat([sideBand(reportBytes), Buffer.from('0000')])
    : reportBytes;
  return { status: 200, body: payload, contentType: 'application/x-git-receive-pack-result' };
}
