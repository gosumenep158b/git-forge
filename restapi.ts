// restapi.ts — the REST v3 surface under /api/v3, GitHub-shaped JSON over the Forge.
// Every reply (including errors) carries a JSON body with a string message and the
// shared X-GitHub-Request-Id added by the server.

import { NULL_SHA, readCommit } from './objformat.ts';
import type { Forge, IssueRecord, PullRecord, RepoRecord } from './model.ts';
import { repoTime } from './model.ts';
import { jsonReply, linkHeader, type Ctx, type Reply, type Router } from './webkernel.ts';

type Json = Record<string, unknown>;

const API_VERSION = '4.2.0';

function fail(status: number, message: string, extra: Json = {}): Reply {
  return jsonReply(status, { message, ...extra });
}

function ok(value: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return jsonReply(status, value, headers);
}

function pageParams(ctx: Ctx, fallback: number): { page: number; perPage: number } {
  const rawPage = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const rawPer = Number.parseInt(ctx.query.get('per_page') ?? String(fallback), 10);
  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    perPage: Number.isFinite(rawPer) && rawPer > 0 ? Math.min(rawPer, 100) : fallback,
  };
}

function userRef(login: string): Json {
  return { login, id: 1, node_id: 'U_1', type: 'User', avatar_url: '', html_url: '' };
}

function repoJson(repo: RepoRecord, forge: Forge): Json {
  void forge;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userRef(repo.owner),
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repoTime(repo.createdAt),
    updated_at: repoTime(repo.updatedAt),
    pushed_at: repoTime(repo.updatedAt),
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    forks_count: 0,
    stargazers_count: 0,
    size: 0,
    language: null,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
  };
}

function labelJson(label: { id: number; name: string; color: string; description: string }): Json {
  return { id: label.id, node_id: `L_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

function labelStub(name: string): Json {
  return { id: 0, node_id: '', name, color: 'ededed', default: false };
}

function issueJson(issue: IssueRecord, forge: Forge): Json {
  return {
    id: issue.gid,
    node_id: `I_${issue.gid}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelStub),
    user: userRef(issue.login),
    comments: issue.comments.length,
    created_at: repoTime(issue.createdAt),
    updated_at: repoTime(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : repoTime(issue.closedAt),
    html_url: '',
    url: '',
  };
}

function commentJson(comment: { gid: number; body: string; login: string; at: number }): Json {
  return {
    id: comment.gid,
    node_id: `C_${comment.gid}`,
    body: comment.body,
    user: userRef(comment.login),
    created_at: repoTime(comment.at),
    updated_at: repoTime(comment.at),
    html_url: '',
    issue_url: '',
  };
}

function pullJson(forge: Forge, repo: RepoRecord, pull: PullRecord): Json {
  void forge;
  const repoSide = repoJson(repo, forge);
  return {
    id: pull.gid,
    node_id: `PR_${pull.gid}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    closed_at: pull.closedAt === null ? null : repoTime(pull.closedAt),
    user: userRef(pull.login),
    labels: [],
    head: { ref: pull.headRef, sha: pull.headSha, label: `${pull.login}:${pull.headRef}`, repo: repoSide },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoSide },
    created_at: repoTime(pull.createdAt),
    updated_at: repoTime(pull.updatedAt),
    draft: false,
    mergeable: pull.mergeable !== 'CONFLICTING',
    mergeable_state: pull.mergeable,
    html_url: '',
    url: '',
  };
}

function commitEntry(forge: Forge, repo: RepoRecord, sha: string): Json | null {
  void forge;
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.kind !== 'commit') return null;
  const parsed = readCommit(obj.data);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: { message: parsed.message.replace(/\n+$/, ''), author: '', committer: '', tree: { sha: parsed.tree, url: '' }, url: '' },
    author: userRef('forge'),
    committer: userRef('forge'),
    html_url: '',
    url: '',
    parents: parsed.parents.map((parent) => ({ sha: parent, url: '' })),
  };
}

function branchOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^refs\/heads\//, '') : '';
}

function tipOf(repo: RepoRecord, branch: string): string {
  return repo.refs.get(`refs/heads/${branch.replace(/^refs\/heads\//, '')}`) ?? NULL_SHA;
}

function directoryListing(forge: Forge, repo: RepoRecord, tip: string, dirPath: string): Json[] {
  void forge;
  const out: Json[] = [];
  const prefix = dirPath === '' || dirPath === '/' ? '' : `${dirPath.replace(/\/$/, '')}/`;
  const seenDirs = new Set<string>();
  for (const [path, file] of forge.filesAtCommit(repo, tip)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const dir = rest.slice(0, slash);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      out.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '', size: 0, url: '', html_url: '', git_url: '' });
    } else {
      out.push({ type: 'file', name: rest, path, sha: file.sha, size: file.data.length, encoding: null, content: null, url: '', html_url: '', git_url: '', download_url: '' });
    }
  }
  out.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
  return out;
}

// ------------------------------------------------------------------ installer

export function installRest(forge: Forge, router: Router): void {
  const P = '/api/v3';

  const repoOr = (ctx: Ctx, handler: (repo: RepoRecord, c: Ctx) => Reply): Reply => {
    const repo = forge.getRepo(ctx.params.owner!, ctx.params.name!);
    if (repo === undefined || repo.owner !== forge.viewerLogin) return fail(404, 'Not Found');
    return handler(repo, ctx);
  };

  // -- root & meta -----------------------------------------------------------

  router.add('GET', `${P}/`, () => ok({ current_user_url: '', repository_url: '' }, 200, { 'x-oauth-scopes': 'repo, user' }));
  router.add('GET', `${P}/meta`, () => ok({ installed_version: API_VERSION, verifiable_password_authentication: false }));

  // -- repos -------------------------------------------------------------------

  router.add('POST', `${P}/user/repos`, (ctx) => {
    const body = ctx.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const name = body.name;
    if (typeof name !== 'string' || name.trim() === '') return fail(422, 'Validation Failed');
    if (forge.getRepo(forge.viewerLogin, name) !== undefined) return fail(422, 'name already exists on this account');
    const repo = forge.createRepo(forge.viewerLogin, name, {
      private: body.private === undefined ? true : body.private === true,
      description: typeof body.description === 'string' ? body.description : null,
    });
    return ok(repoJson(repo, forge), 201);
  });

  router.add('GET', `${P}/user/repos`, (ctx) => {
    const { page, perPage } = pageParams(ctx, 30);
    const owned = [...forge.repos.values()]
      .filter((repo) => repo.owner === forge.viewerLogin)
      .sort((a, b) => a.createdAt - b.createdAt);
    const start = (page - 1) * perPage;
    return ok(
      owned.slice(start, start + perPage).map((repo) => repoJson(repo, forge)),
      200,
      linkHeader(ctx.url, page, perPage, owned.length, `${P}/user/repos`),
    );
  });

  router.add('GET', `${P}/repos/:owner/:name`, (ctx) => repoOr(ctx, (repo) => ok(repoJson(repo, forge))));

  router.add('PATCH', `${P}/repos/:owner/:name`, (ctx) => repoOr(ctx, (repo, c) => {
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    if (typeof body.description === 'string' || body.description === null) {
      repo.description = body.description as string | null;
    }
    repo.updatedAt = forge.tick();
    return ok(repoJson(repo, forge));
  }));

  router.add('DELETE', `${P}/repos/:owner/:name`, (ctx) => repoOr(ctx, (repo) => {
    forge.deleteRepo(repo.owner, repo.name);
    return { status: 204, body: Buffer.alloc(0) };
  }));

  // -- branches & commits ---------------------------------------------------------

  router.add('POST', `${P}/repos/:owner/:name/git/refs`, (ctx) => repoOr(ctx, (repo, c) => {
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const ref = branchOf(body.ref);
    const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
    if (ref === '' || !/^[0-9a-f]{40}$/.test(sha)) return fail(422, 'Validation Failed');
    const full = `refs/heads/${ref}`;
    if (repo.refs.has(full)) return fail(422, 'Reference already exists');
    const obj = repo.objects.get(sha);
    if (obj === undefined) return fail(422, 'Object does not exist');
    repo.refs.set(full, sha);
    repo.reach = null;
    repo.updatedAt = forge.tick();
    return ok({ ref: full, node_id: '', url: '', object: { sha, type: obj.kind, url: '' } }, 201);
  }));

  router.add('GET', `${P}/repos/:owner/:name/branches`, (ctx) => repoOr(ctx, (repo) => {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
    if (branches.length === 0) {
      branches.push({ name: repo.defaultBranch, commit: { sha: NULL_SHA, url: '' }, protected: false });
    }
    return ok(branches);
  }));

  router.add('GET', `${P}/repos/:owner/:name/commits`, (ctx) => repoOr(ctx, (repo, c) => {
    const sha = c.query.get('sha');
    const tip = sha === null || sha === '' ? tipOf(repo, repo.defaultBranch) : (repo.refs.get(`refs/heads/${sha.replace(/^refs\/heads\//, '')}`) ?? (/^[0-9a-f]{40}$/.test(sha) ? sha : null));
    if (tip === null || !repo.objects.has(tip)) return ok([]);
    const list: Json[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && list.length < 100) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const entry = commitEntry(forge, repo, current);
      if (entry === null) continue;
      list.push(entry);
      for (const parent of entry.parents as Json[]) queue.push(String(parent.sha));
    }
    return ok(list);
  }));

  // -- contents -----------------------------------------------------------------

  router.add('PUT', `${P}/repos/:owner/:name/contents/*`, (ctx) => repoOr(ctx, (repo, c) => {
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const filePath = c.params['*'] ?? '';
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'update';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const data = typeof body.content === 'string' ? Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64') : Buffer.alloc(0);

    const tip = tipOf(repo, branch);
    const existing = forge.entryAt(repo, tip, filePath);
    const givenSha = typeof body.sha === 'string' && body.sha !== '' ? body.sha.toLowerCase() : undefined;
    if (existing !== null && existing.type === 'file' && givenSha !== undefined && givenSha !== existing.sha) {
      return fail(409, `${filePath} does not match ${givenSha}`);
    }
    if (existing !== null && existing.type === 'file' && givenSha === undefined) {
      return fail(422, `${filePath} already exists`);
    }

    const files = [...forge.filesAtCommit(repo, tip).entries()].map(([path, file]) => ({ path, data: file.data }));
    const index = files.findIndex((file) => file.path === filePath);
    if (index >= 0) files[index] = { path: filePath, data };
    else files.push({ path: filePath, data });

    const commitSha = forge.commitFileSet(repo, branch, files, { message });
    const blobSha = forge.entryAt(repo, commitSha, filePath)?.sha ?? NULL_SHA;
    return ok({
      content: {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: blobSha,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        url: '',
        html_url: '',
        download_url: '',
      },
      commit: {
        sha: commitSha,
        node_id: '',
        url: '',
        html_url: '',
        author: {},
        committer: {},
        message,
        tree: { sha: forge.entryAt(repo, commitSha, '')?.sha ?? '', url: '' },
        parents: [],
      },
    }, existing === null ? 201 : 200);
  }));

  router.add('GET', `${P}/repos/:owner/:name/contents/*`, (ctx) => repoOr(ctx, (repo, c) => {
    const filePath = c.params['*'] ?? '';
    const ref = c.query.get('ref');
    const tip = ref === null || ref === '' ? tipOf(repo, repo.defaultBranch) : tipOf(repo, ref);
    if (tip === NULL_SHA && repo.refs.size === 0) return fail(404, 'Not Found');
    const found = forge.entryAt(repo, tip, filePath);
    if (found === null) return fail(404, 'Not Found');
    if (found.type === 'file') {
      const blob = repo.objects.get(found.sha);
      if (blob === undefined) return fail(404, 'Not Found');
      return ok({
        name: filePath.split('/').pop(),
        path: filePath,
        sha: found.sha,
        size: blob.data.length,
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        url: '',
        html_url: '',
        download_url: '',
      });
    }
    return ok(directoryListing(forge, repo, tip, filePath));
  }));

  router.add('DELETE', `${P}/repos/:owner/:name/contents/*`, (ctx) => repoOr(ctx, (repo, c) => {
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const filePath = c.params['*'] ?? '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const found = forge.entryAt(repo, tipOf(repo, branch), filePath);
    if (found === null || found.type !== 'file') return fail(404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== found.sha) {
      return fail(409, `${filePath} does not match ${body.sha}`);
    }
    const files = [...forge.filesAtCommit(repo, tipOf(repo, branch)).entries()]
      .filter(([path]) => path !== filePath)
      .map(([path, file]) => ({ path, data: file.data }));
    const commitSha = forge.commitFileSet(repo, branch, files, {
      message: typeof body.message === 'string' && body.message !== '' ? body.message : `delete ${filePath}`,
    });
    return ok({
      content: null,
      commit: { sha: commitSha, node_id: '', url: '', html_url: '', message: String(body.message ?? ''), author: {}, committer: {}, tree: { sha: '', url: '' }, parents: [] },
    });
  }));

  // -- labels & issues -------------------------------------------------------------

  router.add('POST', `${P}/repos/:owner/:name/labels`, (ctx) => repoOr(ctx, (repo, c) => {
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return fail(422, 'Validation Failed');
    if (repo.labels.has(name)) return fail(422, 'Label already exists');
    const maxId = Math.max(0, ...[...repo.labels.values()].map((label) => label.id));
    const label = {
      id: maxId + 1,
      name,
      color: typeof body.color === 'string' ? body.color : 'ededed',
      description: typeof body.description === 'string' ? body.description : '',
    };
    repo.labels.set(name, label);
    return ok(labelJson(label), 201);
  }));

  router.add('POST', `${P}/repos/:owner/:name/issues`, (ctx) => repoOr(ctx, (repo, c) => {
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const title = typeof body.title === 'string' ? body.title : '';
    const labels = Array.isArray(body.labels)
      ? body.labels.map((entry: unknown) => (typeof entry === 'string' ? entry : String((entry as Json)?.name ?? '')))
      : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) return fail(422, `Label ${JSON.stringify(label)} does not exist`);
    }
    const issue = forge.addIssue(repo, { title, body: typeof body.body === 'string' ? body.body : '', labels });
    return ok(issueJson(issue, forge), 201);
  }));

  router.add('GET', `${P}/repos/:owner/:name/issues`, (ctx) => repoOr(ctx, (repo, c) => {
    const state = c.query.get('state') ?? 'open';
    const sort = c.query.get('sort') ?? 'created';
    const direction = c.query.get('direction') ?? 'desc';
    let list = repo.issues.slice();
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => (sort === 'created' ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt));
    if (direction !== 'asc') list.reverse();
    const { page, perPage } = pageParams(ctx, 30);
    return ok(list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(issue, forge)));
  }));

  const issueOr = (repo: RepoRecord, ctx: Ctx): { issue: IssueRecord } | Reply => {
    const number = Number.parseInt(ctx.params.number!, 10);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return fail(404, 'Not Found');
    return { issue };
  };

  router.add('GET', `${P}/repos/:owner/:name/issues/:number`, (ctx) => repoOr(ctx, (repo, c) => {
    const found = issueOr(repo, c);
    return 'status' in found ? found : ok(issueJson(found.issue, forge));
  }));

  router.add('PATCH', `${P}/repos/:owner/:name/issues/:number`, (ctx) => repoOr(ctx, (repo, c) => {
    const found = issueOr(repo, c);
    if ('status' in found) return found;
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    if (body.state === 'open' || body.state === 'closed') {
      found.issue.state = body.state;
      found.issue.closedAt = body.state === 'closed' ? forge.tick() : null;
      found.issue.updatedAt = forge.tick();
    }
    if (typeof body.title === 'string') found.issue.title = body.title;
    if (typeof body.body === 'string') found.issue.body = body.body;
    return ok(issueJson(found.issue, forge));
  }));

  router.add('POST', `${P}/repos/:owner/:name/issues/:number/comments`, (ctx) => repoOr(ctx, (repo, c) => {
    const found = issueOr(repo, c);
    if ('status' in found) return found;
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const comment = forge.addComment(repo, found.issue, typeof body.body === 'string' ? body.body : '');
    return ok(commentJson(comment), 201);
  }));

  router.add('GET', `${P}/repos/:owner/:name/issues/:number/comments`, (ctx) => repoOr(ctx, (repo, c) => {
    const found = issueOr(repo, c);
    if ('status' in found) return found;
    return ok(found.issue.comments.map((comment) => commentJson(comment)));
  }));

  // -- pulls -----------------------------------------------------------------------

  router.add('POST', `${P}/repos/:owner/:name/pulls`, (ctx) => repoOr(ctx, (repo, c) => {
    const body = c.json<Json>();
    if (body === undefined) return fail(400, 'Problems parsing JSON');
    const result = forge.openPull(repo, {
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
      head: branchOf(body.head),
      base: branchOf(body.base),
    });
    if (typeof result === 'string') return fail(422, result);
    return ok(pullJson(forge, repo, result), 201);
  }));

  router.add('GET', `${P}/repos/:owner/:name/pulls`, (ctx) => repoOr(ctx, (repo, c) => {
    const state = c.query.get('state') ?? 'open';
    let list = [...repo.pulls];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => a.createdAt - b.createdAt);
    const { page, perPage } = pageParams(ctx, 30);
    return ok(list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(forge, repo, pull)));
  }));

  const pullOr = (repo: RepoRecord, ctx: Ctx): { pull: PullRecord } | Reply => {
    const number = Number.parseInt(ctx.params.number!, 10);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return fail(404, 'Not Found');
    return { pull };
  };

  router.add('GET', `${P}/repos/:owner/:name/pulls/:number`, (ctx) => repoOr(ctx, (repo, c) => {
    const found = pullOr(repo, c);
    return 'status' in found ? found : ok(pullJson(forge, repo, found.pull));
  }));

  router.add('GET', `${P}/repos/:owner/:name/pulls/:number/files`, (ctx) => repoOr(ctx, (repo, c) => {
    const found = pullOr(repo, c);
    if ('status' in found) return found;
    return ok(forge.pullDiffs(repo, found.pull).map((file) => ({ ...file, blob_url: '', raw_url: '', contents_url: '', sha: '' })));
  }));

  router.add('PUT', `${P}/repos/:owner/:name/pulls/:number/merge`, (ctx) => repoOr(ctx, (repo, c) => {
    const found = pullOr(repo, c);
    if ('status' in found) return found;
    const body = (c.json<Json>() ?? {}) as Json;
    const result = forge.mergePull(repo, found.pull, typeof body.commit_message === 'string' ? body.commit_message : undefined);
    if (!result.ok) {
      if (result.reason === 'Merge conflict') return fail(405, 'Pull Request is not mergeable');
      return fail(422, result.reason);
    }
    return ok({ merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
  }));
}
