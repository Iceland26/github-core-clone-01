// Model Context Protocol surface (/mcp).
// Implements JSON-RPC 2.0 over streamable HTTP sharing the in-memory store with REST, GraphQL, and git.

import type { IncomingMessage } from 'node:http';
import {
  ancestors,
  commitFilesMap,
  commitHistory,
  counters,
  createRepo,
  gitObjectSha,
  lookupRepo,
  makeCommit,
  mergeBase,
  nextRequestId,
  ownerOf,
  sendJson,
  store,
  tickIso,
  treeFromFiles,
  viewer,
} from './store.ts';
import type { FileDiff, HandlerCtx, Issue, Label, Pull, Repo } from './store.ts';

const HTML_BASE = 'https://forge.local';
const API = '/api/v3';
const USER_ID = 1000;
const SESSION_ID = 'forge-session-1';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const SERVER_INFO = {
  name: 'forge-mcp',
  version: '1.0.0',
} as const;

// ---------------------------------------------------------------------------
// Module-level Tool Definitions (built once for byte-for-byte identical replies)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository in the forge.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository metadata by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body text' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'State filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body text' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const TOOLS_LIST_RESULT = { tools: TOOLS } as const;
const TOOLS_LIST_RESULT_JSON = JSON.stringify(TOOLS_LIST_RESULT);

type ToolName = (typeof TOOLS)[number]['name'];
const TOOL_NAMES: readonly ToolName[] = TOOLS.map((t) => t.name);

// ---------------------------------------------------------------------------
// Auth & REST-equivalent JSON Shaping
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type IssueLike = Issue | Pull;

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

function simpleUser(login: string): Json {
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

function repoApi(repo: Repo): string {
  return `${API}/repos/${ownerOf(repo)}/${repo.name}`;
}

function repoHtml(repo: Repo): string {
  return `${HTML_BASE}/${ownerOf(repo)}/${repo.name}`;
}

function openIssuesCount(repo: Repo): number {
  let n = 0;
  for (const i of repo.issues.values()) if (i.state === 'open') n++;
  return n;
}

function repoJson(repo: Repo): Json {
  const owner = ownerOf(repo);
  const api = repoApi(repo);
  const open = openIssuesCount(repo);
  return {
    id: repo.id,
    node_id: Buffer.from(`04:Repository${repo.id}`).toString('base64'),
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

function labelJson(repo: Repo, label: Label): Json {
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

function issueJson(repo: Repo, item: IssueLike): Json {
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

function sameBuf(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
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

function currentFiles(repo: Repo, branch?: string): Map<string, Buffer> {
  const b = branch ?? repo.defaultBranch;
  const files = repo.branchFiles.get(b);
  if (files) return files;
  const tip = repo.branchTip.get(b);
  return tip ? commitFilesMap(repo, tip) : new Map();
}

function branchBase(repo: Repo, branch: string): { files: Map<string, Buffer>; parent: string | null } {
  const tip = repo.branchTip.get(branch);
  if (tip) return { files: currentFiles(repo, branch), parent: tip };
  const def = repo.branchTip.get(repo.defaultBranch);
  if (def) return { files: currentFiles(repo, repo.defaultBranch), parent: def };
  return { files: new Map(), parent: null };
}

function commitFiles(
  repo: Repo,
  branch: string,
  files: Map<string, Buffer>,
  message: string,
  opts: { parents?: string[]; authorName?: string; authorEmail?: string } = {},
): string {
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

function diffFiles(repo: Repo, baseFiles: Map<string, Buffer>, headFiles: Map<string, Buffer>, headRef: string): FileDiff[] {
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
    if (sameBuf(a, h)) continue;
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

function prJson(repo: Repo, pull: Pull): Json {
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
// MCP Tool Execution
// ---------------------------------------------------------------------------

function resolveToolName(raw: unknown): ToolName | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const name = raw.trim();
  for (const t of TOOL_NAMES) {
    if (name === t) return t;
  }
  const lower = name.toLowerCase();
  for (const t of TOOL_NAMES) {
    if (lower === t || lower.endsWith(t)) return t;
  }
  return null;
}

function toolSuccess(payload: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): Json {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function extractOwnerAndRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner.trim() : '';
  let repo =
    typeof args.repo === 'string'
      ? args.repo.trim()
      : typeof args.repository === 'string'
        ? args.repository.trim()
        : '';

  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    if (!owner) owner = o.trim();
    if (!repo) repo = r.trim();
  }
  if (repo.includes('/')) {
    const [o, r] = repo.split('/', 2);
    if (!owner) owner = o.trim();
    repo = r.trim();
  }
  return { owner, repo };
}

function cleanRef(raw: string): string {
  let r = raw.trim();
  if (r.startsWith('refs/heads/')) r = r.slice('refs/heads/'.length);
  const idx = r.indexOf(':');
  if (idx >= 0) r = r.slice(idx + 1);
  return r;
}

function callTool(tool: ToolName, args: Record<string, unknown>): Json {
  switch (tool) {
    case 'create_repo': {
      let name = typeof args.name === 'string' ? args.name.trim() : typeof args.repo === 'string' ? args.repo.trim() : '';
      let ownerArg = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : null;
      if (!name && typeof args.full_name === 'string' && args.full_name.includes('/')) {
        const [o, r] = args.full_name.split('/', 2);
        if (!ownerArg && o.trim()) ownerArg = o.trim();
        name = r.trim();
      } else if (name.includes('/')) {
        const [o, r] = name.split('/', 2);
        if (!ownerArg && o.trim()) ownerArg = o.trim();
        name = r.trim();
      }
      if (!name) return toolError('missing required argument: name');
      if (ownerArg && store.viewerLogin === null) {
        store.viewerLogin = ownerArg;
      }
      const existing = store.reposByName.get(name);
      if (existing) {
        return toolError(`Repository '${name}' already exists`);
      }
      const repo = createRepo(name, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : null,
        defaultBranch: typeof args.default_branch === 'string' && args.default_branch ? args.default_branch : 'main',
        owner: ownerArg,
      });
      if (args.auto_init === true) {
        commitFiles(repo, repo.defaultBranch, new Map([['README.md', Buffer.from(`# ${name}\n`)]]), 'Initial commit');
      }
      return toolSuccess(repoJson(repo));
    }

    case 'get_repo': {
      const { owner, repo: repoName } = extractOwnerAndRepo(args);
      if (!owner) return toolError('missing required argument: owner');
      if (!repoName) return toolError('missing required argument: repo');
      const repo = lookupRepo(owner, repoName);
      if (!repo) return toolError('Not Found');
      return toolSuccess(repoJson(repo));
    }

    case 'create_issue': {
      const { owner, repo: repoName } = extractOwnerAndRepo(args);
      if (!owner) return toolError('missing required argument: owner');
      if (!repoName) return toolError('missing required argument: repo');
      const title =
        typeof args.title === 'number' ? String(args.title) : typeof args.title === 'string' ? args.title : '';
      if (!title.trim()) return toolError('missing required argument: title');
      const repo = lookupRepo(owner, repoName);
      if (!repo) return toolError('Repository not found');
      const now = tickIso();
      const issue: Issue = {
        id: counters.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return toolSuccess(issueJson(repo, issue));
    }

    case 'list_issues': {
      const { owner, repo: repoName } = extractOwnerAndRepo(args);
      if (!owner) return toolError('missing required argument: owner');
      if (!repoName) return toolError('missing required argument: repo');
      const repo = lookupRepo(owner, repoName);
      if (!repo) return toolError('Repository not found');
      const stateRaw = typeof args.state === 'string' && args.state.trim() ? args.state.trim().toLowerCase() : 'open';
      const items = [...repo.issues.values()]
        .filter((i) => (stateRaw === 'all' ? true : stateRaw === 'closed' ? i.state === 'closed' : i.state === 'open'))
        .sort((a, b) => b.number - a.number)
        .map((i) => issueJson(repo, i));
      return toolSuccess(items);
    }

    case 'create_pull_request': {
      const { owner, repo: repoName } = extractOwnerAndRepo(args);
      if (!owner) return toolError('missing required argument: owner');
      if (!repoName) return toolError('missing required argument: repo');
      const title =
        typeof args.title === 'number' ? String(args.title) : typeof args.title === 'string' ? args.title : '';
      if (!title.trim()) return toolError('missing required argument: title');
      const headRaw =
        typeof args.head === 'string'
          ? args.head
          : typeof args.headRefName === 'string'
            ? args.headRefName
            : '';
      if (!headRaw.trim()) return toolError('missing required argument: head');
      const baseRaw =
        typeof args.base === 'string'
          ? args.base
          : typeof args.baseRefName === 'string'
            ? args.baseRefName
            : '';
      if (!baseRaw.trim()) return toolError('missing required argument: base');

      const repo = lookupRepo(owner, repoName);
      if (!repo) return toolError('Repository not found');
      const headRef = cleanRef(headRaw);
      const baseRef = cleanRef(baseRaw);
      const headSha = repo.branchTip.get(headRef);
      if (!headSha) return toolError(`Head branch '${headRef}' does not exist`);
      const baseSha = repo.branchTip.get(baseRef);
      if (!baseSha) return toolError(`Base branch '${baseRef}' does not exist`);

      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) {
          return toolError(`A pull request already exists for ${ownerOf(repo)}:${headRef}`);
        }
      }

      const now = tickIso();
      const pull: Pull = {
        id: counters.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : null,
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
      return toolSuccess(prJson(repo, pull));
    }

    case 'merge_pull_request': {
      const { owner, repo: repoName } = extractOwnerAndRepo(args);
      if (!owner) return toolError('missing required argument: owner');
      if (!repoName) return toolError('missing required argument: repo');
      const rawNum = args.pull_number ?? args.number ?? args.pullNumber ?? args.pr_number;
      if (rawNum === undefined || rawNum === null || rawNum === '') {
        return toolError('missing required argument: pull_number');
      }
      const pullNumber = Number(rawNum);
      if (!Number.isFinite(pullNumber) || pullNumber <= 0) {
        return toolError('invalid argument: pull_number');
      }
      const repo = lookupRepo(owner, repoName);
      if (!repo) return toolError('Repository not found');
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return toolError('Pull Request not found');
      if (pull.merged || pull.state !== 'open') {
        return toolError('Pull Request is not mergeable');
      }
      const headTip = headTipOf(repo, pull);
      const expected = typeof args.sha === 'string' ? args.sha : typeof args.expectedHeadOid === 'string' ? args.expectedHeadOid : '';
      if (expected && expected.toLowerCase() !== headTip) {
        return toolError('Head branch was modified. Review and try the merge again.');
      }
      const tw = threeWay(repo, pull);
      if (tw.conflicts.length > 0) {
        return toolError('Pull Request is not mergeable');
      }
      const changed = diffFiles(repo, tw.ancestor, tw.headFiles, pull.headRef);
      const methodRaw = typeof args.merge_method === 'string' ? args.merge_method.toLowerCase() : 'squash';
      const baseTip = repo.branchTip.get(pull.baseRef);
      const parents = baseTip ? [baseTip] : [];
      if (methodRaw === 'merge') parents.push(headTip);
      let message = typeof args.commit_title === 'string' && args.commit_title ? args.commit_title : pull.title;
      if (typeof args.commit_message === 'string' && args.commit_message) {
        message += `\n\n${args.commit_message}`;
      }
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
      return toolSuccess({
        sha,
        merged: true,
        message: 'Pull Request successfully merged',
        number: pull.number,
        pull_number: pull.number,
        state: pull.state,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Request Dispatcher
// ---------------------------------------------------------------------------

type RpcResponse =
  | { kind: 'notification' }
  | { kind: 'raw_json'; text: string }
  | { kind: 'object'; body: Json };

function handleOneRpc(reqObj: unknown): RpcResponse {
  if (!reqObj || typeof reqObj !== 'object' || Array.isArray(reqObj)) {
    return {
      kind: 'object',
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }

  const rpc = reqObj as Record<string, unknown>;
  const hasId = 'id' in rpc && rpc.id !== undefined;
  const id = hasId ? (rpc.id as string | number | null) : null;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params =
    rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
      ? (rpc.params as Record<string, unknown>)
      : {};

  // Notifications (no id)
  if (!hasId) {
    return { kind: 'notification' };
  }

  if (!method) {
    return {
      kind: 'object',
      body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } },
    };
  }

  if (method === 'server/discover') {
    return {
      kind: 'object',
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      },
    };
  }

  if (method === 'initialize') {
    const reqVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(reqVersion)
      ? reqVersion
      : '2025-11-25';
    return {
      kind: 'object',
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      },
    };
  }

  if (method === 'ping') {
    return {
      kind: 'object',
      body: { jsonrpc: '2.0', id, result: {} },
    };
  }

  if (method === 'tools/list') {
    return {
      kind: 'raw_json',
      text: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_LIST_RESULT_JSON}}`,
    };
  }

  if (method === 'tools/call') {
    const tool = resolveToolName(params.name);
    if (!tool) {
      return {
        kind: 'object',
        body: {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `unknown tool: ${String(params.name ?? '')}` },
        },
      };
    }
    const rawArgs =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const result = callTool(tool, rawArgs);
    return {
      kind: 'object',
      body: {
        jsonrpc: '2.0',
        id,
        result,
      },
    };
  }

  return {
    kind: 'object',
    body: {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    },
  };
}

function sendRawJson(ctx: HandlerCtx, status: number, text: string): void {
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'mcp-session-id': SESSION_ID,
    'content-length': String(Buffer.byteLength(text)),
  });
  ctx.res.end(text);
}

// ---------------------------------------------------------------------------
// HTTP Entry Point
// ---------------------------------------------------------------------------

export async function handleMCP(ctx: HandlerCtx): Promise<boolean> {
  if (!isAuthorized(ctx.req)) {
    sendJson(ctx.res, 401, { message: 'Bad credentials' });
    return true;
  }

  const method = (ctx.req.method ?? 'GET').toUpperCase();
  if (method === 'DELETE') {
    ctx.res.writeHead(204, {
      'x-github-request-id': nextRequestId(),
      'mcp-session-id': SESSION_ID,
      'content-length': '0',
    });
    ctx.res.end();
    return true;
  }
  if (method !== 'POST') {
    return false;
  }

  const raw = ctx.body.toString('utf8').trim();
  if (!raw) {
    sendJson(
      ctx.res,
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { 'mcp-session-id': SESSION_ID },
    );
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(
      ctx.res,
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { 'mcp-session-id': SESSION_ID },
    );
    return true;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(
        ctx.res,
        400,
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
        { 'mcp-session-id': SESSION_ID },
      );
      return true;
    }
    const outParts: string[] = [];
    for (const item of parsed) {
      const r = handleOneRpc(item);
      if (r.kind === 'raw_json') outParts.push(r.text);
      else if (r.kind === 'object') outParts.push(JSON.stringify(r.body));
    }
    if (outParts.length === 0) {
      ctx.res.writeHead(202, {
        'x-github-request-id': nextRequestId(),
        'mcp-session-id': SESSION_ID,
        'content-length': '0',
      });
      ctx.res.end();
      return true;
    }
    sendRawJson(ctx, 200, `[${outParts.join(',')}]`);
    return true;
  }

  const resItem = handleOneRpc(parsed);
  if (resItem.kind === 'notification') {
    ctx.res.writeHead(202, {
      'x-github-request-id': nextRequestId(),
      'mcp-session-id': SESSION_ID,
      'content-length': '0',
    });
    ctx.res.end();
    return true;
  }
  if (resItem.kind === 'raw_json') {
    sendRawJson(ctx, 200, resItem.text);
    return true;
  }
  sendJson(ctx.res, 200, resItem.body, { 'mcp-session-id': SESSION_ID });
  return true;
}
