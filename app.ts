// HTTP server: health check, authentication, surface routing and REST v3.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BASE_EPOCH,
  ancestors,
  commitFilesMap,
  commitHistory,
  counters,
  createRepo,
  deleteBranch,
  flattenTree,
  getCommit,
  gitObjectSha,
  isTreeMode,
  lookupRepo,
  makeCommit,
  mergeBase,
  nodeId,
  ownerOf,
  parseTree,
  peel,
  readBody,
  resolveCommitish,
  sendJson,
  setBranchTip,
  store,
  storeObject,
  tickIso,
  treeFromFiles,
  viewer,
} from './store.ts';
import type { Comment, FileDiff, HandlerCtx, Issue, Label, Pull, Repo } from './store.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type RC = {
  ctx: HandlerCtx;
  method: string;
  json: Json;
  repo: Repo;
};
type IssueLike = Issue | Pull;

export const HTML_BASE = 'https://forge.local';
export const API = '/api/v3';
const USER_ID = 1000;
const OAUTH_SCOPES = 'repo, read:org';

function reply(status: number, body?: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

function err(status: number, message: string, extra: Json = {}): Reply {
  return { status, body: { message, ...extra } };
}

function notFound(): Reply {
  return err(404, 'Not Found');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function parseIntParam(v: string | null, def: number, min: number, max: number): number {
  if (v === null || v.trim() === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function base64Lines(buf: Buffer): string {
  const b64 = buf.toString('base64');
  let out = '';
  for (let i = 0; i < b64.length; i += 60) out += `${b64.slice(i, i + 60)}\n`;
  return out;
}

function sameBuf(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

function paginate<T>(ctx: HandlerCtx, items: T[]): { items: T[]; headers: Record<string, string> } {
  const perPage = parseIntParam(ctx.url.searchParams.get('per_page'), 30, 1, 100);
  const page = parseIntParam(ctx.url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const host = ctx.req.headers.host ?? 'localhost';
  const linkFor = (p: number): string => {
    const params = new URLSearchParams(ctx.url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${host}${ctx.url.pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page > 1) {
    links.push(`<${linkFor(Math.min(page - 1, last))}>; rel="prev"`);
    links.push(`<${linkFor(1)}>; rel="first"`);
  }
  if (page < last) {
    links.push(`<${linkFor(page + 1)}>; rel="next"`);
    links.push(`<${linkFor(last)}>; rel="last"`);
  }
  const headers: Record<string, string> = {};
  if (links.length > 0) headers.link = links.join(', ');
  return { items: items.slice((page - 1) * perPage, page * perPage), headers };
}

function paged<T>(ctx: HandlerCtx, items: T[]): Reply {
  const p = paginate(ctx, items);
  return reply(200, p.items, p.headers);
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export function simpleUser(login: string): Json {
  return {
    login,
    id: USER_ID,
    node_id: Buffer.from(`04:User${USER_ID}`).toString('base64'),
    avatar_url: '',
    gravatar_id: '',
    url: `${API}/users/${login}`,
    html_url: `${HTML_BASE}/${login}`,
    repos_url: `${API}/users/${login}/repos`,
    type: 'User',
    site_admin: false,
  };
}

export function userJson(login: string): Json {
  return {
    ...simpleUser(login),
    name: login,
    email: `${login}@example.invalid`,
    company: null,
    blog: '',
    location: null,
    bio: null,
    public_repos: [...store.reposByName.values()].filter((r) => !r.private && (r.owner ?? viewer()) === login).length,
    followers: 0,
    following: 0,
    created_at: new Date(BASE_EPOCH * 1000).toISOString(),
    updated_at: new Date(BASE_EPOCH * 1000).toISOString(),
  };
}

export function repoNodeId(repo: Repo): string {
  return Buffer.from(`04:Repository${repo.id}`).toString('base64');
}

function repoApi(repo: Repo): string {
  return `${API}/repos/${ownerOf(repo)}/${repo.name}`;
}

function repoHtml(repo: Repo): string {
  return `${HTML_BASE}/${ownerOf(repo)}/${repo.name}`;
}

export function openIssuesCount(repo: Repo): number {
  let n = 0;
  for (const i of repo.issues.values()) if (i.state === 'open') n++;
  return n;
}

export function repoJson(repo: Repo): Json {
  const owner = ownerOf(repo);
  const api = repoApi(repo);
  const open = openIssuesCount(repo);
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.private,
    owner: simpleUser(owner),
    html_url: repoHtml(repo),
    description: repo.description,
    fork: false,
    url: api,
    issues_url: `${api}/issues{/number}`,
    pulls_url: `${api}/pulls{/number}`,
    labels_url: `${api}/labels{/name}`,
    contents_url: `${api}/contents/{+path}`,
    branches_url: `${api}/branches{/branch}`,
    commits_url: `${api}/commits{/sha}`,
    git_refs_url: `${api}/git/refs{/sha}`,
    clone_url: `${HTML_BASE}/${owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    is_template: false,
    open_issues_count: open,
    license: null,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    forks_count: 0,
    mirror_url: null,
    open_issues: open,
    forks: 0,
    watchers: 0,
    allow_forking: true,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    score: 1,
  };
}

export function labelJson(repo: Repo, label: Label): Json {
  return {
    id: label.id,
    node_id: Buffer.from(`08:Label${label.id}`).toString('base64'),
    url: `${repoApi(repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function labelsOf(repo: Repo, names: string[]): Json[] {
  const out: Json[] = [];
  for (const n of names) {
    const l = repo.labels.get(n);
    if (l) out.push(labelJson(repo, l));
  }
  return out;
}

export function issueJson(repo: Repo, item: IssueLike): Json {
  const api = repoApi(repo);
  const kind = item.isPull ? 'pull' : 'issues';
  const out: Json = {
    id: item.id,
    node_id: Buffer.from(item.isPull ? `06:PullRequest${item.id}` : `05:Issue${item.id}`).toString('base64'),
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    state: item.state,
    state_reason: item.state === 'closed' ? 'completed' : null,
    locked: false,
    labels: labelsOf(repo, item.labels),
    user: simpleUser(viewer()),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.closedAt,
    author_association: 'OWNER',
    html_url: `${repoHtml(repo)}/${kind}/${item.number}`,
    url: `${api}/issues/${item.number}`,
    repository_url: api,
    labels_url: `${api}/issues/${item.number}/labels{/name}`,
    comments_url: `${api}/issues/${item.number}/comments`,
    events_url: `${api}/issues/${item.number}/events`,
  };
  if (item.isPull) {
    out.pull_request = {
      url: `${api}/pulls/${item.number}`,
      html_url: `${repoHtml(repo)}/pull/${item.number}`,
      diff_url: `${repoHtml(repo)}/pull/${item.number}.diff`,
      patch_url: `${repoHtml(repo)}/pull/${item.number}.patch`,
      merged_at: item.mergedAt,
    };
  }
  return out;
}

export function commentJson(repo: Repo, item: IssueLike, c: Comment): Json {
  const api = repoApi(repo);
  return {
    id: c.id,
    node_id: Buffer.from(`012:IssueComment${c.id}`).toString('base64'),
    body: c.body,
    user: simpleUser(viewer()),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: 'OWNER',
    html_url: `${repoHtml(repo)}/${item.isPull ? 'pull' : 'issues'}/${item.number}#issuecomment-${c.id}`,
    url: `${api}/issues/comments/${c.id}`,
    issue_url: `${api}/issues/${item.number}`,
  };
}

function personJson(p: { name: string; email: string; date: string }): Json {
  return { name: p.name, email: p.email, date: p.date };
}

const UNSIGNED = { verified: false, reason: 'unsigned', signature: null, payload: null };

export function gitCommitJson(repo: Repo, sha: string): Json | null {
  const c = getCommit(repo, sha);
  if (!c) return null;
  const api = repoApi(repo);
  return {
    sha,
    node_id: nodeId('Commit', `${repo.id}:${sha}`),
    url: `${api}/git/commits/${sha}`,
    html_url: `${repoHtml(repo)}/commit/${sha}`,
    author: personJson(c.author),
    committer: personJson(c.committer),
    message: c.message,
    tree: { sha: c.tree, url: `${api}/git/trees/${c.tree}` },
    parents: c.parents.map((p) => ({ sha: p, url: `${api}/git/commits/${p}`, html_url: `${repoHtml(repo)}/commit/${p}` })),
    verification: UNSIGNED,
  };
}

export function commitJson(repo: Repo, sha: string): Json | null {
  const c = getCommit(repo, sha);
  if (!c) return null;
  const api = repoApi(repo);
  return {
    sha,
    node_id: nodeId('Commit', `${repo.id}:${sha}`),
    commit: {
      author: personJson(c.author),
      committer: personJson(c.committer),
      message: c.message,
      tree: { sha: c.tree, url: `${api}/git/trees/${c.tree}` },
      url: `${api}/git/commits/${sha}`,
      comment_count: 0,
      verification: UNSIGNED,
    },
    url: `${api}/commits/${sha}`,
    html_url: `${repoHtml(repo)}/commit/${sha}`,
    comments_url: `${api}/commits/${sha}/comments`,
    author: simpleUser(viewer()),
    committer: simpleUser(viewer()),
    parents: c.parents.map((p) => ({ sha: p, url: `${api}/commits/${p}`, html_url: `${repoHtml(repo)}/commit/${p}` })),
  };
}

function refJson(repo: Repo, name: string, sha: string): Json {
  const api = repoApi(repo);
  const type = repo.objects.get(sha)?.type ?? 'commit';
  return {
    ref: name,
    node_id: nodeId('Ref', `${repo.id}:${name}`),
    url: `${api}/git/${encodePath(name)}`,
    object: { sha, type, url: `${api}/git/${type}s/${sha}` },
  };
}

function branchJson(repo: Repo, name: string, sha: string, full: boolean): Json {
  const api = repoApi(repo);
  const commit = full ? commitJson(repo, sha) ?? { sha, url: `${api}/commits/${sha}` } : { sha, url: `${api}/commits/${sha}` };
  const out: Json = { name, commit, protected: false };
  if (full) {
    out._links = { self: `${api}/branches/${encodePath(name)}`, html: `${repoHtml(repo)}/tree/${encodePath(name)}` };
    out.protection = { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } };
    out.protection_url = `${api}/branches/${encodePath(name)}/protection`;
  }
  return out;
}

function contentMeta(repo: Repo, path: string, sha: string, size: number, type: 'file' | 'dir', ref: string): Json {
  const api = repoApi(repo);
  const enc = encodePath(path);
  const url = `${api}/contents/${enc}?ref=${encodeURIComponent(ref)}`;
  const gitUrl = type === 'dir' ? `${api}/git/trees/${sha}` : `${api}/git/blobs/${sha}`;
  const htmlUrl = `${repoHtml(repo)}/${type === 'dir' ? 'tree' : 'blob'}/${encodePath(ref)}/${enc}`;
  const segs = path.split('/');
  const out: Json = {
    type,
    name: segs[segs.length - 1],
    path,
    sha,
    size,
    url,
    html_url: htmlUrl,
    git_url: gitUrl,
    download_url: null,
    _links: { self: url, git: gitUrl, html: htmlUrl },
  };
  // Every file content object (PUT response, GET file, directory entries) carries an encoding.
  if (type === 'file') out.encoding = 'base64';
  return out;
}

// ---------------------------------------------------------------------------
// Working-tree helpers (contents API, pulls, merges)
// ---------------------------------------------------------------------------

/** Files on a branch; empty when the branch does not exist. */
export function currentFiles(repo: Repo, branch?: string): Map<string, Buffer> {
  const b = branch ?? repo.defaultBranch;
  const files = repo.branchFiles.get(b);
  if (files) return files;
  const tip = repo.branchTip.get(b);
  return tip ? commitFilesMap(repo, tip) : new Map();
}

/** Starting point for a commit on a branch (new branches fork from the default branch). */
function branchBase(repo: Repo, branch: string): { files: Map<string, Buffer>; parent: string | null } {
  const tip = repo.branchTip.get(branch);
  if (tip) return { files: currentFiles(repo, branch), parent: tip };
  const def = repo.branchTip.get(repo.defaultBranch);
  if (def) return { files: currentFiles(repo, repo.defaultBranch), parent: def };
  return { files: new Map(), parent: null };
}

export type CommitOpts = { parents?: string[]; authorName?: string; authorEmail?: string };

/** Create blobs + trees + a commit for `files` on `branch` and advance the branch. */
export function commitFiles(repo: Repo, branch: string, files: Map<string, Buffer>, message: string, opts: CommitOpts = {}): string {
  const treeSha = treeFromFiles(repo, files);
  let parents = opts.parents;
  if (!parents) {
    const base = branchBase(repo, branch);
    parents = base.parent ? [base.parent] : [];
  }
  const login = viewer();
  const sha = makeCommit(repo, {
    treeSha,
    parents,
    message,
    authorName: opts.authorName ?? login,
    authorEmail: opts.authorEmail ?? `${login}@example.invalid`,
  });
  repo.branchTip.set(branch, sha);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.branchFiles.set(branch, new Map(files));
  return sha;
}

function authorFrom(json: Json): CommitOpts {
  const src = (json.author ?? json.committer) as Json | undefined;
  if (src && typeof src === 'object') {
    return { authorName: str(src.name), authorEmail: str(src.email) };
  }
  return {};
}

function resolveFiles(repo: Repo, ref: string): Map<string, Buffer> | null {
  const bf = repo.branchFiles.get(ref);
  if (bf) return bf;
  const sha = resolveCommitish(repo, ref);
  return sha ? commitFilesMap(repo, sha) : null;
}

function splitLines(buf: Buffer): string[] {
  const s = buf.toString('utf8');
  if (s.length === 0) return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function lineDiffCounts(oldBuf: Buffer, newBuf: Buffer): { additions: number; deletions: number } {
  const a = splitLines(oldBuf);
  const b = splitLines(newBuf);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length === 0 || y.length === 0 || x.length * y.length > 4_000_000) {
    return { additions: y.length, deletions: x.length };
  }
  let prev = new Uint32Array(y.length + 1);
  let cur = new Uint32Array(y.length + 1);
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < y.length; j++) {
      cur[j + 1] = x[i] === y[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const lcs = prev[y.length];
  return { additions: y.length - lcs, deletions: x.length - lcs };
}

export function diffFiles(repo: Repo, baseFiles: Map<string, Buffer>, headFiles: Map<string, Buffer>, headRef: string): FileDiff[] {
  const api = repoApi(repo);
  const html = repoHtml(repo);
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const out: FileDiff[] = [];
  for (const p of paths) {
    const oldBuf = baseFiles.get(p);
    const newBuf = headFiles.get(p);
    if (sameBuf(oldBuf, newBuf)) continue;
    let status: FileDiff['status'];
    let counts: { additions: number; deletions: number };
    let sha: string;
    if (oldBuf === undefined && newBuf !== undefined) {
      status = 'added';
      counts = { additions: splitLines(newBuf).length, deletions: 0 };
      sha = gitObjectSha('blob', newBuf);
    } else if (newBuf === undefined && oldBuf !== undefined) {
      status = 'removed';
      counts = { additions: 0, deletions: splitLines(oldBuf).length };
      sha = gitObjectSha('blob', oldBuf);
    } else {
      status = 'modified';
      counts = lineDiffCounts(oldBuf as Buffer, newBuf as Buffer);
      sha = gitObjectSha('blob', newBuf as Buffer);
    }
    const enc = encodePath(p);
    out.push({
      sha,
      filename: p,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: `${html}/blob/${encodePath(headRef)}/${enc}`,
      raw_url: `${html}/raw/${encodePath(headRef)}/${enc}`,
      contents_url: `${api}/contents/${enc}?ref=${encodeURIComponent(headRef)}`,
    });
  }
  return out;
}

function headTipOf(repo: Repo, pull: Pull): string {
  return repo.branchTip.get(pull.headRef) ?? pull.headSha;
}

function baseTipOf(repo: Repo, pull: Pull): string {
  return repo.branchTip.get(pull.baseRef) ?? pull.baseSha;
}

type ThreeWay = {
  ancestor: Map<string, Buffer>;
  headFiles: Map<string, Buffer>;
  result: Map<string, Buffer>;
  conflicts: string[];
};

/** Three-way comparison of a pull's head against the current base. */
function threeWay(repo: Repo, pull: Pull): ThreeWay {
  const headTip = headTipOf(repo, pull);
  const baseTip = repo.branchTip.get(pull.baseRef) ?? null;
  const headFiles = repo.branchTip.has(pull.headRef) ? currentFiles(repo, pull.headRef) : commitFilesMap(repo, pull.headSha);
  const baseFiles = baseTip ? currentFiles(repo, pull.baseRef) : new Map<string, Buffer>();
  const mb = baseTip ? mergeBase(repo, headTip, baseTip) : null;
  const ancestor = mb ? commitFilesMap(repo, mb) : pull.baseFilesSnapshot;
  const result = new Map(baseFiles);
  const conflicts: string[] = [];
  const paths = [...new Set([...ancestor.keys(), ...headFiles.keys()])].sort();
  for (const p of paths) {
    const a = ancestor.get(p);
    const h = headFiles.get(p);
    if (sameBuf(a, h)) continue; // not changed on head
    const b = baseFiles.get(p);
    if (!sameBuf(b, a) && !sameBuf(b, h)) {
      conflicts.push(p);
      continue;
    }
    if (h === undefined) result.delete(p);
    else result.set(p, h);
  }
  return { ancestor, headFiles, result, conflicts };
}

function pullFiles(repo: Repo, pull: Pull): FileDiff[] {
  if (pull.merged && pull.changedFiles) return pull.changedFiles;
  const tw = threeWay(repo, pull);
  return diffFiles(repo, tw.ancestor, tw.headFiles, pull.headRef);
}

function pullCommitShas(repo: Repo, pull: Pull): string[] {
  const head = headTipOf(repo, pull);
  const base = baseTipOf(repo, pull);
  const inBase = ancestors(repo, base);
  return commitHistory(repo, head)
    .filter((s) => !inBase.has(s))
    .reverse();
}

export function prJson(repo: Repo, pull: Pull): Json {
  const owner = ownerOf(repo);
  const api = repoApi(repo);
  const html = repoHtml(repo);
  const files = pullFiles(repo, pull);
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  let mergeable: boolean | null = null;
  let mergeableState = 'unknown';
  if (pull.state === 'open') {
    mergeable = threeWay(repo, pull).conflicts.length === 0;
    mergeableState = mergeable ? 'clean' : 'dirty';
  }
  const rj = repoJson(repo);
  const n = pull.number;
  return {
    id: pull.id,
    node_id: Buffer.from(`06:PullRequest${pull.id}`).toString('base64'),
    number: n,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body ?? '',
    user: simpleUser(viewer()),
    labels: labelsOf(repo, pull.labels),
    milestone: null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: headTipOf(repo, pull), repo: rj, user: simpleUser(owner) },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTipOf(repo, pull), repo: rj, user: simpleUser(owner) },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    merged_by: pull.merged ? simpleUser(viewer()) : null,
    mergeable,
    mergeable_state: mergeableState,
    rebaseable: mergeable,
    html_url: `${html}/pull/${n}`,
    url: `${api}/pulls/${n}`,
    issue_url: `${api}/issues/${n}`,
    commits_url: `${api}/pulls/${n}/commits`,
    review_comments_url: `${api}/pulls/${n}/comments`,
    comments_url: `${api}/issues/${n}/comments`,
    diff_url: `${html}/pull/${n}.diff`,
    patch_url: `${html}/pull/${n}.patch`,
    statuses_url: `${api}/statuses/${headTipOf(repo, pull)}`,
    author_association: 'OWNER',
    draft: false,
    comments: pull.comments.length,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: pullCommitShas(repo, pull).length,
    additions,
    deletions,
    changed_files: files.length,
  };
}

// ---------------------------------------------------------------------------
// Top-level REST routes
// ---------------------------------------------------------------------------

function rootJson(): Json {
  return {
    current_user_url: `${API}/user`,
    current_user_repositories_url: `${API}/user/repos{?type,page,per_page,sort}`,
    authorizations_url: `${API}/authorizations`,
    emojis_url: `${API}/emojis`,
    issues_url: `${API}/issues`,
    rate_limit_url: `${API}/rate_limit`,
    repository_url: `${API}/repos/{owner}/{repo}`,
    user_url: `${API}/users/{user}`,
    user_repositories_url: `${API}/users/{user}/repos{?type,page,per_page,sort}`,
    meta_url: `${API}/meta`,
    graphql_url: '/api/graphql',
  };
}

function rateLimitJson(): Json {
  const core = { limit: 5000, used: 0, remaining: 5000, reset: BASE_EPOCH + 3600 };
  return {
    resources: { core, search: { ...core, limit: 30, remaining: 30 }, graphql: core },
    rate: core,
  };
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

function validRepoName(name: unknown): name is string {
  return typeof name === 'string' && REPO_NAME_RE.test(name) && name !== '.' && name !== '..' && name.length <= 100;
}

function ownedRepos(): Repo[] {
  return [...store.reposByName.values()]
    .filter((r) => r.owner === null || r.owner === store.viewerLogin)
    .sort((a, b) => a.id - b.id);
}

function createUserRepo(json: Json): Reply {
  const name = json.name;
  if (!validRepoName(name)) {
    return err(422, 'Validation Failed: name is invalid', {
      errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }],
    });
  }
  if (store.reposByName.has(name)) {
    return err(422, 'Repository creation failed: name already exists on this account', {
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const repo = createRepo(name, {
    private: json.private === true || json.visibility === 'private',
    description: str(json.description) ?? null,
    defaultBranch: str(json.default_branch) || 'main',
  });
  if (json.auto_init === true) {
    commitFiles(repo, repo.defaultBranch, new Map([['README.md', Buffer.from(`# ${name}\n`)]]), 'Initial commit');
  }
  return reply(201, repoJson(repo));
}

async function handleRest(ctx: HandlerCtx): Promise<Reply> {
  const method = (ctx.req.method ?? 'GET').toUpperCase();
  let json: Json = {};
  const raw = ctx.body.toString('utf8');
  if (raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err(400, 'Problems parsing JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return err(400, 'Problems parsing JSON');
    }
    json = parsed as Json;
  }

  const segs = ctx.path
    .slice(API.length)
    .split('/')
    .filter((s) => s.length > 0)
    .map(safeDecode);
  const n = segs.length;
  const isGet = method === 'GET' || method === 'HEAD';

  if (n === 0) {
    return isGet ? reply(200, rootJson(), { 'x-oauth-scopes': OAUTH_SCOPES }) : notFound();
  }
  const top = segs[0];
  if (top === 'meta' && n === 1 && isGet) {
    return reply(200, {
      installed_version: '1.0.0-forge',
      verifiable_password_authentication: false,
      hooks: [],
      git: [],
      web: [],
      api: [],
    });
  }
  if (top === 'rate_limit' && n === 1 && isGet) return reply(200, rateLimitJson());
  if (top === 'user' && n === 1 && isGet) {
    if (store.viewerLogin === null) return notFound();
    return reply(200, userJson(store.viewerLogin), { 'x-oauth-scopes': OAUTH_SCOPES });
  }
  if (top === 'user' && n === 2 && segs[1] === 'repos') {
    if (isGet) return paged(ctx, ownedRepos().map(repoJson));
    if (method === 'POST') return createUserRepo(json);
    return notFound();
  }
  if (top === 'users' && n >= 2 && isGet) {
    const login = segs[1];
    if (login !== store.viewerLogin) return notFound();
    if (n === 2) return reply(200, userJson(login));
    if (n === 3 && segs[2] === 'repos') {
      return paged(ctx, ownedRepos().filter((r) => !r.private).map(repoJson));
    }
    return notFound();
  }
  if (top === 'repos' && n >= 3) {
    const repo = lookupRepo(segs[1], segs[2]);
    if (!repo) return notFound();
    return repoRoutes({ ctx, method, json, repo }, segs.slice(3));
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Repository routes
// ---------------------------------------------------------------------------

function repoRoutes(c: RC, rest: string[]): Reply {
  const { method, repo } = c;
  if (rest.length === 0) {
    if (method === 'GET' || method === 'HEAD') return reply(200, repoJson(repo));
    if (method === 'PATCH') return patchRepo(c);
    if (method === 'DELETE') {
      store.reposByName.delete(repo.name);
      return reply(204);
    }
    return notFound();
  }
  switch (rest[0]) {
    case 'labels':
      return labelRoutes(c, rest.slice(1));
    case 'issues':
      return issueRoutes(c, rest.slice(1));
    case 'contents':
      return contentRoutes(c, rest.slice(1).join('/'));
    case 'git':
      return gitDataRoutes(c, rest.slice(1));
    case 'branches':
      return branchRoutes(c, rest.slice(1));
    case 'commits':
      return commitRoutes(c, rest.slice(1));
    case 'pulls':
      return pullRoutes(c, rest.slice(1));
    default:
      return notFound();
  }
}

function patchRepo(c: RC): Reply {
  const { json, repo } = c;
  if (json.name !== undefined && json.name !== repo.name) {
    if (!validRepoName(json.name)) return err(422, 'Validation Failed: name is invalid');
    if (store.reposByName.has(json.name)) return err(422, 'Validation Failed: name already exists on this account');
    store.reposByName.delete(repo.name);
    repo.name = json.name;
    store.reposByName.set(repo.name, repo);
  }
  if (json.description !== undefined) repo.description = str(json.description) ?? null;
  if (typeof json.private === 'boolean') repo.private = json.private;
  if (json.visibility === 'private' || json.visibility === 'public') repo.private = json.visibility === 'private';
  if (typeof json.default_branch === 'string' && json.default_branch) repo.defaultBranch = json.default_branch;
  repo.updatedAt = tickIso();
  return reply(200, repoJson(repo));
}

// --- labels ----------------------------------------------------------------

function labelRoutes(c: RC, rest: string[]): Reply {
  const { method, json, repo } = c;
  if (rest.length === 0) {
    if (method === 'GET') {
      return paged(c.ctx, [...repo.labels.values()].sort((a, b) => a.id - b.id).map((l) => labelJson(repo, l)));
    }
    if (method === 'POST') {
      const name = str(json.name);
      if (!name || !name.trim()) return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) {
        return err(422, 'Validation Failed: label already exists', {
          errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
        });
      }
      const color = (str(json.color) ?? 'ededed').replace(/^#/, '');
      const label: Label = { id: counters.nextLabelId++, name, color: color || 'ededed', description: str(json.description) ?? null };
      repo.labels.set(name, label);
      return reply(201, labelJson(repo, label));
    }
    return notFound();
  }
  const name = rest.join('/');
  const label = repo.labels.get(name);
  if (!label) return notFound();
  if (method === 'GET') return reply(200, labelJson(repo, label));
  if (method === 'PATCH') {
    const newName = str(json.new_name) ?? str(json.name);
    if (newName && newName !== name) {
      if (repo.labels.has(newName)) return err(422, 'Validation Failed: label already exists');
      repo.labels.delete(name);
      label.name = newName;
      repo.labels.set(newName, label);
      for (const i of [...repo.issues.values(), ...repo.pulls.values()]) {
        i.labels = i.labels.map((l) => (l === name ? newName : l));
      }
    }
    if (typeof json.color === 'string') label.color = json.color.replace(/^#/, '');
    if (json.description !== undefined) label.description = str(json.description) ?? null;
    return reply(200, labelJson(repo, label));
  }
  if (method === 'DELETE') {
    repo.labels.delete(name);
    for (const i of [...repo.issues.values(), ...repo.pulls.values()]) i.labels = i.labels.filter((l) => l !== name);
    return reply(204);
  }
  return notFound();
}

// --- issues ----------------------------------------------------------------

function labelNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string') out.push(x);
    else if (x && typeof x === 'object' && typeof (x as Json).name === 'string') out.push((x as Json).name as string);
    else return null;
  }
  return [...new Set(out)];
}

function checkLabels(repo: Repo, names: string[]): Reply | null {
  for (const n of names) {
    if (!repo.labels.has(n)) {
      return err(422, 'Validation Failed: label does not exist', {
        errors: [{ resource: 'Label', code: 'invalid', field: 'labels', value: n }],
      });
    }
  }
  return null;
}

function findIssueLike(repo: Repo, num: string): IssueLike | null {
  if (!/^\d+$/.test(num)) return null;
  const n = Number(num);
  return repo.issues.get(n) ?? repo.pulls.get(n) ?? null;
}

function issueRoutes(c: RC, rest: string[]): Reply {
  const { method, json, repo, ctx } = c;
  if (rest.length === 0) {
    if (method === 'GET') return listIssues(c);
    if (method === 'POST') {
      const title = typeof json.title === 'number' ? String(json.title) : str(json.title);
      if (!title || !title.trim()) {
        return err(422, 'Validation Failed: title is required', { errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
      }
      let labels: string[] = [];
      if (json.labels !== undefined && json.labels !== null) {
        const names = labelNames(json.labels);
        if (!names) return err(422, 'Validation Failed: labels must be an array of names');
        const bad = checkLabels(repo, names);
        if (bad) return bad;
        labels = names;
      }
      const now = tickIso();
      const issue: Issue = {
        id: counters.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: str(json.body) ?? null,
        state: 'open',
        labels,
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return reply(201, issueJson(repo, issue));
    }
    return notFound();
  }

  const item = findIssueLike(repo, rest[0]);
  if (!item) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return reply(200, issueJson(repo, item));
    if (method === 'PATCH') {
      const r = patchIssueLike(repo, item, json);
      return r ?? reply(200, issueJson(repo, item));
    }
    return notFound();
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') return paged(ctx, item.comments.map((cm) => commentJson(repo, item, cm)));
    if (method === 'POST') {
      const body = str(json.body);
      if (body === undefined || body.length === 0) {
        return err(422, 'Validation Failed: body is required', { errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] });
      }
      const now = tickIso();
      const comment: Comment = { id: counters.nextIssueId++, body, createdAt: now, updatedAt: now };
      item.comments.push(comment);
      item.updatedAt = now;
      return reply(201, commentJson(repo, item, comment));
    }
    return notFound();
  }

  if (rest[1] === 'labels') {
    if (rest.length === 2) {
      if (method === 'GET') return reply(200, labelsOf(repo, item.labels));
      if (method === 'POST' || method === 'PUT') {
        const names = labelNames(Array.isArray(json.labels) ? json.labels : []);
        if (!names) return err(422, 'Validation Failed: labels must be an array of names');
        const bad = checkLabels(repo, names);
        if (bad) return bad;
        item.labels = method === 'PUT' ? names : [...new Set([...item.labels, ...names])];
        item.updatedAt = tickIso();
        return reply(200, labelsOf(repo, item.labels));
      }
      if (method === 'DELETE') {
        item.labels = [];
        item.updatedAt = tickIso();
        return reply(204);
      }
      return notFound();
    }
    if (method === 'DELETE') {
      const name = rest.slice(2).join('/');
      if (!item.labels.includes(name)) return err(404, 'Label does not exist');
      item.labels = item.labels.filter((l) => l !== name);
      item.updatedAt = tickIso();
      return reply(200, labelsOf(repo, item.labels));
    }
  }
  return notFound();
}

function patchIssueLike(repo: Repo, item: IssueLike, json: Json): Reply | null {
  let labels: string[] | null = null;
  if (json.labels !== undefined && json.labels !== null) {
    labels = labelNames(json.labels);
    if (!labels) return err(422, 'Validation Failed: labels must be an array of names');
    const bad = checkLabels(repo, labels);
    if (bad) return bad;
  }
  if (json.state !== undefined && json.state !== 'open' && json.state !== 'closed') {
    return err(422, 'Validation Failed: state must be open or closed');
  }
  if (json.title !== undefined) {
    const t = typeof json.title === 'number' ? String(json.title) : str(json.title);
    if (!t || !t.trim()) return err(422, 'Validation Failed: title cannot be blank');
  }
  if (item.isPull && item.merged && json.state === 'open') {
    return err(422, 'Validation Failed: cannot reopen a merged pull request');
  }
  const now = tickIso();
  if (json.title !== undefined) item.title = String(json.title);
  if (json.body !== undefined) item.body = str(json.body) ?? null;
  if (labels) item.labels = labels;
  if (json.state === 'closed' && item.state !== 'closed') {
    item.state = 'closed';
    item.closedAt = now;
  } else if (json.state === 'open' && item.state !== 'open') {
    item.state = 'open';
    item.closedAt = null;
  }
  item.updatedAt = now;
  return null;
}

function listIssues(c: RC): Reply {
  const { ctx, repo } = c;
  const q = ctx.url.searchParams;
  const state = q.get('state') ?? 'open';
  const sort = q.get('sort') ?? 'created';
  const direction = q.get('direction') === 'asc' ? 'asc' : 'desc';
  const labelFilter = (q.get('labels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let items = [...repo.issues.values()].filter((i) => (state === 'all' ? true : state === 'closed' ? i.state === 'closed' : i.state === 'open'));
  if (labelFilter.length > 0) items = items.filter((i) => labelFilter.every((l) => i.labels.includes(l)));
  const key = (i: Issue): number | string => (sort === 'updated' ? i.updatedAt : sort === 'comments' ? i.comments.length : i.number);
  items.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  return paged(ctx, items.map((i) => issueJson(repo, i)));
}

// --- contents --------------------------------------------------------------

function contentRoutes(c: RC, path: string): Reply {
  const { method } = c;
  if (method === 'GET' || method === 'HEAD') return getContents(c, path);
  if (method === 'PUT') return putContents(c, path);
  if (method === 'DELETE') return deleteContents(c, path);
  return notFound();
}

function getContents(c: RC, path: string): Reply {
  const { repo, ctx } = c;
  const ref = ctx.url.searchParams.get('ref') || repo.defaultBranch;
  if (repo.branchTip.size === 0 && repo.refs.size === 0) return err(404, 'This repository is empty.');
  const files = resolveFiles(repo, ref);
  if (!files) return err(404, `No commit found for the ref ${ref}`);
  const buf = path ? files.get(path) : undefined;
  if (buf) {
    const sha = gitObjectSha('blob', buf);
    return reply(200, { ...contentMeta(repo, path, sha, buf.length, 'file', ref), encoding: 'base64', content: base64Lines(buf) });
  }
  const prefix = path ? `${path}/` : '';
  const entries = new Map<string, { buf?: Buffer; sub?: Map<string, Buffer> }>();
  for (const [p, b] of files) {
    if (!p.startsWith(prefix)) continue;
    const tail = p.slice(prefix.length);
    const i = tail.indexOf('/');
    if (i < 0) {
      entries.set(tail, { buf: b });
    } else {
      const name = tail.slice(0, i);
      let e = entries.get(name);
      if (!e) {
        e = { sub: new Map() };
        entries.set(name, e);
      }
      e.sub?.set(tail.slice(i + 1), b);
    }
  }
  if (path && entries.size === 0) return notFound();
  const names = [...entries.keys()].sort();
  const out: Json[] = [];
  for (const name of names) {
    const e = entries.get(name) as { buf?: Buffer; sub?: Map<string, Buffer> };
    const full = prefix + name;
    if (e.buf) out.push(contentMeta(repo, full, gitObjectSha('blob', e.buf), e.buf.length, 'file', ref));
    else out.push(contentMeta(repo, full, treeFromFiles(repo, e.sub as Map<string, Buffer>), 0, 'dir', ref));
  }
  return reply(200, out);
}

function pathConflict(files: Map<string, Buffer>, path: string): boolean {
  const segs = path.split('/');
  for (let i = 1; i < segs.length; i++) {
    if (files.has(segs.slice(0, i).join('/'))) return true;
  }
  const dirPrefix = `${path}/`;
  for (const p of files.keys()) if (p.startsWith(dirPrefix)) return true;
  return false;
}

function putContents(c: RC, path: string): Reply {
  const { json, repo } = c;
  if (!path) return err(422, 'Invalid request.\n\n"path" wasn\'t supplied.');
  const message = str(json.message);
  if (message === undefined) return err(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const content = str(json.content);
  if (content === undefined) return err(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
  const branch = str(json.branch) || repo.defaultBranch;
  const base = branchBase(repo, branch);
  const files = new Map(base.files);
  const existing = files.get(path);
  if (existing !== undefined) {
    const currentSha = gitObjectSha('blob', existing);
    if (json.sha !== undefined && json.sha !== null && json.sha !== currentSha) {
      return err(409, 'sha does not match');
    }
  } else if (pathConflict(files, path)) {
    return err(422, 'Invalid request: path conflicts with an existing file or directory');
  }
  const bytes = Buffer.from(content, 'base64');
  files.set(path, bytes);
  const commitSha = commitFiles(repo, branch, files, message, {
    ...authorFrom(json),
    parents: base.parent ? [base.parent] : [],
  });
  const blobSha = gitObjectSha('blob', bytes);
  return reply(existing !== undefined ? 200 : 201, {
    content: contentMeta(repo, path, blobSha, bytes.length, 'file', branch),
    commit: gitCommitJson(repo, commitSha),
  });
}

function deleteContents(c: RC, path: string): Reply {
  const { json, repo } = c;
  const branch = str(json.branch) || repo.defaultBranch;
  const tip = repo.branchTip.get(branch);
  if (!tip) return err(404, `Branch ${branch} not found`);
  const files = new Map(currentFiles(repo, branch));
  const existing = path ? files.get(path) : undefined;
  if (existing === undefined) return notFound();
  const message = str(json.message);
  if (message === undefined) return err(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  if (json.sha !== undefined && json.sha !== null && json.sha !== gitObjectSha('blob', existing)) {
    return err(409, 'sha does not match');
  }
  files.delete(path);
  const commitSha = commitFiles(repo, branch, files, message, { ...authorFrom(json), parents: [tip] });
  return reply(200, { content: null, commit: gitCommitJson(repo, commitSha) });
}

// --- git data --------------------------------------------------------------

function gitDataRoutes(c: RC, rest: string[]): Reply {
  const { method, repo } = c;
  const kind = rest[0];
  if (kind === 'refs' || kind === 'ref') {
    if (rest.length === 1) {
      if (kind === 'refs' && method === 'GET') {
        const all = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, sha]) => refJson(repo, name, sha));
        return paged(c.ctx, all);
      }
      if (kind === 'refs' && method === 'POST') return createRef(c);
      return notFound();
    }
    const name = `refs/${rest.slice(1).join('/')}`;
    if (method === 'GET') {
      const sha = repo.refs.get(name);
      if (sha) return reply(200, refJson(repo, name, sha));
      if (kind === 'refs') {
        const matches = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith(`${name}/`))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([r, s]) => refJson(repo, r, s));
        if (matches.length > 0) return reply(200, matches);
      }
      return notFound();
    }
    if (method === 'PATCH' && kind === 'refs') return updateRef(c, name);
    if (method === 'DELETE' && kind === 'refs') {
      if (!repo.refs.has(name)) return err(422, 'Reference does not exist');
      if (name.startsWith('refs/heads/')) deleteBranch(repo, name.slice('refs/heads/'.length));
      else repo.refs.delete(name);
      return reply(204);
    }
    return notFound();
  }
  if (kind === 'blobs') return blobRoutes(c, rest.slice(1));
  if (kind === 'trees') return treeRoutes(c, rest.slice(1));
  if (kind === 'commits') {
    if (rest.length === 1 && method === 'POST') return createGitCommit(c);
    if (rest.length === 2 && method === 'GET') {
      const j = gitCommitJson(repo, rest[1].toLowerCase());
      return j ? reply(200, j) : notFound();
    }
  }
  return notFound();
}

function createRef(c: RC): Reply {
  const { json, repo } = c;
  const ref = str(json.ref);
  const sha = str(json.sha)?.toLowerCase();
  if (!ref || !ref.startsWith('refs/') || ref.split('/').filter((s) => s).length < 3) {
    return err(422, "Reference name must start with 'refs/' and have at least two slashes.");
  }
  if (!sha || !repo.objects.has(sha)) return err(422, 'Object does not exist');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  if (ref.startsWith('refs/heads/')) {
    const target = peel(repo, sha);
    if (repo.objects.get(target)?.type !== 'commit') return err(422, 'Object is not a commit');
    setBranchTip(repo, ref.slice('refs/heads/'.length), target);
  } else {
    repo.refs.set(ref, sha);
  }
  return reply(201, refJson(repo, ref, repo.refs.get(ref) as string));
}

function updateRef(c: RC, name: string): Reply {
  const { json, repo } = c;
  const old = repo.refs.get(name);
  if (!old) return err(422, 'Reference does not exist');
  const sha = str(json.sha)?.toLowerCase();
  if (!sha || !repo.objects.has(sha)) return err(422, 'Object does not exist');
  if (json.force !== true && name.startsWith('refs/heads/') && !ancestors(repo, sha).has(old)) {
    return err(422, 'Update is not a fast forward');
  }
  if (name.startsWith('refs/heads/')) {
    const target = peel(repo, sha);
    if (repo.objects.get(target)?.type !== 'commit') return err(422, 'Object is not a commit');
    setBranchTip(repo, name.slice('refs/heads/'.length), target);
  } else {
    repo.refs.set(name, sha);
  }
  return reply(200, refJson(repo, name, repo.refs.get(name) as string));
}

function blobRoutes(c: RC, rest: string[]): Reply {
  const { method, json, repo } = c;
  const api = repoApi(repo);
  if (rest.length === 0 && method === 'POST') {
    const content = str(json.content);
    if (content === undefined) return err(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
    const buf = json.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    const sha = storeObject(repo, 'blob', buf);
    return reply(201, { sha, url: `${api}/git/blobs/${sha}` });
  }
  if (rest.length === 1 && method === 'GET') {
    const sha = rest[0].toLowerCase();
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'blob') return notFound();
    return reply(200, {
      sha,
      node_id: nodeId('Blob', `${repo.id}:${sha}`),
      size: obj.buf.length,
      url: `${api}/git/blobs/${sha}`,
      content: base64Lines(obj.buf),
      encoding: 'base64',
    });
  }
  return notFound();
}

function treeEntryJson(repo: Repo, path: string, mode: string, sha: string): Json {
  const api = repoApi(repo);
  const obj = repo.objects.get(sha);
  if (isTreeMode(mode)) return { path, mode: '040000', type: 'tree', sha, url: `${api}/git/trees/${sha}` };
  if (mode === '160000') return { path, mode, type: 'commit', sha };
  return { path, mode, type: 'blob', sha, size: obj ? obj.buf.length : 0, url: `${api}/git/blobs/${sha}` };
}

function listTree(repo: Repo, treeSha: string, recursive: boolean, prefix = ''): Json[] {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return [];
  const out: Json[] = [];
  for (const e of parseTree(obj.buf)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    out.push(treeEntryJson(repo, path, e.mode, e.sha));
    if (recursive && isTreeMode(e.mode)) out.push(...listTree(repo, e.sha, true, path));
  }
  return out;
}

function treeRoutes(c: RC, rest: string[]): Reply {
  const { method, json, repo, ctx } = c;
  const api = repoApi(repo);
  if (rest.length === 0 && method === 'POST') {
    if (!Array.isArray(json.tree)) return err(422, 'Invalid request.\n\n"tree" wasn\'t supplied.');
    const files = new Map<string, Buffer>();
    const baseTree = str(json.base_tree);
    if (baseTree) {
      if (repo.objects.get(baseTree)?.type !== 'tree') return err(422, 'Invalid request: base_tree does not exist');
      for (const [p, v] of flattenTree(repo, baseTree)) files.set(p, v.buf);
    }
    for (const raw of json.tree as unknown[]) {
      if (!raw || typeof raw !== 'object') return err(422, 'Invalid request: tree entries must be objects');
      const e = raw as Json;
      const path = (str(e.path) ?? '').split('/').filter((s) => s).join('/');
      if (!path) return err(422, 'Invalid request: tree entry path is required');
      const removeUnder = (): void => {
        files.delete(path);
        for (const p of [...files.keys()]) if (p.startsWith(`${path}/`)) files.delete(p);
      };
      if (e.sha === null) {
        removeUnder();
        continue;
      }
      if (typeof e.content === 'string') {
        files.set(path, Buffer.from(e.content, 'utf8'));
        continue;
      }
      const sha = str(e.sha)?.toLowerCase();
      const obj = sha ? repo.objects.get(sha) : undefined;
      if (!sha || !obj) return err(422, `Invalid request: object ${String(e.sha)} does not exist`);
      if (obj.type === 'blob') files.set(path, obj.buf);
      else if (obj.type === 'tree') {
        removeUnder();
        for (const [p, v] of flattenTree(repo, sha, path)) files.set(p, v.buf);
      } else return err(422, 'Invalid request: unsupported tree entry type');
    }
    const sha = treeFromFiles(repo, files);
    return reply(201, { sha, url: `${api}/git/trees/${sha}`, tree: listTree(repo, sha, false), truncated: false });
  }
  if (rest.length >= 1 && method === 'GET') {
    const ref = rest.join('/');
    let treeSha: string | null = null;
    if (repo.objects.get(ref.toLowerCase())?.type === 'tree') treeSha = ref.toLowerCase();
    else {
      const commit = resolveCommitish(repo, ref);
      if (commit) treeSha = getCommit(repo, commit)?.tree ?? null;
    }
    if (!treeSha) return notFound();
    const recursive = (ctx.url.searchParams.get('recursive') ?? '') !== '' && ctx.url.searchParams.get('recursive') !== '0' && ctx.url.searchParams.get('recursive') !== 'false';
    return reply(200, { sha: treeSha, url: `${api}/git/trees/${treeSha}`, tree: listTree(repo, treeSha, recursive), truncated: false });
  }
  return notFound();
}

function createGitCommit(c: RC): Reply {
  const { json, repo } = c;
  const message = str(json.message);
  if (message === undefined) return err(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const tree = str(json.tree)?.toLowerCase();
  if (!tree || repo.objects.get(tree)?.type !== 'tree') return err(422, 'Invalid request: tree does not exist');
  const parents: string[] = [];
  if (json.parents !== undefined) {
    if (!Array.isArray(json.parents)) return err(422, 'Invalid request: parents must be an array');
    for (const p of json.parents) {
      const s = typeof p === 'string' ? p.toLowerCase() : '';
      if (repo.objects.get(s)?.type !== 'commit') return err(422, `Invalid request: parent ${String(p)} does not exist`);
      parents.push(s);
    }
  }
  const who = authorFrom(json);
  const login = viewer();
  const sha = makeCommit(repo, {
    treeSha: tree,
    parents,
    message,
    authorName: who.authorName ?? login,
    authorEmail: who.authorEmail ?? `${login}@example.invalid`,
  });
  return reply(201, gitCommitJson(repo, sha));
}

// --- branches & commits ----------------------------------------------------

function branchRoutes(c: RC, rest: string[]): Reply {
  const { method, repo, ctx } = c;
  if (method !== 'GET') return notFound();
  if (rest.length === 0) {
    const names = [...repo.branchTip.keys()].sort();
    return paged(ctx, names.map((n) => branchJson(repo, n, repo.branchTip.get(n) as string, false)));
  }
  const name = rest.join('/');
  const sha = repo.branchTip.get(name);
  if (!sha) return err(404, 'Branch not found');
  return reply(200, branchJson(repo, name, sha, true));
}

function commitRoutes(c: RC, rest: string[]): Reply {
  const { method, repo, ctx } = c;
  if (method !== 'GET') return notFound();
  if (rest.length === 0) {
    const ref = ctx.url.searchParams.get('sha') || repo.defaultBranch;
    const tip = resolveCommitish(repo, ref);
    if (!tip) {
      if (repo.branchTip.size === 0) return reply(200, []);
      return err(404, `No commit found for SHA: ${ref}`);
    }
    let shas = commitHistory(repo, tip);
    const pathFilter = (ctx.url.searchParams.get('path') ?? '').split('/').filter((s) => s).join('/');
    if (pathFilter) {
      shas = shas.filter((sha) => {
        const cm = getCommit(repo, sha);
        if (!cm) return false;
        const mine = commitFilesMap(repo, sha);
        const parentFiles = cm.parents.length > 0 ? commitFilesMap(repo, cm.parents[0]) : new Map<string, Buffer>();
        const touched = (files: Map<string, Buffer>): Map<string, Buffer> => {
          const m = new Map<string, Buffer>();
          for (const [p, b] of files) if (p === pathFilter || p.startsWith(`${pathFilter}/`)) m.set(p, b);
          return m;
        };
        const a = touched(parentFiles);
        const b = touched(mine);
        if (a.size !== b.size) return true;
        for (const [p, buf] of b) if (!sameBuf(a.get(p), buf)) return true;
        return false;
      });
    }
    const p = paginate(ctx, shas);
    return reply(200, p.items.map((s) => commitJson(repo, s)), p.headers);
  }
  const ref = rest.join('/');
  const sha = resolveCommitish(repo, ref);
  if (!sha) return err(404, `No commit found for SHA: ${ref}`);
  const base = commitJson(repo, sha) as Json;
  const cm = getCommit(repo, sha);
  const parentFiles = cm && cm.parents.length > 0 ? commitFilesMap(repo, cm.parents[0]) : new Map<string, Buffer>();
  const files = diffFiles(repo, parentFiles, commitFilesMap(repo, sha), sha);
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return reply(200, { ...base, stats: { total: additions + deletions, additions, deletions }, files });
}

// --- pulls -----------------------------------------------------------------

function stripOwner(ref: string): string {
  const i = ref.indexOf(':');
  return i >= 0 ? ref.slice(i + 1) : ref;
}

function findPull(repo: Repo, num: string): Pull | null {
  if (!/^\d+$/.test(num)) return null;
  return repo.pulls.get(Number(num)) ?? null;
}

function pullRoutes(c: RC, rest: string[]): Reply {
  const { method, json, repo, ctx } = c;
  if (rest.length === 0) {
    if (method === 'GET') {
      const q = ctx.url.searchParams;
      const state = q.get('state') ?? 'open';
      const head = q.get('head');
      const base = q.get('base');
      let pulls = [...repo.pulls.values()].filter((p) => (state === 'all' ? true : state === 'closed' ? p.state === 'closed' : p.state === 'open'));
      if (head) pulls = pulls.filter((p) => p.headRef === stripOwner(head));
      if (base) pulls = pulls.filter((p) => p.baseRef === base);
      pulls.sort((a, b) => a.number - b.number);
      if (q.get('direction') === 'desc') pulls.reverse();
      const p = paginate(ctx, pulls);
      return reply(200, p.items.map((pl) => prJson(repo, pl)), p.headers);
    }
    if (method === 'POST') return createPull(c);
    return notFound();
  }
  const pull = findPull(repo, rest[0]);
  if (!pull) return notFound();
  if (rest.length === 1) {
    if (method === 'GET') return reply(200, prJson(repo, pull));
    if (method === 'PATCH') {
      if (json.base !== undefined) {
        const base = stripOwner(String(json.base));
        if (!repo.branchTip.has(base)) return err(422, 'Validation Failed: base ref does not exist');
        if (pull.state === 'open') pull.baseRef = base;
      }
      const r = patchIssueLike(repo, pull, json);
      return r ?? reply(200, prJson(repo, pull));
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') return paged(ctx, pullFiles(repo, pull));
  if (rest.length === 2 && rest[1] === 'commits' && method === 'GET') {
    return paged(ctx, pullCommitShas(repo, pull).map((s) => commitJson(repo, s)));
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method === 'GET') return pull.merged ? reply(204) : notFound();
    if (method === 'PUT') return mergePull(c, pull);
  }
  return notFound();
}

function createPull(c: RC): Reply {
  const { json, repo } = c;
  const title = str(json.title);
  if (!title || !title.trim()) {
    return err(422, 'Validation Failed: title is required', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }] });
  }
  const headRaw = str(json.head);
  const baseRaw = str(json.base);
  if (!headRaw) return err(422, 'Validation Failed: head ref does not exist', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'head' }] });
  if (!baseRaw) return err(422, 'Validation Failed: base ref does not exist', { errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'base' }] });
  const headRef = stripOwner(headRaw);
  const baseRef = stripOwner(baseRaw);
  const headSha = repo.branchTip.get(headRef);
  if (!headSha) return err(422, 'Validation Failed: head ref does not exist', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head' }] });
  const baseSha = repo.branchTip.get(baseRef);
  if (!baseSha) return err(422, 'Validation Failed: base ref does not exist', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'base' }] });
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) {
      return err(422, `Validation Failed: A pull request already exists for ${ownerOf(repo)}:${headRef}.`, {
        errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${ownerOf(repo)}:${headRef}.` }],
      });
    }
  }
  const now = tickIso();
  const pull: Pull = {
    id: counters.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body: str(json.body) ?? null,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    labels: [],
    comments: [],
    baseFilesSnapshot: new Map(currentFiles(repo, baseRef)),
    changedFiles: null,
    isPull: true,
  };
  repo.pulls.set(pull.number, pull);
  return reply(201, prJson(repo, pull));
}

function mergePull(c: RC, pull: Pull): Reply {
  const { json, repo } = c;
  if (pull.merged || pull.state !== 'open') return err(405, 'Pull Request is not mergeable');
  const headTip = headTipOf(repo, pull);
  const expected = str(json.sha);
  if (expected && expected.toLowerCase() !== headTip) {
    return err(409, 'Head branch was modified. Review and try the merge again.');
  }
  const tw = threeWay(repo, pull);
  if (tw.conflicts.length > 0) return err(405, 'Pull Request is not mergeable');
  const changed = diffFiles(repo, tw.ancestor, tw.headFiles, pull.headRef);
  const method = str(json.merge_method) ?? 'squash';
  const baseTip = repo.branchTip.get(pull.baseRef);
  const parents = baseTip ? [baseTip] : [];
  if (method === 'merge') parents.push(headTip);
  let message = str(json.commit_title) || pull.title;
  const extra = str(json.commit_message);
  if (extra) message += `\n\n${extra}`;
  const sha = commitFiles(repo, pull.baseRef, tw.result, message, { parents });
  const now = tickIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.mergeCommitSha = sha;
  pull.headSha = headTip;
  if (baseTip) pull.baseSha = baseTip;
  pull.changedFiles = changed;
  return reply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const GIT_PATH_RE = /^\/[^/]+\/[^/]+\.git(\/|$)/;

function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}` || header === `token ${token}`) return true;
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    return pass === token || user === token;
  }
  return false;
}

function send(res: ServerResponse, r: Reply): void {
  sendJson(res, r.status, r.body, { 'x-oauth-scopes': OAUTH_SCOPES, ...(r.headers ?? {}) });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorized(req)) {
    req.resume();
    const headers: Record<string, string> = {};
    if (GIT_PATH_RE.test(path)) headers['www-authenticate'] = 'Basic realm="forge"';
    sendJson(res, 401, { message: 'Bad credentials' }, headers);
    return;
  }

  const body = await readBody(req);
  const ctx: HandlerCtx = { req, res, url, path, body };

  if (path.startsWith('/api/graphql')) {
    if (await handleGraphQL(ctx)) return;
    send(res, notFound());
    return;
  }
  if (path === '/mcp') {
    if (await handleMCP(ctx)) return;
    send(res, notFound());
    return;
  }
  if (GIT_PATH_RE.test(path)) {
    if (await handleGit(ctx)) return;
    send(res, notFound());
    return;
  }
  if (path === API || path.startsWith(`${API}/`)) {
    send(res, await handleRest(ctx));
    return;
  }
  send(res, notFound());
}

export function createApp(): http.Server {
  return http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      process.stderr.write(`request error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
