// GraphQL surface (/api/graphql).
// Implements a GraphQL tokenizer, recursive-descent parser, and selection-set executor
// sharing the in-memory store with REST, git, and MCP.

import type { IncomingMessage } from 'node:http';
import {
  BASE_EPOCH,
  ancestors,
  commitFilesMap,
  commitHistory,
  counters,
  getCommit,
  gitObjectSha,
  lookupRepo,
  makeCommit,
  mergeBase,
  nextRequestId,
  nodeId,
  ownerOf,
  sendJson,
  store,
  tickIso,
  treeFromFiles,
  viewer,
} from './store.ts';
import type { Comment, FileDiff, HandlerCtx, Issue, Pull, Repo } from './store.ts';

const HTML_BASE = 'https://forge.local';
const API = '/api/v3';
const USER_ID = 1000;
const ZERO_SHA = '0'.repeat(40);

// ---------------------------------------------------------------------------
// Auth & Shared Git/PR helpers
// ---------------------------------------------------------------------------

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
  const owner = ownerOf(repo);
  const api = `${API}/repos/${owner}/${repo.name}`;
  const html = `${HTML_BASE}/${owner}/${repo.name}`;
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

// ---------------------------------------------------------------------------
// GraphQL Tokenizer & Parser
// ---------------------------------------------------------------------------

type TokenKind =
  | 'Name'
  | 'Int'
  | 'Float'
  | 'String'
  | 'Bang'
  | 'Dollar'
  | 'ParenL'
  | 'ParenR'
  | 'Spread'
  | 'Colon'
  | 'Equals'
  | 'At'
  | 'BracketL'
  | 'BracketR'
  | 'BraceL'
  | 'Pipe'
  | 'BraceR'
  | 'EOF';

type Token = {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
};

class GraphQLSyntaxError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const len = source.length;
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  while (pos < len) {
    const ch = source.charCodeAt(pos);

    // Whitespace, comma, BOM
    if (ch === 0x20 || ch === 0x09 || ch === 0x2c || ch === 0xfeff) {
      pos++;
      continue;
    }
    if (ch === 0x0a) {
      pos++;
      line++;
      lineStart = pos;
      continue;
    }
    if (ch === 0x0d) {
      pos++;
      if (pos < len && source.charCodeAt(pos) === 0x0a) pos++;
      line++;
      lineStart = pos;
      continue;
    }
    // Comment #
    if (ch === 0x23) {
      pos++;
      while (pos < len && source.charCodeAt(pos) !== 0x0a && source.charCodeAt(pos) !== 0x0d) {
        pos++;
      }
      continue;
    }

    const col = pos - lineStart + 1;

    // Punctuators
    if (ch === 0x21) {
      tokens.push({ kind: 'Bang', value: '!', line, col });
      pos++;
      continue;
    }
    if (ch === 0x24) {
      tokens.push({ kind: 'Dollar', value: '$', line, col });
      pos++;
      continue;
    }
    if (ch === 0x28) {
      tokens.push({ kind: 'ParenL', value: '(', line, col });
      pos++;
      continue;
    }
    if (ch === 0x29) {
      tokens.push({ kind: 'ParenR', value: ')', line, col });
      pos++;
      continue;
    }
    if (ch === 0x2e) {
      if (pos + 2 < len && source.charCodeAt(pos + 1) === 0x2e && source.charCodeAt(pos + 2) === 0x2e) {
        tokens.push({ kind: 'Spread', value: '...', line, col });
        pos += 3;
        continue;
      }
      throw new GraphQLSyntaxError(`Unexpected character '.'`, line, col);
    }
    if (ch === 0x3a) {
      tokens.push({ kind: 'Colon', value: ':', line, col });
      pos++;
      continue;
    }
    if (ch === 0x3d) {
      tokens.push({ kind: 'Equals', value: '=', line, col });
      pos++;
      continue;
    }
    if (ch === 0x40) {
      tokens.push({ kind: 'At', value: '@', line, col });
      pos++;
      continue;
    }
    if (ch === 0x5b) {
      tokens.push({ kind: 'BracketL', value: '[', line, col });
      pos++;
      continue;
    }
    if (ch === 0x5d) {
      tokens.push({ kind: 'BracketR', value: ']', line, col });
      pos++;
      continue;
    }
    if (ch === 0x7b) {
      tokens.push({ kind: 'BraceL', value: '{', line, col });
      pos++;
      continue;
    }
    if (ch === 0x7c) {
      tokens.push({ kind: 'Pipe', value: '|', line, col });
      pos++;
      continue;
    }
    if (ch === 0x7d) {
      tokens.push({ kind: 'BraceR', value: '}', line, col });
      pos++;
      continue;
    }

    // Name: [_A-Za-z][_0-9A-Za-z]*
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || ch === 0x5f) {
      const start = pos;
      pos++;
      while (pos < len) {
        const c = source.charCodeAt(pos);
        if (
          (c >= 0x41 && c <= 0x5a) ||
          (c >= 0x61 && c <= 0x7a) ||
          (c >= 0x30 && c <= 0x39) ||
          c === 0x5f
        ) {
          pos++;
        } else {
          break;
        }
      }
      tokens.push({ kind: 'Name', value: source.slice(start, pos), line, col });
      continue;
    }

    // Number: -?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?
    if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
      const start = pos;
      let isFloat = false;
      if (ch === 0x2d) pos++;
      if (pos >= len || source.charCodeAt(pos) < 0x30 || source.charCodeAt(pos) > 0x39) {
        throw new GraphQLSyntaxError('Invalid number', line, col);
      }
      while (pos < len && source.charCodeAt(pos) >= 0x30 && source.charCodeAt(pos) <= 0x39) pos++;
      if (pos < len && source.charCodeAt(pos) === 0x2e) {
        isFloat = true;
        pos++;
        if (pos >= len || source.charCodeAt(pos) < 0x30 || source.charCodeAt(pos) > 0x39) {
          throw new GraphQLSyntaxError('Invalid float number', line, col);
        }
        while (pos < len && source.charCodeAt(pos) >= 0x30 && source.charCodeAt(pos) <= 0x39) pos++;
      }
      if (pos < len && (source.charCodeAt(pos) === 0x65 || source.charCodeAt(pos) === 0x45)) {
        isFloat = true;
        pos++;
        if (pos < len && (source.charCodeAt(pos) === 0x2b || source.charCodeAt(pos) === 0x2d)) pos++;
        if (pos >= len || source.charCodeAt(pos) < 0x30 || source.charCodeAt(pos) > 0x39) {
          throw new GraphQLSyntaxError('Invalid exponent in number', line, col);
        }
        while (pos < len && source.charCodeAt(pos) >= 0x30 && source.charCodeAt(pos) <= 0x39) pos++;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: source.slice(start, pos), line, col });
      continue;
    }

    // String or Block String
    if (ch === 0x22) {
      // Check for """
      if (pos + 2 < len && source.charCodeAt(pos + 1) === 0x22 && source.charCodeAt(pos + 2) === 0x22) {
        pos += 3;
        let out = '';
        let closed = false;
        while (pos < len) {
          if (
            pos + 2 < len &&
            source.charCodeAt(pos) === 0x22 &&
            source.charCodeAt(pos + 1) === 0x22 &&
            source.charCodeAt(pos + 2) === 0x22
          ) {
            pos += 3;
            closed = true;
            break;
          }
          if (
            pos + 3 < len &&
            source.charCodeAt(pos) === 0x5c &&
            source.charCodeAt(pos + 1) === 0x22 &&
            source.charCodeAt(pos + 2) === 0x22 &&
            source.charCodeAt(pos + 3) === 0x22
          ) {
            out += '"""';
            pos += 4;
            continue;
          }
          const c = source.charCodeAt(pos);
          if (c === 0x0a) {
            out += '\n';
            pos++;
            line++;
            lineStart = pos;
          } else if (c === 0x0d) {
            out += '\n';
            pos++;
            if (pos < len && source.charCodeAt(pos) === 0x0a) pos++;
            line++;
            lineStart = pos;
          } else {
            out += source[pos++];
          }
        }
        if (!closed) throw new GraphQLSyntaxError('Unterminated block string', line, col);
        tokens.push({ kind: 'String', value: out, line, col });
        continue;
      }

      // Normal string
      pos++;
      let out = '';
      let closed = false;
      while (pos < len) {
        const c = source.charCodeAt(pos);
        if (c === 0x22) {
          pos++;
          closed = true;
          break;
        }
        if (c === 0x0a || c === 0x0d) {
          throw new GraphQLSyntaxError('Unterminated string literal', line, col);
        }
        if (c === 0x5c) {
          pos++;
          if (pos >= len) throw new GraphQLSyntaxError('Unterminated string escape', line, col);
          const esc = source[pos++];
          switch (esc) {
            case '"':
              out += '"';
              break;
            case '\\':
              out += '\\';
              break;
            case '/':
              out += '/';
              break;
            case 'b':
              out += '\b';
              break;
            case 'f':
              out += '\f';
              break;
            case 'n':
              out += '\n';
              break;
            case 'r':
              out += '\r';
              break;
            case 't':
              out += '\t';
              break;
            case 'u': {
              const hex = source.slice(pos, pos + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                throw new GraphQLSyntaxError('Invalid unicode escape in string', line, col);
              }
              out += String.fromCharCode(Number.parseInt(hex, 16));
              pos += 4;
              break;
            }
            default:
              out += esc;
              break;
          }
        } else {
          out += source[pos++];
        }
      }
      if (!closed) throw new GraphQLSyntaxError('Unterminated string', line, col);
      tokens.push({ kind: 'String', value: out, line, col });
      continue;
    }

    throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(source[pos])}`, line, col);
  }

  tokens.push({ kind: 'EOF', value: '', line, col: pos - lineStart + 1 });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST Types
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Record<string, ValueNode> };

type DirectiveNode = {
  name: string;
  args: Record<string, ValueNode>;
};

type FieldNode = {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
  line: number;
  col: number;
};

type InlineFragmentNode = {
  kind: 'InlineFragment';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
};

type FragmentSpreadNode = {
  kind: 'FragmentSpread';
  name: string;
  directives: DirectiveNode[];
};

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

type VarDef = {
  name: string;
  defaultValue?: ValueNode;
};

type OperationDef = {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: VarDef[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
};

type FragmentDef = {
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
};

type DocumentNode = {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
};

function parseDocument(source: string): DocumentNode {
  const tokens = tokenize(source);
  let idx = 0;

  function peek(): Token {
    return tokens[idx];
  }

  function next(): Token {
    return tokens[idx++];
  }

  function expect(kind: TokenKind): Token {
    const t = peek();
    if (t.kind !== kind) {
      throw new GraphQLSyntaxError(`Expected ${kind}, got ${t.kind} (${t.value})`, t.line, t.col);
    }
    idx++;
    return t;
  }

  function parseValue(): ValueNode {
    const t = peek();
    if (t.kind === 'Dollar') {
      next();
      const nameTok = expect('Name');
      return { kind: 'Variable', name: nameTok.value };
    }
    if (t.kind === 'Int') {
      next();
      return { kind: 'Int', value: Number.parseInt(t.value, 10) };
    }
    if (t.kind === 'Float') {
      next();
      return { kind: 'Float', value: Number.parseFloat(t.value) };
    }
    if (t.kind === 'String') {
      next();
      return { kind: 'String', value: t.value };
    }
    if (t.kind === 'Name') {
      next();
      if (t.value === 'true') return { kind: 'Boolean', value: true };
      if (t.value === 'false') return { kind: 'Boolean', value: false };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    if (t.kind === 'BracketL') {
      next();
      const values: ValueNode[] = [];
      while (peek().kind !== 'BracketR') {
        if (peek().kind === 'EOF') throw new GraphQLSyntaxError('Unterminated list value', t.line, t.col);
        values.push(parseValue());
      }
      expect('BracketR');
      return { kind: 'List', values };
    }
    if (t.kind === 'BraceL') {
      next();
      const fields: Record<string, ValueNode> = {};
      while (peek().kind !== 'BraceR') {
        if (peek().kind === 'EOF') throw new GraphQLSyntaxError('Unterminated input object', t.line, t.col);
        const fName = expect('Name').value;
        expect('Colon');
        fields[fName] = parseValue();
      }
      expect('BraceR');
      return { kind: 'Object', fields };
    }
    throw new GraphQLSyntaxError(`Unexpected value token ${t.kind} (${t.value})`, t.line, t.col);
  }

  function parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (peek().kind !== 'ParenL') return args;
    next();
    while (peek().kind !== 'ParenR') {
      if (peek().kind === 'EOF') throw new GraphQLSyntaxError('Unterminated argument list', peek().line, peek().col);
      const argName = expect('Name').value;
      expect('Colon');
      args[argName] = parseValue();
    }
    expect('ParenR');
    return args;
  }

  function parseDirectives(): DirectiveNode[] {
    const dirs: DirectiveNode[] = [];
    while (peek().kind === 'At') {
      next();
      const name = expect('Name').value;
      const args = parseArguments();
      dirs.push({ name, args });
    }
    return dirs;
  }

  function skipTypeAnnotation(): void {
    if (peek().kind === 'BracketL') {
      next();
      skipTypeAnnotation();
      expect('BracketR');
    } else {
      expect('Name');
    }
    if (peek().kind === 'Bang') next();
  }

  function parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    if (peek().kind !== 'ParenL') return defs;
    next();
    while (peek().kind !== 'ParenR') {
      if (peek().kind === 'EOF') throw new GraphQLSyntaxError('Unterminated variable definitions', peek().line, peek().col);
      expect('Dollar');
      const name = expect('Name').value;
      expect('Colon');
      skipTypeAnnotation();
      let defaultValue: ValueNode | undefined;
      if (peek().kind === 'Equals') {
        next();
        defaultValue = parseValue();
      }
      parseDirectives();
      defs.push({ name, defaultValue });
    }
    expect('ParenR');
    return defs;
  }

  function parseSelectionSet(): SelectionNode[] {
    expect('BraceL');
    const selections: SelectionNode[] = [];
    while (peek().kind !== 'BraceR') {
      if (peek().kind === 'EOF') throw new GraphQLSyntaxError('Unterminated selection set', peek().line, peek().col);
      if (peek().kind === 'Spread') {
        next();
        if (peek().kind === 'Name' && peek().value === 'on') {
          next();
          const typeCond = expect('Name').value;
          const directives = parseDirectives();
          const selectionSet = parseSelectionSet();
          selections.push({ kind: 'InlineFragment', typeCondition: typeCond, directives, selectionSet });
        } else if (peek().kind === 'BraceL' || peek().kind === 'At') {
          const directives = parseDirectives();
          const selectionSet = parseSelectionSet();
          selections.push({ kind: 'InlineFragment', typeCondition: null, directives, selectionSet });
        } else {
          const fragName = expect('Name').value;
          const directives = parseDirectives();
          selections.push({ kind: 'FragmentSpread', name: fragName, directives });
        }
      } else {
        const firstTok = expect('Name');
        let alias: string | null = null;
        let name = firstTok.value;
        let line = firstTok.line;
        let col = firstTok.col;
        if (peek().kind === 'Colon') {
          next();
          alias = firstTok.value;
          const fieldTok = expect('Name');
          name = fieldTok.value;
          line = fieldTok.line;
          col = fieldTok.col;
        }
        const args = parseArguments();
        const directives = parseDirectives();
        const selectionSet = peek().kind === 'BraceL' ? parseSelectionSet() : null;
        selections.push({ kind: 'Field', alias, name, args, directives, selectionSet, line, col });
      }
    }
    expect('BraceR');
    return selections;
  }

  const operations: OperationDef[] = [];
  const fragments = new Map<string, FragmentDef>();

  while (peek().kind !== 'EOF') {
    const t = peek();
    if (t.kind === 'BraceL') {
      const selectionSet = parseSelectionSet();
      operations.push({
        operation: 'query',
        name: null,
        variableDefinitions: [],
        directives: [],
        selectionSet,
      });
    } else if (t.kind === 'Name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      next();
      const opType = t.value === 'mutation' ? 'mutation' : 'query';
      let name: string | null = null;
      if (peek().kind === 'Name') {
        name = next().value;
      }
      const variableDefinitions = parseVariableDefinitions();
      const directives = parseDirectives();
      const selectionSet = parseSelectionSet();
      operations.push({ operation: opType, name, variableDefinitions, directives, selectionSet });
    } else if (t.kind === 'Name' && t.value === 'fragment') {
      next();
      const name = expect('Name').value;
      const onTok = expect('Name');
      if (onTok.value !== 'on') {
        throw new GraphQLSyntaxError(`Expected 'on' in fragment definition`, onTok.line, onTok.col);
      }
      const typeCondition = expect('Name').value;
      const directives = parseDirectives();
      const selectionSet = parseSelectionSet();
      fragments.set(name, { name, typeCondition, directives, selectionSet });
    } else {
      throw new GraphQLSyntaxError(`Unexpected token ${t.kind} (${t.value}) at top level`, t.line, t.col);
    }
  }

  if (operations.length === 0) {
    throw new GraphQLSyntaxError('Document contains no operations', 1, 1);
  }

  return { operations, fragments };
}

// ---------------------------------------------------------------------------
// Schema Introspection Data
// ---------------------------------------------------------------------------

type IntrospectionField = {
  __typename: '__Field';
  name: string;
  description: null;
  args: never[];
  type: { __typename: '__Type'; name: string | null; kind: string; ofType: null };
  isDeprecated: false;
  deprecationReason: null;
};

type IntrospectionEnumVal = {
  __typename: '__EnumValue';
  name: string;
  description: null;
  isDeprecated: false;
  deprecationReason: null;
};

function makeObjectType(name: string, fieldNames: string[]) {
  const fields: IntrospectionField[] = fieldNames.map((fn) => ({
    __typename: '__Field',
    name: fn,
    description: null,
    args: [],
    type: { __typename: '__Type', name: null, kind: 'SCALAR', ofType: null },
    isDeprecated: false,
    deprecationReason: null,
  }));
  return {
    __typename: '__Type',
    name,
    kind: 'OBJECT',
    description: null,
    fields: () => fields,
    enumValues: () => null,
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => null,
    ofType: null,
  };
}

function makeEnumType(name: string, values: string[]) {
  const enumValues: IntrospectionEnumVal[] = values.map((v) => ({
    __typename: '__EnumValue',
    name: v,
    description: null,
    isDeprecated: false,
    deprecationReason: null,
  }));
  return {
    __typename: '__Type',
    name,
    kind: 'ENUM',
    description: null,
    fields: () => null,
    enumValues: () => enumValues,
    inputFields: () => null,
    interfaces: () => null,
    possibleTypes: () => null,
    ofType: null,
  };
}

const INTROSPECTION_TYPES: Record<string, ReturnType<typeof makeObjectType>> = {
  Issue: makeObjectType('Issue', [
    'id',
    'databaseId',
    'number',
    'title',
    'body',
    'bodyText',
    'state',
    'stateReason',
    'closed',
    'author',
    'authorAssociation',
    'labels',
    'comments',
    'assignees',
    'createdAt',
    'updatedAt',
    'closedAt',
    'url',
    'repository',
  ]),
  PullRequest: makeObjectType('PullRequest', [
    'id',
    'databaseId',
    'number',
    'title',
    'body',
    'bodyText',
    'state',
    'closed',
    'merged',
    'mergedAt',
    'mergedBy',
    'mergeCommit',
    'mergeable',
    'mergeStateStatus',
    'isDraft',
    'headRefName',
    'baseRefName',
    'headRefOid',
    'baseRefOid',
    'headRef',
    'baseRef',
    'files',
    'additions',
    'deletions',
    'changedFiles',
    'commits',
    'author',
    'authorAssociation',
    'labels',
    'comments',
    'createdAt',
    'updatedAt',
    'closedAt',
    'url',
    'repository',
  ]),
  Repository: makeObjectType('Repository', [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'isPrivate',
    'visibility',
    'description',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
    'url',
    'sshUrl',
    'createdAt',
    'updatedAt',
    'pushedAt',
    'isArchived',
    'isFork',
    'isEmpty',
  ]),
  User: makeObjectType('User', ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl']),
  IssueComment: makeObjectType('IssueComment', [
    'id',
    'databaseId',
    'body',
    'bodyText',
    'author',
    'authorAssociation',
    'createdAt',
    'updatedAt',
    'url',
  ]),
  Query: makeObjectType('Query', ['viewer', 'user', 'repository', 'node', 'rateLimit', '__type', '__schema']),
  Mutation: makeObjectType('Mutation', [
    'createIssue',
    'closeIssue',
    'reopenIssue',
    'updateIssue',
    'createPullRequest',
    'mergePullRequest',
    'addComment',
  ]),
  SearchType: makeEnumType('SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION']),
  IssueState: makeEnumType('IssueState', ['OPEN', 'CLOSED']),
  PullRequestState: makeEnumType('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']),
  PullRequestMergeMethod: makeEnumType('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']),
};

// ---------------------------------------------------------------------------
// Resolver Builders
// ---------------------------------------------------------------------------

type ResolverFn = (args: Record<string, unknown>) => unknown;
type ResolverObj = { __typename?: string; [key: string]: unknown };

function makeCursor(num: number): string {
  return Buffer.from(`cursor:${num}`).toString('base64');
}

function makeUserResolver(login: string): ResolverObj {
  return {
    __typename: 'User',
    id: Buffer.from(`04:User${USER_ID}`).toString('base64'),
    databaseId: USER_ID,
    login,
    name: login,
    email: `${login}@example.invalid`,
    url: `${HTML_BASE}/${login}`,
    avatarUrl: '',
  };
}

function makeCommitResolver(repo: Repo, sha: string): ResolverObj {
  const cm = getCommit(repo, sha);
  const login = viewer();
  const owner = ownerOf(repo);
  const headline = (cm?.message ?? '').split('\n')[0] ?? '';
  const bodyLines = (cm?.message ?? '').split('\n').slice(1).join('\n').replace(/^\n+/, '');
  return {
    __typename: 'Commit',
    id: nodeId('Commit', `${repo.id}:${sha}`),
    oid: sha,
    abbreviatedOid: sha.slice(0, 7),
    message: cm?.message ?? '',
    messageHeadline: headline,
    messageBody: bodyLines,
    committedDate: cm?.committer.date ?? repo.updatedAt,
    authoredDate: cm?.author.date ?? repo.updatedAt,
    author: {
      __typename: 'GitActor',
      name: cm?.author.name ?? login,
      email: cm?.author.email ?? `${login}@example.invalid`,
      date: cm?.author.date ?? repo.updatedAt,
      user: makeUserResolver(login),
    },
    committer: {
      __typename: 'GitActor',
      name: cm?.committer.name ?? login,
      email: cm?.committer.email ?? `${login}@example.invalid`,
      date: cm?.committer.date ?? repo.updatedAt,
      user: makeUserResolver(login),
    },
    url: `${HTML_BASE}/${owner}/${repo.name}/commit/${sha}`,
  };
}

function makeCommentResolver(repo: Repo, item: Issue | Pull, c: Comment): ResolverObj {
  const owner = ownerOf(repo);
  const kind = item.isPull ? 'pull' : 'issues';
  return {
    __typename: 'IssueComment',
    id: Buffer.from(`07:IssueComment${c.id}`).toString('base64'),
    databaseId: c.id,
    body: c.body,
    bodyText: c.body,
    author: makeUserResolver(viewer()),
    authorAssociation: 'OWNER',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    url: `${HTML_BASE}/${owner}/${repo.name}/${kind}/${item.number}#issuecomment-${c.id}`,
  };
}

function makeLabelsConnection(repo: Repo, labelNames: string[], args: Record<string, unknown>): ResolverObj {
  const allNodes = labelNames.map((n) => {
    const lbl = repo.labels.get(n);
    return {
      __typename: 'Label',
      id: Buffer.from(`08:Label${lbl?.id ?? 0}`).toString('base64'),
      name: n,
      color: lbl?.color ?? 'ededed',
      description: lbl?.description ?? null,
    };
  });
  const first = typeof args.first === 'number' ? args.first : allNodes.length;
  const nodes = allNodes.slice(0, first);
  return {
    __typename: 'LabelConnection',
    totalCount: allNodes.length,
    nodes,
    edges: nodes.map((nd, idx) => ({
      __typename: 'LabelEdge',
      cursor: makeCursor(idx + 1),
      node: nd,
    })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: allNodes.length > first,
      hasPreviousPage: false,
      startCursor: nodes.length > 0 ? makeCursor(1) : null,
      endCursor: nodes.length > 0 ? makeCursor(nodes.length) : null,
    },
  };
}

function makeCommentsConnection(repo: Repo, item: Issue | Pull, args: Record<string, unknown>): ResolverObj {
  const allNodes = item.comments.map((c) => makeCommentResolver(repo, item, c));
  const first = typeof args.first === 'number' ? args.first : allNodes.length;
  const nodes = allNodes.slice(0, first);
  return {
    __typename: 'IssueCommentConnection',
    totalCount: allNodes.length,
    nodes,
    edges: nodes.map((nd, idx) => ({
      __typename: 'IssueCommentEdge',
      cursor: makeCursor(idx + 1),
      node: nd,
    })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: allNodes.length > first,
      hasPreviousPage: false,
      startCursor: nodes.length > 0 ? makeCursor(1) : null,
      endCursor: nodes.length > 0 ? makeCursor(nodes.length) : null,
    },
  };
}

function makeIssueResolver(repo: Repo, issue: Issue): ResolverObj {
  const owner = ownerOf(repo);
  return {
    __typename: 'Issue',
    id: Buffer.from(`05:Issue${issue.id}`).toString('base64'),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    bodyText: issue.body ?? '',
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    stateReason: issue.state === 'closed' ? 'COMPLETED' : null,
    closed: issue.state === 'closed',
    author: makeUserResolver(viewer()),
    authorAssociation: 'OWNER',
    labels: (args: Record<string, unknown>) => makeLabelsConnection(repo, issue.labels, args),
    comments: (args: Record<string, unknown>) => makeCommentsConnection(repo, issue, args),
    assignees: () => ({
      __typename: 'UserConnection',
      totalCount: 0,
      nodes: [],
      edges: [],
      pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `${HTML_BASE}/${owner}/${repo.name}/issues/${issue.number}`,
    repository: () => makeRepoResolver(repo),
  };
}

function makePullResolver(repo: Repo, pull: Pull): ResolverObj {
  const owner = ownerOf(repo);
  const headOid = headTipOf(repo, pull);
  const baseOid = baseTipOf(repo, pull);
  const diffs = pullFiles(repo, pull);
  let additions = 0;
  let deletions = 0;
  for (const f of diffs) {
    additions += f.additions;
    deletions += f.deletions;
  }
  const gqlState = pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';

  return {
    __typename: 'PullRequest',
    id: Buffer.from(`06:PullRequest${pull.id}`).toString('base64'),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    bodyText: pull.body ?? '',
    state: gqlState,
    closed: pull.state === 'closed' || pull.merged,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergedBy: pull.merged ? makeUserResolver(viewer()) : null,
    mergeCommit: pull.mergeCommitSha ? makeCommitResolver(repo, pull.mergeCommitSha) : null,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    isDraft: false,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: headOid,
    baseRefOid: baseOid,
    headRef: {
      __typename: 'Ref',
      id: nodeId('Ref', `${repo.id}:refs/heads/${pull.headRef}`),
      name: pull.headRef,
      prefix: 'refs/heads/',
      target: makeCommitResolver(repo, headOid),
    },
    baseRef: {
      __typename: 'Ref',
      id: nodeId('Ref', `${repo.id}:refs/heads/${pull.baseRef}`),
      name: pull.baseRef,
      prefix: 'refs/heads/',
      target: makeCommitResolver(repo, baseOid),
    },
    author: makeUserResolver(viewer()),
    authorAssociation: 'OWNER',
    files: (args: Record<string, unknown>) => {
      const allNodes = diffs.map((f) => ({
        __typename: 'PullRequestChangedFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      const first = typeof args.first === 'number' ? args.first : allNodes.length;
      const nodes = allNodes.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        totalCount: allNodes.length,
        nodes,
        edges: nodes.map((nd, idx) => ({
          __typename: 'PullRequestChangedFileEdge',
          cursor: makeCursor(idx + 1),
          node: nd,
        })),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: allNodes.length > first,
          hasPreviousPage: false,
          startCursor: nodes.length > 0 ? makeCursor(1) : null,
          endCursor: nodes.length > 0 ? makeCursor(nodes.length) : null,
        },
      };
    },
    additions,
    deletions,
    changedFiles: diffs.length,
    commits: (args: Record<string, unknown>) => {
      const shas = pullCommitShas(repo, pull);
      const allNodes = shas.map((sha) => {
        const cmNode = makeCommitResolver(repo, sha);
        return {
          __typename: 'PullRequestCommit',
          id: nodeId('PullRequestCommit', `${repo.id}:${pull.number}:${sha}`),
          oid: sha,
          message: cmNode.message,
          commit: cmNode,
          url: `${HTML_BASE}/${owner}/${repo.name}/pull/${pull.number}/commits/${sha}`,
        };
      });
      const first = typeof args.first === 'number' ? args.first : allNodes.length;
      const nodes = allNodes.slice(0, first);
      return {
        __typename: 'PullRequestCommitConnection',
        totalCount: allNodes.length,
        nodes,
        edges: nodes.map((nd, idx) => ({
          __typename: 'PullRequestCommitEdge',
          cursor: makeCursor(idx + 1),
          node: nd,
        })),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: allNodes.length > first,
          hasPreviousPage: false,
          startCursor: nodes.length > 0 ? makeCursor(1) : null,
          endCursor: nodes.length > 0 ? makeCursor(nodes.length) : null,
        },
      };
    },
    labels: (args: Record<string, unknown>) => makeLabelsConnection(repo, pull.labels, args),
    comments: (args: Record<string, unknown>) => makeCommentsConnection(repo, pull, args),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    url: `${HTML_BASE}/${owner}/${repo.name}/pull/${pull.number}`,
    repository: () => makeRepoResolver(repo),
  };
}

function normalizeStatesArg(raw: unknown): Set<string> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return new Set([raw.toUpperCase()]);
  if (Array.isArray(raw)) {
    const out = new Set<string>();
    for (const x of raw) {
      if (typeof x === 'string') out.add(x.toUpperCase());
    }
    return out.size > 0 ? out : null;
  }
  return null;
}

function makeRepoResolver(repo: Repo): ResolverObj {
  const owner = ownerOf(repo);
  const branchName = repo.branchTip.has(repo.defaultBranch)
    ? repo.defaultBranch
    : (repo.branchTip.keys().next().value ?? repo.defaultBranch);
  const tipSha = repo.branchTip.get(branchName) ?? repo.refs.get(`refs/heads/${branchName}`) ?? ZERO_SHA;

  return {
    __typename: 'Repository',
    id: Buffer.from(`04:Repository${repo.id}`).toString('base64'),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: makeUserResolver(owner),
    defaultBranchRef: {
      __typename: 'Ref',
      id: nodeId('Ref', `${repo.id}:refs/heads/${branchName}`),
      name: branchName,
      prefix: 'refs/heads/',
      target: makeCommitResolver(repo, tipSha),
    },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
    description: repo.description,
    url: `${HTML_BASE}/${owner}/${repo.name}`,
    sshUrl: `git@forge.local:${owner}/${repo.name}.git`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.updatedAt,
    isArchived: false,
    isFork: false,
    isEmpty: repo.branchTip.size === 0 && repo.refs.size === 0,
    issue: (args: Record<string, unknown>) => {
      const n = Number(args.number);
      const iss = repo.issues.get(n);
      return iss ? makeIssueResolver(repo, iss) : null;
    },
    issues: (args: Record<string, unknown>) => {
      const statesSet = normalizeStatesArg(args.states);
      let list = [...repo.issues.values()];
      if (statesSet) {
        list = list.filter((i) => statesSet.has(i.state === 'closed' ? 'CLOSED' : 'OPEN'));
      }
      const orderBy = (args.orderBy && typeof args.orderBy === 'object' ? args.orderBy : null) as {
        field?: string;
        direction?: string;
      } | null;
      const dir = (orderBy?.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
      const field = (orderBy?.field ?? 'CREATED_AT').toUpperCase();
      list.sort((a, b) => {
        if (field === 'UPDATED_AT') {
          if (a.updatedAt !== b.updatedAt) return (a.updatedAt < b.updatedAt ? -1 : 1) * dir;
        } else if (field === 'COMMENTS') {
          if (a.comments.length !== b.comments.length) return (a.comments.length - b.comments.length) * dir;
        }
        return (a.number - b.number) * dir;
      });

      const totalCount = list.length;
      let remaining = list;
      if (typeof args.after === 'string' && args.after) {
        const idx = remaining.findIndex((i) => makeCursor(i.number) === args.after);
        if (idx >= 0) remaining = remaining.slice(idx + 1);
      }
      const first = typeof args.first === 'number' ? args.first : remaining.length;
      const pageItems = remaining.slice(0, first);
      const hasNextPage = remaining.length > first;
      const startCursor = pageItems.length > 0 ? makeCursor(pageItems[0].number) : null;
      const endCursor = pageItems.length > 0 ? makeCursor(pageItems[pageItems.length - 1].number) : null;

      return {
        __typename: 'IssueConnection',
        totalCount,
        nodes: pageItems.map((i) => makeIssueResolver(repo, i)),
        edges: pageItems.map((i) => ({
          __typename: 'IssueEdge',
          cursor: makeCursor(i.number),
          node: makeIssueResolver(repo, i),
        })),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage,
          hasPreviousPage: false,
          startCursor,
          endCursor,
        },
      };
    },
    pullRequest: (args: Record<string, unknown>) => {
      const n = Number(args.number);
      const pr = repo.pulls.get(n);
      return pr ? makePullResolver(repo, pr) : null;
    },
    pullRequests: (args: Record<string, unknown>) => {
      const statesSet = normalizeStatesArg(args.states);
      let list = [...repo.pulls.values()];
      if (statesSet) {
        list = list.filter((p) => {
          const st = p.merged ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN';
          return statesSet.has(st);
        });
      }
      const orderBy = (args.orderBy && typeof args.orderBy === 'object' ? args.orderBy : null) as {
        field?: string;
        direction?: string;
      } | null;
      const dir = (orderBy?.direction ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
      list.sort((a, b) => (a.number - b.number) * dir);

      const totalCount = list.length;
      let remaining = list;
      if (typeof args.after === 'string' && args.after) {
        const idx = remaining.findIndex((p) => makeCursor(p.number) === args.after);
        if (idx >= 0) remaining = remaining.slice(idx + 1);
      }
      const first = typeof args.first === 'number' ? args.first : remaining.length;
      const pageItems = remaining.slice(0, first);
      const hasNextPage = remaining.length > first;
      const startCursor = pageItems.length > 0 ? makeCursor(pageItems[0].number) : null;
      const endCursor = pageItems.length > 0 ? makeCursor(pageItems[pageItems.length - 1].number) : null;

      return {
        __typename: 'PullRequestConnection',
        totalCount,
        nodes: pageItems.map((p) => makePullResolver(repo, p)),
        edges: pageItems.map((p) => ({
          __typename: 'PullRequestEdge',
          cursor: makeCursor(p.number),
          node: makePullResolver(repo, p),
        })),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage,
          hasPreviousPage: false,
          startCursor,
          endCursor,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Node ID lookup helpers for Query.node and Mutations
// ---------------------------------------------------------------------------

function decodeNodeIdString(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function findRepoById(raw: unknown): Repo | null {
  if (typeof raw === 'number') {
    for (const r of store.reposByName.values()) if (r.id === raw) return r;
    return null;
  }
  if (typeof raw !== 'string' || !raw) return null;
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    for (const r of store.reposByName.values()) if (r.id === id) return r;
  }
  const dec = decodeNodeIdString(raw);
  const m = /(?:^|:)Repository:?(\d+)$/.exec(dec);
  if (m) {
    const id = Number(m[1]);
    for (const r of store.reposByName.values()) if (r.id === id) return r;
  }
  return store.reposByName.get(raw) ?? null;
}

function findIssueById(raw: unknown): { repo: Repo; issue: Issue } | null {
  let targetId: number | null = null;
  if (typeof raw === 'number') targetId = raw;
  else if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) targetId = Number(raw);
    else {
      const dec = decodeNodeIdString(raw);
      const m = /Issue:?(\d+)$/.exec(dec);
      if (m) targetId = Number(m[1]);
    }
  }
  if (targetId === null) return null;
  for (const repo of store.reposByName.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === targetId) return { repo, issue };
    }
  }
  return null;
}

function findPullById(raw: unknown): { repo: Repo; pull: Pull } | null {
  let targetId: number | null = null;
  if (typeof raw === 'number') targetId = raw;
  else if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) targetId = Number(raw);
    else {
      const dec = decodeNodeIdString(raw);
      const m = /PullRequest:?(\d+)$/.exec(dec);
      if (m) targetId = Number(m[1]);
    }
  }
  if (targetId === null) return null;
  for (const repo of store.reposByName.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === targetId) return { repo, pull };
    }
  }
  return null;
}

function findSubjectById(raw: unknown): { repo: Repo; item: Issue | Pull } | null {
  const iss = findIssueById(raw);
  if (iss) return { repo: iss.repo, item: iss.issue };
  const pr = findPullById(raw);
  if (pr) return { repo: pr.repo, item: pr.pull };
  let targetId: number | null = null;
  if (typeof raw === 'string') {
    const dec = decodeNodeIdString(raw);
    const m = /(\d+)$/.exec(dec);
    if (m) targetId = Number(m[1]);
  }
  if (targetId !== null) {
    for (const repo of store.reposByName.values()) {
      for (const issue of repo.issues.values()) if (issue.id === targetId) return { repo, item: issue };
      for (const pull of repo.pulls.values()) if (pull.id === targetId) return { repo, item: pull };
    }
  }
  return null;
}

function resolveNodeById(rawId: unknown): ResolverObj | null {
  if (typeof rawId !== 'string' || !rawId) return null;
  const dec = decodeNodeIdString(rawId);
  const mRepo = /^04:Repository(\d+)$/.exec(dec);
  if (mRepo) {
    const id = Number(mRepo[1]);
    for (const r of store.reposByName.values()) if (r.id === id) return makeRepoResolver(r);
    return null;
  }
  const mIssue = /^05:Issue(\d+)$/.exec(dec);
  if (mIssue) {
    const found = findIssueById(Number(mIssue[1]));
    return found ? makeIssueResolver(found.repo, found.issue) : null;
  }
  const mPull = /^06:PullRequest(\d+)$/.exec(dec);
  if (mPull) {
    const found = findPullById(Number(mPull[1]));
    return found ? makePullResolver(found.repo, found.pull) : null;
  }
  const mUser = /^04:User(\d+)$/.exec(dec);
  if (mUser) {
    return makeUserResolver(viewer());
  }
  const mComment = /^0(?:7|12):IssueComment(\d+)$/.exec(dec);
  if (mComment) {
    const cid = Number(mComment[1]);
    for (const repo of store.reposByName.values()) {
      for (const iss of repo.issues.values()) {
        for (const c of iss.comments) if (c.id === cid) return makeCommentResolver(repo, iss, c);
      }
      for (const pr of repo.pulls.values()) {
        for (const c of pr.comments) if (c.id === cid) return makeCommentResolver(repo, pr, c);
      }
    }
    return null;
  }
  return null;
}

function cleanBranchRef(raw: string): string {
  let r = raw.trim();
  if (r.startsWith('refs/heads/')) r = r.slice('refs/heads/'.length);
  const idx = r.indexOf(':');
  if (idx >= 0) r = r.slice(idx + 1);
  return r;
}

// ---------------------------------------------------------------------------
// Root Query & Mutation Resolvers
// ---------------------------------------------------------------------------

function makeQueryResolver(): ResolverObj {
  return {
    __typename: 'Query',
    viewer: () => makeUserResolver(viewer()),
    user: (args: Record<string, unknown>) => {
      const login = typeof args.login === 'string' && args.login ? args.login : viewer();
      return makeUserResolver(login);
    },
    repository: (args: Record<string, unknown>) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (!owner || !name) return null;
      const repo = lookupRepo(owner, name);
      return repo ? makeRepoResolver(repo) : null;
    },
    node: (args: Record<string, unknown>) => resolveNodeById(args.id),
    rateLimit: () => ({
      __typename: 'RateLimit',
      limit: 5000,
      cost: 1,
      remaining: 5000,
      resetAt: new Date((BASE_EPOCH + 3600) * 1000).toISOString(),
    }),
    __type: (args: Record<string, unknown>) => {
      const name = typeof args.name === 'string' ? args.name : '';
      return INTROSPECTION_TYPES[name] ?? null;
    },
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
      mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
      subscriptionType: null,
      types: Object.values(INTROSPECTION_TYPES),
      directives: [],
    }),
  };
}

function extractInput(args: Record<string, unknown>): Record<string, unknown> {
  if (args.input && typeof args.input === 'object' && !Array.isArray(args.input)) {
    return args.input as Record<string, unknown>;
  }
  return args;
}

function makeMutationResolver(): ResolverObj {
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = extractInput(args);
      const repo = findRepoById(input.repositoryId);
      if (!repo) throw new Error('Repository not found');
      const title = typeof input.title === 'number' ? String(input.title) : typeof input.title === 'string' ? input.title : '';
      if (!title.trim()) throw new Error('Title is required');
      const now = tickIso();
      const issue: Issue = {
        id: counters.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : null,
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      return {
        __typename: 'CreateIssuePayload',
        clientMutationId: input.clientMutationId ?? null,
        issue: makeIssueResolver(repo, issue),
      };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = extractInput(args);
      const found = findIssueById(input.issueId ?? input.id);
      if (!found) throw new Error('Issue not found');
      const { repo, issue } = found;
      const now = tickIso();
      if (issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedAt = now;
      }
      issue.updatedAt = now;
      return {
        __typename: 'CloseIssuePayload',
        clientMutationId: input.clientMutationId ?? null,
        issue: makeIssueResolver(repo, issue),
      };
    },
    reopenIssue: (args: Record<string, unknown>) => {
      const input = extractInput(args);
      const found = findIssueById(input.issueId ?? input.id);
      if (!found) throw new Error('Issue not found');
      const { repo, issue } = found;
      const now = tickIso();
      issue.state = 'open';
      issue.closedAt = null;
      issue.updatedAt = now;
      return {
        __typename: 'ReopenIssuePayload',
        clientMutationId: input.clientMutationId ?? null,
        issue: makeIssueResolver(repo, issue),
      };
    },
    updateIssue: (args: Record<string, unknown>) => {
      const input = extractInput(args);
      const found = findIssueById(input.id ?? input.issueId);
      if (!found) throw new Error('Issue not found');
      const { repo, issue } = found;
      const now = tickIso();
      if (typeof input.title === 'string' && input.title.trim()) issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (typeof input.state === 'string') {
        const st = input.state.toUpperCase();
        if (st === 'CLOSED' && issue.state !== 'closed') {
          issue.state = 'closed';
          issue.closedAt = now;
        } else if (st === 'OPEN' && issue.state !== 'open') {
          issue.state = 'open';
          issue.closedAt = null;
        }
      }
      issue.updatedAt = now;
      return {
        __typename: 'UpdateIssuePayload',
        clientMutationId: input.clientMutationId ?? null,
        issue: makeIssueResolver(repo, issue),
      };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = extractInput(args);
      const repo = findRepoById(input.repositoryId);
      if (!repo) throw new Error('Repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (!title.trim()) throw new Error('Title is required');
      const headRaw = typeof input.headRefName === 'string' ? input.headRefName : typeof input.head === 'string' ? input.head : '';
      const baseRaw = typeof input.baseRefName === 'string' ? input.baseRefName : typeof input.base === 'string' ? input.base : '';
      if (!headRaw || !baseRaw) throw new Error('headRefName and baseRefName are required');
      const headRef = cleanBranchRef(headRaw);
      const baseRef = cleanBranchRef(baseRaw);
      const headSha = repo.branchTip.get(headRef);
      if (!headSha) throw new Error(`Head ref does not exist: ${headRef}`);
      const baseSha = repo.branchTip.get(baseRef);
      if (!baseSha) throw new Error(`Base ref does not exist: ${baseRef}`);
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) {
          throw new Error(`A pull request already exists for ${ownerOf(repo)}:${headRef}`);
        }
      }
      const now = tickIso();
      const pull: Pull = {
        id: counters.nextIssueId++,
        number: repo.nextIssueNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : null,
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
      return {
        __typename: 'CreatePullRequestPayload',
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: makePullResolver(repo, pull),
      };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = extractInput(args);
      const found = findPullById(input.pullRequestId ?? input.id);
      if (!found) throw new Error('Pull request not found');
      const { repo, pull } = found;
      if (pull.merged || pull.state !== 'open') {
        throw new Error('Pull Request is not mergeable');
      }
      const headTip = headTipOf(repo, pull);
      const expected = typeof input.expectedHeadOid === 'string' ? input.expectedHeadOid : typeof input.sha === 'string' ? input.sha : '';
      if (expected && expected.toLowerCase() !== headTip) {
        throw new Error('Head branch was modified. Review and try the merge again.');
      }
      const tw = threeWay(repo, pull);
      if (tw.conflicts.length > 0) {
        throw new Error('Pull Request is not mergeable');
      }
      const changed = diffFiles(repo, tw.ancestor, tw.headFiles, pull.headRef);
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const baseTip = repo.branchTip.get(pull.baseRef);
      const parents = baseTip ? [baseTip] : [];
      if (methodRaw === 'merge') parents.push(headTip);
      let message = typeof input.commitHeadline === 'string' && input.commitHeadline ? input.commitHeadline : pull.title;
      if (typeof input.commitBody === 'string' && input.commitBody) {
        message += `\n\n${input.commitBody}`;
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
      return {
        __typename: 'MergePullRequestPayload',
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: makePullResolver(repo, pull),
      };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = extractInput(args);
      const found = findSubjectById(input.subjectId ?? input.issueId ?? input.id);
      if (!found) throw new Error('Subject not found');
      const { repo, item } = found;
      const body = typeof input.body === 'string' ? input.body : '';
      if (!body) throw new Error('Comment body is required');
      const now = tickIso();
      const comment: Comment = { id: counters.nextIssueId++, body, createdAt: now, updatedAt: now };
      item.comments.push(comment);
      item.updatedAt = now;
      const commentNode = makeCommentResolver(repo, item, comment);
      return {
        __typename: 'AddCommentPayload',
        clientMutationId: input.clientMutationId ?? null,
        commentEdge: {
          __typename: 'IssueCommentEdge',
          cursor: makeCursor(item.comments.length),
          node: commentNode,
        },
        subject: item.isPull ? makePullResolver(repo, item) : makeIssueResolver(repo, item),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// GraphQL Executor
// ---------------------------------------------------------------------------

type GraphQLErrorItem = {
  message: string;
  locations?: { line: number; column: number }[];
  path?: (string | number)[];
};

function evalValue(
  node: ValueNode,
  variables: Record<string, unknown>,
  varDefaults: Map<string, ValueNode>,
): unknown {
  switch (node.kind) {
    case 'Variable': {
      if (node.name in variables && variables[node.name] !== undefined) {
        return variables[node.name];
      }
      const def = varDefaults.get(node.name);
      if (def) return evalValue(def, variables, varDefaults);
      return undefined;
    }
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
    case 'Enum':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => evalValue(v, variables, varDefaults));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) {
        out[k] = evalValue(v, variables, varDefaults);
      }
      return out;
    }
  }
}

function evalArgs(
  argNodes: Record<string, ValueNode>,
  variables: Record<string, unknown>,
  varDefaults: Map<string, ValueNode>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(argNodes)) {
    out[k] = evalValue(v, variables, varDefaults);
  }
  return out;
}

function shouldInclude(
  directives: DirectiveNode[],
  variables: Record<string, unknown>,
  varDefaults: Map<string, ValueNode>,
): boolean {
  for (const d of directives) {
    const args = evalArgs(d.args, variables, varDefaults);
    if (d.name === 'skip' && Boolean(args.if) === true) return false;
    if (d.name === 'include' && Boolean(args.if) === false) return false;
  }
  return true;
}

function matchesTypeCondition(runtimeType: string | undefined, condition: string): boolean {
  if (!runtimeType) return true;
  if (runtimeType === condition) return true;
  if (condition === 'Node') return true;
  if (runtimeType === 'User' && (condition === 'Actor' || condition === 'RepositoryOwner' || condition === 'Organization')) {
    return true;
  }
  if (runtimeType === 'Commit' && condition === 'GitObject') return true;
  if (runtimeType === 'IssueComment' && condition === 'Comment') return true;
  if (
    (runtimeType === 'Issue' || runtimeType === 'PullRequest') &&
    (condition === 'IssueOrPullRequest' ||
      condition === 'Closable' ||
      condition === 'Commentable' ||
      condition === 'Labelable' ||
      condition === 'UniformResourceLocatable')
  ) {
    return true;
  }
  return false;
}

function executeGraphQLPayload(payload: Record<string, unknown>): {
  data: Record<string, unknown> | null;
  errors?: GraphQLErrorItem[];
} {
  const query = typeof payload.query === 'string' ? payload.query : '';
  if (!query.trim()) {
    return { data: null, errors: [{ message: 'Must provide query string' }] };
  }
  const variables: Record<string, unknown> =
    payload.variables && typeof payload.variables === 'object' && !Array.isArray(payload.variables)
      ? (payload.variables as Record<string, unknown>)
      : {};
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : null;

  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    if (err instanceof GraphQLSyntaxError) {
      return {
        data: null,
        errors: [{ message: err.message, locations: [{ line: err.line, column: err.col }] }],
      };
    }
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }

  const op =
    (operationName ? doc.operations.find((o) => o.name === operationName) : doc.operations[0]) ?? doc.operations[0];

  const varDefaults = new Map<string, ValueNode>();
  for (const vd of op.variableDefinitions) {
    if (vd.defaultValue !== undefined) varDefaults.set(vd.name, vd.defaultValue);
  }

  const errors: GraphQLErrorItem[] = [];
  const rootObj = op.operation === 'mutation' ? makeMutationResolver() : makeQueryResolver();

  function collectFields(
    obj: ResolverObj,
    selectionSet: SelectionNode[],
    visitedFragments: Set<string>,
  ): FieldNode[] {
    const objType = typeof obj.__typename === 'string' ? obj.__typename : undefined;
    const fields: FieldNode[] = [];
    for (const sel of selectionSet) {
      if (!shouldInclude(sel.directives, variables, varDefaults)) continue;
      if (sel.kind === 'Field') {
        fields.push(sel);
      } else if (sel.kind === 'InlineFragment') {
        if (sel.typeCondition === null || matchesTypeCondition(objType, sel.typeCondition)) {
          fields.push(...collectFields(obj, sel.selectionSet, visitedFragments));
        }
      } else if (sel.kind === 'FragmentSpread') {
        if (visitedFragments.has(sel.name)) continue;
        const frag = doc.fragments.get(sel.name);
        if (frag && matchesTypeCondition(objType, frag.typeCondition)) {
          const nextVisited = new Set(visitedFragments);
          nextVisited.add(sel.name);
          fields.push(...collectFields(obj, frag.selectionSet, nextVisited));
        }
      }
    }
    return fields;
  }

  function resolveValue(val: unknown, field: FieldNode, path: (string | number)[]): unknown {
    if (val === null || val === undefined) return null;
    if (Array.isArray(val)) {
      return val.map((item, i) => resolveValue(item, field, [...path, i]));
    }
    if (typeof val === 'object') {
      if (field.selectionSet) {
        return resolveSelectionSet(val as ResolverObj, field.selectionSet, path);
      }
      return val;
    }
    return val;
  }

  function resolveSelectionSet(
    obj: ResolverObj,
    selectionSet: SelectionNode[],
    path: (string | number)[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const objType = typeof obj.__typename === 'string' ? obj.__typename : 'Object';
    const fields = collectFields(obj, selectionSet, new Set());

    for (const field of fields) {
      const outKey = field.alias ?? field.name;
      const fieldName = field.name;

      if (fieldName === '__typename') {
        out[outKey] = objType;
        continue;
      }

      if (!(fieldName in obj)) {
        out[outKey] = null;
        errors.push({
          message: `Field '${fieldName}' doesn't exist on type '${objType}'`,
          locations: [{ line: field.line, column: field.col }],
          path: [...path, outKey],
        });
        continue;
      }

      const prop = obj[fieldName];
      const args = evalArgs(field.args, variables, varDefaults);
      try {
        const rawVal = typeof prop === 'function' ? (prop as ResolverFn)(args) : prop;
        const resolved = resolveValue(rawVal, field, [...path, outKey]);
        if (
          outKey in out &&
          out[outKey] !== null &&
          typeof out[outKey] === 'object' &&
          !Array.isArray(out[outKey]) &&
          resolved !== null &&
          typeof resolved === 'object' &&
          !Array.isArray(resolved)
        ) {
          out[outKey] = { ...(out[outKey] as Record<string, unknown>), ...(resolved as Record<string, unknown>) };
        } else {
          out[outKey] = resolved;
        }
      } catch (err) {
        out[outKey] = null;
        errors.push({
          message: err instanceof Error ? err.message : String(err),
          locations: [{ line: field.line, column: field.col }],
          path: [...path, outKey],
        });
      }
    }

    return out;
  }

  const data = resolveSelectionSet(rootObj, op.selectionSet, []);
  if (errors.length > 0) {
    return { data, errors };
  }
  return { data };
}

// ---------------------------------------------------------------------------
// Request Body Scanner (Single JSON, JSON Array, or Concatenated JSON Objects)
// ---------------------------------------------------------------------------

type ParsedBody =
  | { kind: 'single'; payload: Record<string, unknown> }
  | { kind: 'array'; payloads: Record<string, unknown>[] }
  | { kind: 'concat'; payloads: Record<string, unknown>[] }
  | { kind: 'invalid' };

function parseGraphQLRequestBody(raw: string): ParsedBody {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'invalid' };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return { kind: 'invalid' };
      }
      return { kind: 'array', payloads: parsed as Record<string, unknown>[] };
    }
    if (parsed && typeof parsed === 'object') {
      return { kind: 'single', payload: parsed as Record<string, unknown> };
    }
    return { kind: 'invalid' };
  } catch {
    // Check if multiple JSON objects are concatenated back-to-back
  }

  const payloads: Record<string, unknown>[] = [];
  let i = 0;
  const n = trimmed.length;

  while (i < n) {
    while (i < n && (trimmed.charCodeAt(i) <= 0x20 || trimmed[i] === '&')) i++;
    if (i >= n) break;
    if (trimmed[i] !== '{') return { kind: 'invalid' };

    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;

    while (i < n) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      i++;
    }

    if (depth !== 0 || inString) return { kind: 'invalid' };
    const slice = trimmed.slice(start, i);
    try {
      const obj: unknown = JSON.parse(slice);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'invalid' };
      payloads.push(obj as Record<string, unknown>);
    } catch {
      return { kind: 'invalid' };
    }
  }

  if (payloads.length === 0) return { kind: 'invalid' };
  if (payloads.length === 1) return { kind: 'single', payload: payloads[0] };
  return { kind: 'concat', payloads };
}

// ---------------------------------------------------------------------------
// HTTP Entry Point
// ---------------------------------------------------------------------------

export async function handleGraphQL(ctx: HandlerCtx): Promise<boolean> {
  const method = (ctx.req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') return false;

  if (!isAuthorized(ctx.req)) {
    sendJson(ctx.res, 401, { message: 'Bad credentials' });
    return true;
  }

  const raw = ctx.body.toString('utf8');
  const parsed = parseGraphQLRequestBody(raw);

  if (parsed.kind === 'invalid') {
    sendJson(ctx.res, 400, {
      message: 'Problems parsing JSON',
      errors: [{ message: 'Problems parsing JSON' }],
    });
    return true;
  }

  if (parsed.kind === 'single') {
    const result = executeGraphQLPayload(parsed.payload);
    sendJson(ctx.res, 200, result);
    return true;
  }

  if (parsed.kind === 'array') {
    const results = parsed.payloads.map((p) => executeGraphQLPayload(p));
    sendJson(ctx.res, 200, results);
    return true;
  }

  // Concatenated JSON documents -> return concatenated JSON results separated by newline
  const results = parsed.payloads.map((p) => JSON.stringify(executeGraphQLPayload(p)));
  const text = `${results.join('\n')}\n`;
  ctx.res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'content-length': String(Buffer.byteLength(text)),
  });
  ctx.res.end(text);
  return true;
}
