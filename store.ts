// Shared in-memory store and deterministic helpers.
//
// Determinism rule: no wall clock and no randomness may influence any value
// returned to clients. Time comes from a logical clock, ids from counters.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Hashing and ids
// ---------------------------------------------------------------------------

export function sha1hex(buf: Buffer | string): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function gitObjectSha(type: string, buf: Buffer): string {
  return sha1hex(Buffer.concat([Buffer.from(`${type} ${buf.length}\0`), buf]));
}

export function nodeId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Logical clock and counters
// ---------------------------------------------------------------------------

function parseBaseEpoch(raw: string | undefined): number {
  const DEFAULT = 1735689600;
  const text = (raw ?? '').trim();
  if (!text) return DEFAULT;
  const n = Number(text);
  if (Number.isFinite(n)) {
    // Accept millisecond epochs too.
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return DEFAULT;
}

export const BASE_EPOCH: number = parseBaseEpoch(process.env.MAKEFUN_TRIAL_NOW);

export const counters = {
  nextRepoId: 1001,
  nextIssueId: 1,
  nextLabelId: 1,
  nextRequestSeq: 1,
  clock: 0,
};

/** Advance the logical clock and return epoch seconds. */
export function tickEpoch(): number {
  counters.clock += 1;
  return BASE_EPOCH + counters.clock;
}

/** Advance the logical clock and return an ISO-8601 timestamp. */
export function tickIso(): string {
  return epochToIso(tickEpoch());
}

export function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type Label = { id: number; name: string; color: string; description: string | null };

export type Comment = { id: number; body: string; createdAt: string; updatedAt: string };

export type Issue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  isPull: false;
};

export type FileDiff = {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
};

export type Pull = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  labels: string[];
  comments: Comment[];
  baseFilesSnapshot: Map<string, Buffer>;
  changedFiles: FileDiff[] | null;
  isPull: true;
};

export type GitObject = { type: string; buf: Buffer };

export type Repo = {
  id: number;
  name: string;
  owner: string | null;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssueNumber: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  branchFiles: Map<string, Map<string, Buffer>>;
  branchTip: Map<string, string>;
};

export const store = {
  reposByName: new Map<string, Repo>(),
  viewerLogin: null as string | null,
};

export function viewer(): string {
  return store.viewerLogin ?? 'octocat';
}

export function learnOwner(owner: string, repo: Repo): void {
  if (repo.owner === null) repo.owner = owner;
  if (store.viewerLogin === null) store.viewerLogin = owner;
}

export function lookupRepo(owner: string, name: string): Repo | null {
  const repo = store.reposByName.get(name);
  if (!repo) return null;
  if (repo.owner === null) {
    learnOwner(owner, repo);
    return repo;
  }
  return repo.owner === owner ? repo : null;
}

export function createRepo(
  name: string,
  opts: { private?: boolean; description?: string | null; defaultBranch?: string; owner?: string | null } = {},
): Repo {
  const now = tickIso();
  const repo: Repo = {
    id: counters.nextRepoId++,
    name,
    owner: opts.owner ?? null,
    private: opts.private ?? false,
    description: opts.description ?? null,
    defaultBranch: opts.defaultBranch || 'main',
    createdAt: now,
    updatedAt: now,
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextIssueNumber: 1,
    objects: new Map(),
    refs: new Map(),
    branchFiles: new Map(),
    branchTip: new Map(),
  };
  store.reposByName.set(name, repo);
  return repo;
}

export function ownerOf(repo: Repo): string {
  return repo.owner ?? viewer();
}

// ---------------------------------------------------------------------------
// Git object helpers
// ---------------------------------------------------------------------------

export function storeObject(repo: Repo, type: string, buf: Buffer): string {
  const sha = gitObjectSha(type, buf);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, buf });
  return sha;
}

export type CommitInput = {
  treeSha: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
};

export function makeCommit(repo: Repo, input: CommitInput): string {
  const epoch = tickEpoch();
  const person = `${input.authorName} <${input.authorEmail}> ${epoch} +0000`;
  let text = `tree ${input.treeSha}\n`;
  for (const p of input.parents) text += `parent ${p}\n`;
  text += `author ${person}\ncommitter ${person}\n\n${input.message}`;
  if (!text.endsWith('\n')) text += '\n';
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

type TreeNode = Map<string, Buffer | TreeNode>;

function treeSortKey(name: string, isTree: boolean): Buffer {
  return Buffer.from(isTree ? `${name}/` : name, 'utf8');
}

function writeTreeNode(repo: Repo, node: TreeNode): string {
  const entries: { name: string; mode: string; sha: string; key: Buffer }[] = [];
  for (const [name, value] of node) {
    if (Buffer.isBuffer(value)) {
      entries.push({ name, mode: '100644', sha: storeObject(repo, 'blob', value), key: treeSortKey(name, false) });
    } else {
      entries.push({ name, mode: '40000', sha: writeTreeNode(repo, value), key: treeSortKey(name, true) });
    }
  }
  entries.sort((a, b) => Buffer.compare(a.key, b.key));
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

/** Build (and store) nested git trees for a flat path -> content map. */
export function treeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  const root: TreeNode = new Map();
  for (const [path, buf] of files) {
    const segs = path.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = node.get(segs[i]);
      if (next === undefined || Buffer.isBuffer(next)) {
        next = new Map();
        node.set(segs[i], next);
      }
      node = next;
    }
    node.set(segs[segs.length - 1], buf);
  }
  return writeTreeNode(repo, root);
}

export type TreeEntry = { mode: string; name: string; sha: string };

export function parseTree(buf: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = buf.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > buf.length) break;
    const mode = buf.subarray(i, sp).toString('utf8');
    const name = buf.subarray(sp + 1, nul).toString('utf8');
    const sha = buf.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Recursively walk a tree, returning blob entries keyed by full path. */
export function flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { sha: string; buf: Buffer }> {
  const out = new Map<string, { sha: string; buf: Buffer }>();
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.buf)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (isTreeMode(e.mode)) {
      for (const [p, v] of flattenTree(repo, e.sha, path)) out.set(p, v);
    } else if (e.mode === '160000') {
      continue; // submodule (gitlink): no content stored here
    } else {
      const blob = repo.objects.get(e.sha);
      if (blob) out.set(path, { sha: e.sha, buf: blob.buf });
    }
  }
  return out;
}

export type Person = { name: string; email: string; epoch: number; tz: string; date: string };

export type ParsedCommit = {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
};

export function parsePerson(text: string): Person {
  const m = /^(.*?) ?<([^>]*)> (\d+) ([+-]\d{4})$/.exec(text.trim());
  if (!m) return { name: text.trim(), email: '', epoch: BASE_EPOCH, tz: '+0000', date: epochToIso(BASE_EPOCH) };
  const epoch = Number(m[3]);
  return { name: m[1], email: m[2], epoch, tz: m[4], date: epochToIso(epoch) };
}

export function parseCommit(buf: Buffer): ParsedCommit {
  const text = buf.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep >= 0 ? text.slice(0, sep) : text;
  let message = sep >= 0 ? text.slice(sep + 2) : '';
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = '';
  const parents: string[] = [];
  let author = parsePerson('');
  let committer = parsePerson('');
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation (e.g. gpgsig)
    const sp = line.indexOf(' ');
    const key = sp >= 0 ? line.slice(0, sp) : line;
    const value = sp >= 0 ? line.slice(sp + 1) : '';
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = parsePerson(value);
    else if (key === 'committer') committer = parsePerson(value);
  }
  return { tree, parents, author, committer, message };
}

export function getCommit(repo: Repo, sha: string): ParsedCommit | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.buf);
}

/** Path -> content for the tree of a commit. */
export function commitFilesMap(repo: Repo, commitSha: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const c = getCommit(repo, commitSha);
  if (!c) return out;
  for (const [p, v] of flattenTree(repo, c.tree)) out.set(p, v.buf);
  return out;
}

/** Peel annotated tags down to the object they point at. */
export function peel(repo: Repo, sha: string): string {
  let cur = sha;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})/m.exec(obj.buf.toString('utf8'));
    if (!m) return cur;
    cur = m[1];
  }
  return cur;
}

/** Resolve a branch name, ref name, tag or (abbreviated) sha to a commit sha. */
export function resolveCommitish(repo: Repo, ref: string): string | null {
  if (!ref) return null;
  const direct =
    repo.branchTip.get(ref) ??
    repo.refs.get(ref) ??
    repo.refs.get(`refs/heads/${ref}`) ??
    repo.refs.get(`refs/tags/${ref}`);
  if (direct) {
    const sha = peel(repo, direct);
    return repo.objects.get(sha)?.type === 'commit' ? sha : null;
  }
  const lower = ref.toLowerCase();
  if (/^[0-9a-f]{40}$/.test(lower)) {
    const sha = peel(repo, lower);
    return repo.objects.get(sha)?.type === 'commit' ? sha : null;
  }
  if (/^[0-9a-f]{4,39}$/.test(lower)) {
    let found: string | null = null;
    for (const [sha, obj] of repo.objects) {
      if (obj.type === 'commit' && sha.startsWith(lower)) {
        if (found !== null) return null; // ambiguous
        found = sha;
      }
    }
    return found;
  }
  return null;
}

/** Point a branch at a commit, keeping refs, tips and working files in sync. */
export function setBranchTip(repo: Repo, branch: string, sha: string): void {
  repo.branchTip.set(branch, sha);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.branchFiles.set(branch, commitFilesMap(repo, sha));
}

export function deleteBranch(repo: Repo, branch: string): void {
  repo.branchTip.delete(branch);
  repo.refs.delete(`refs/heads/${branch}`);
  repo.branchFiles.delete(branch);
}

/** All commits reachable from sha (inclusive). */
export function ancestors(repo: Repo, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    const c = getCommit(repo, cur);
    if (!c) continue;
    seen.add(cur);
    for (const p of c.parents) if (!seen.has(p)) stack.push(p);
  }
  return seen;
}

/** A best common ancestor of two commits (breadth-first from b), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = ancestors(repo, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (fromA.has(cur)) return cur;
    const c = getCommit(repo, cur);
    if (c) for (const p of c.parents) queue.push(p);
  }
  return null;
}

/** Commits reachable from tip, newest first (by committer time, then discovery order). */
export function commitHistory(repo: Repo, tip: string): string[] {
  const all = [...ancestors(repo, tip)];
  const order = new Map<string, number>();
  // discovery order by BFS from tip for stable tie-breaking
  const queue = [tip];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (order.has(cur)) continue;
    order.set(cur, order.size);
    const c = getCommit(repo, cur);
    if (c) for (const p of c.parents) queue.push(p);
  }
  const epochs = new Map<string, number>();
  for (const sha of all) epochs.set(sha, getCommit(repo, sha)?.committer.epoch ?? 0);
  all.sort((x, y) => (epochs.get(y) as number) - (epochs.get(x) as number) || (order.get(x) ?? 0) - (order.get(y) ?? 0));
  return all;
}

// ---------------------------------------------------------------------------
// HTTP helpers shared by all surfaces
// ---------------------------------------------------------------------------

export type HandlerCtx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  body: Buffer;
};

export type SurfaceHandler = (ctx: HandlerCtx) => boolean | Promise<boolean>;

export function nextRequestId(): string {
  return `req-${counters.nextRequestSeq++}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const h: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...headers,
  };
  if (status === 204 || status === 304 || body === undefined) {
    h['content-length'] = '0';
    res.writeHead(status, h);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  h['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, h);
  res.end(text);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
