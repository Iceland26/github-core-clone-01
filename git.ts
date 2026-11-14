// Git smart HTTP surface (/{owner}/{repo}.git/...).
// Implements protocol v2 (git-upload-pack: ls-refs, fetch) and
// protocol v0 (git-receive-pack and git-upload-pack fallback) using only Node.js stdlib.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import zlib from 'node:zlib';
import {
  commitFilesMap,
  deleteBranch,
  getCommit,
  gitObjectSha,
  isTreeMode,
  lookupRepo,
  parseCommit,
  parseTree,
  peel,
  readBody,
  sendJson,
  setBranchTip,
  storeObject,
  tickIso,
} from './store.ts';
import type { GitObject, HandlerCtx, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// Constants & pkt-line helpers
// ---------------------------------------------------------------------------

const ZERO_SHA = '0'.repeat(40);
const FLUSH_PKT = Buffer.from('0000', 'ascii');
const DELIM_PKT = Buffer.from('0001', 'ascii');
const END_PKT = Buffer.from('0002', 'ascii');
const SIDEBAND_CHUNK_SIZE = 65515; // 65520 max pkt-line - 4 hex len - 1 band byte

const RECEIVE_CAPS =
  'report-status report-status-v2 side-band-64k delete-refs quiet ofs-delta object-format=sha1 agent=forge/1.0';

const UPLOAD_V0_CAPS =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow object-format=sha1 agent=forge/1.0';

export function pktLine(payload: string | Buffer): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = buf.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), buf]);
}

export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += SIDEBAND_CHUNK_SIZE) {
    const chunk = data.subarray(i, Math.min(i + SIDEBAND_CHUNK_SIZE, data.length));
    const len = chunk.length + 5; // 4 hex + 1 band + chunk
    const header = Buffer.allocUnsafe(5);
    header.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    header[4] = band;
    out.push(Buffer.concat([header, chunk]));
  }
  return out;
}

type PktItem =
  | { kind: 'flush'; nextOffset: number }
  | { kind: 'delim'; nextOffset: number }
  | { kind: 'end'; nextOffset: number }
  | { kind: 'data'; data: Buffer; nextOffset: number };

function readOnePkt(buf: Buffer, offset: number): PktItem | null {
  if (offset + 4 > buf.length) return null;
  const hex = buf.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
    throw new Error(`Invalid pkt-line length prefix: ${JSON.stringify(hex)}`);
  }
  const len = Number.parseInt(hex, 16);
  if (len === 0) return { kind: 'flush', nextOffset: offset + 4 };
  if (len === 1) return { kind: 'delim', nextOffset: offset + 4 };
  if (len === 2) return { kind: 'end', nextOffset: offset + 4 };
  if (len < 4 || offset + len > buf.length) {
    throw new Error(`Invalid or truncated pkt-line (len=${len}, remaining=${buf.length - offset})`);
  }
  return {
    kind: 'data',
    data: buf.subarray(offset + 4, offset + len),
    nextOffset: offset + len,
  };
}

function pktLineToString(data: Buffer): string {
  let s = data.toString('utf8');
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (s.endsWith('\r')) s = s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// Caching for pack entries & tree closures
// ---------------------------------------------------------------------------

// Cache deflated pack entry (varint header + deflated content) per immutable GitObject.
const packEntryCache = new WeakMap<GitObject, Buffer>();

// Cache reachable object shas (tree itself + subtrees + blobs) per tree sha per repo.
const treeClosureCache = new WeakMap<Repo, Map<string, string[]>>();

function getTreeClosure(repo: Repo, rootTreeSha: string): string[] {
  let repoMap = treeClosureCache.get(repo);
  if (!repoMap) {
    repoMap = new Map();
    treeClosureCache.set(repo, repoMap);
  }
  const cached = repoMap.get(rootTreeSha);
  if (cached) return cached;

  const rootObj = repo.objects.get(rootTreeSha);
  if (!rootObj || rootObj.type !== 'tree') return [];

  const seen = new Set<string>();
  const result: string[] = [];
  const stack: string[] = [rootTreeSha];

  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const subCached = repoMap.get(sha);
    if (subCached) {
      for (const s of subCached) {
        if (!seen.has(s)) {
          seen.add(s);
          result.push(s);
        }
      }
      continue;
    }
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tree') continue;
    seen.add(sha);
    result.push(sha);
    const entries = parseTree(obj.buf);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.mode === '160000') continue;
      if (isTreeMode(e.mode)) {
        if (!seen.has(e.sha)) stack.push(e.sha);
      } else if (!seen.has(e.sha) && repo.objects.has(e.sha)) {
        seen.add(e.sha);
        result.push(e.sha);
      }
    }
  }

  repoMap.set(rootTreeSha, result);
  return result;
}

const OBJ_TYPE_CODES: Record<string, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_OBJ_TYPE: Record<number, string> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function encodePackEntry(obj: GitObject): Buffer {
  const cached = packEntryCache.get(obj);
  if (cached) return cached;

  const typeCode = OBJ_TYPE_CODES[obj.type];
  if (!typeCode) throw new Error(`Unsupported object type for pack: ${obj.type}`);

  let size = obj.buf.length;
  const headerBytes: number[] = [];
  let first = ((typeCode & 0x07) << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  headerBytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) b |= 0x80;
    headerBytes.push(b);
  }

  const deflated = zlib.deflateSync(obj.buf);
  const entry = Buffer.concat([Buffer.from(headerBytes), deflated]);
  packEntryCache.set(obj, entry);
  return entry;
}

function buildPackfile(repo: Repo, shas: Iterable<string>): Buffer {
  const entries: Buffer[] = [];
  let count = 0;
  for (const sha of shas) {
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    entries.push(encodePackEntry(obj));
    count++;
  }

  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);

  const hash = createHash('sha1');
  hash.update(header);
  for (const e of entries) hash.update(e);
  const trailer = hash.digest();

  return Buffer.concat([header, ...entries, trailer]);
}

// ---------------------------------------------------------------------------
// Object graph walk for upload-pack (fetch)
// ---------------------------------------------------------------------------

type FetchCollection = {
  objectsToSend: Set<string>;
  shallowBoundaries: string[];
};

function collectExcludedObjects(repo: Repo, haves: string[], clientShallows: Set<string>): Set<string> {
  const excluded = new Set<string>();
  if (haves.length === 0) return excluded;

  const commitStack: string[] = [];
  for (const rawHave of haves) {
    const have = rawHave.toLowerCase();
    const obj = repo.objects.get(have);
    if (!obj) continue;
    excluded.add(have);
    const peeled = peel(repo, have);
    excluded.add(peeled);
    if (repo.objects.get(peeled)?.type === 'commit') {
      commitStack.push(peeled);
    }
  }

  while (commitStack.length > 0) {
    const sha = commitStack.pop() as string;
    const c = getCommit(repo, sha);
    if (!c) continue;
    if (c.tree) {
      for (const tSha of getTreeClosure(repo, c.tree)) {
        excluded.add(tSha);
      }
    }
    if (clientShallows.has(sha)) continue;
    for (const p of c.parents) {
      if (!excluded.has(p) && repo.objects.has(p)) {
        excluded.add(p);
        commitStack.push(p);
      }
    }
  }

  return excluded;
}

function collectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  deepen: number | null,
  deepenSince: number | null,
  clientShallows: Set<string>,
): FetchCollection {
  const isShallow = deepen !== null || deepenSince !== null || clientShallows.size > 0;
  const excluded = isShallow && deepen !== null ? new Set<string>() : collectExcludedObjects(repo, haves, clientShallows);

  // Even when shallow, direct haves can be excluded
  if (isShallow && deepen === null && haves.length > 0) {
    for (const h of haves) {
      const lower = h.toLowerCase();
      if (repo.objects.has(lower)) excluded.add(lower);
    }
  }

  const objectsToSend = new Set<string>();
  const commitsToSend = new Set<string>();
  const extraTrees: string[] = [];
  const shallowBoundariesSet = new Set<string>();

  const commitQueue: { sha: string; depth: number }[] = [];
  const minDepth = new Map<string, number>();

  for (const rawWant of wants) {
    let cur = rawWant.toLowerCase();
    // Walk through any annotated tag chain
    for (let i = 0; i < 16; i++) {
      const obj = repo.objects.get(cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        if (!excluded.has(cur)) objectsToSend.add(cur);
        const m = /^object ([0-9a-f]{40})/m.exec(obj.buf.toString('utf8'));
        if (!m) break;
        cur = m[1];
      } else {
        break;
      }
    }

    const target = repo.objects.get(cur);
    if (!target) continue;
    if (target.type === 'commit') {
      if (!minDepth.has(cur)) {
        minDepth.set(cur, 1);
        commitQueue.push({ sha: cur, depth: 1 });
      }
    } else if (target.type === 'tree') {
      extraTrees.push(cur);
    } else if (target.type === 'blob') {
      if (!excluded.has(cur)) objectsToSend.add(cur);
    }
  }

  if (deepen !== null) {
    const clientHas = new Set<string>();
    const haveStack: string[] = [];
    for (const rawHave of haves) {
      const have = peel(repo, rawHave.toLowerCase());
      if (!clientHas.has(have) && getCommit(repo, have)) {
        clientHas.add(have);
        haveStack.push(have);
      }
    }
    while (haveStack.length > 0) {
      const sha = haveStack.pop() as string;
      if (clientShallows.has(sha)) continue;
      const c = getCommit(repo, sha);
      if (!c) continue;
      for (const p of c.parents) {
        if (!clientHas.has(p) && getCommit(repo, p)) {
          clientHas.add(p);
          haveStack.push(p);
        }
      }
    }

    let qIdx = 0;
    while (qIdx < commitQueue.length) {
      const { sha, depth } = commitQueue[qIdx++];
      const c = getCommit(repo, sha);
      if (!c) continue;
      if (depth < deepen) {
        for (const p of c.parents) {
          if (!getCommit(repo, p)) continue;
          const prevDepth = minDepth.get(p);
          if (prevDepth === undefined || depth + 1 < prevDepth) {
            minDepth.set(p, depth + 1);
            commitQueue.push({ sha: p, depth: depth + 1 });
          }
        }
      }
    }

    for (const [sha] of minDepth) {
      if (!clientHas.has(sha) && getCommit(repo, sha)) {
        commitsToSend.add(sha);
        objectsToSend.add(sha);
      }
    }

    for (const sha of commitsToSend) {
      if (minDepth.get(sha) === deepen) {
        const c = getCommit(repo, sha);
        if (c && c.parents.some((p) => !commitsToSend.has(p) && !clientHas.has(p))) {
          shallowBoundariesSet.add(sha);
        }
      }
    }
  } else {
    let qIdx = 0;
    while (qIdx < commitQueue.length) {
      const { sha, depth } = commitQueue[qIdx++];
      if (excluded.has(sha)) continue;
      const c = getCommit(repo, sha);
      if (!c) continue;

      if (deepenSince !== null && c.committer.epoch < deepenSince) {
        continue;
      }

      commitsToSend.add(sha);
      objectsToSend.add(sha);

      if (clientShallows.has(sha)) {
        shallowBoundariesSet.add(sha);
        continue;
      }

      for (const p of c.parents) {
        if (excluded.has(p)) continue;
        const pCommit = getCommit(repo, p);
        if (!pCommit) continue;
        if (deepenSince !== null && pCommit.committer.epoch < deepenSince) {
          shallowBoundariesSet.add(sha);
          continue;
        }
        const prevDepth = minDepth.get(p);
        if (prevDepth === undefined || depth + 1 < prevDepth) {
          minDepth.set(p, depth + 1);
          commitQueue.push({ sha: p, depth: depth + 1 });
        }
      }
    }
  }

  // Add trees and blobs for all included commits
  for (const commitSha of commitsToSend) {
    const c = getCommit(repo, commitSha);
    if (!c || !c.tree) continue;
    for (const objSha of getTreeClosure(repo, c.tree)) {
      if (!excluded.has(objSha)) objectsToSend.add(objSha);
    }
  }

  // Add any directly wanted trees
  for (const treeSha of extraTrees) {
    for (const objSha of getTreeClosure(repo, treeSha)) {
      if (!excluded.has(objSha)) objectsToSend.add(objSha);
    }
  }

  return {
    objectsToSend,
    shallowBoundaries: [...shallowBoundariesSet],
  };
}

// ---------------------------------------------------------------------------
// Packfile parser (for git-receive-pack)
// ---------------------------------------------------------------------------

type UnpackedEntry = {
  type: string;
  buf: Buffer;
  sha: string;
  offset: number;
};

type PendingDelta =
  | { kind: 'ofs'; offset: number; baseOffset: number; deltaBuf: Buffer }
  | { kind: 'ref'; offset: number; baseSha: string; deltaBuf: Buffer };

function applyGitDelta(baseBuf: Buffer, deltaBuf: Buffer): Buffer {
  let pos = 0;

  let srcSize = 0;
  let shift = 0;
  for (;;) {
    if (pos >= deltaBuf.length) throw new Error('Truncated delta source size');
    const b = deltaBuf[pos++];
    srcSize += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  if (srcSize !== baseBuf.length) {
    throw new Error(`Delta base size mismatch: expected ${srcSize}, got ${baseBuf.length}`);
  }

  let tgtSize = 0;
  shift = 0;
  for (;;) {
    if (pos >= deltaBuf.length) throw new Error('Truncated delta target size');
    const b = deltaBuf[pos++];
    tgtSize += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }

  const out = Buffer.allocUnsafe(tgtSize);
  let outPos = 0;

  while (pos < deltaBuf.length) {
    const cmd = deltaBuf[pos++];
    if (cmd & 0x80) {
      let cpOffset = 0;
      if (cmd & 0x01) cpOffset |= deltaBuf[pos++];
      if (cmd & 0x02) cpOffset |= deltaBuf[pos++] << 8;
      if (cmd & 0x04) cpOffset |= deltaBuf[pos++] << 16;
      if (cmd & 0x08) cpOffset |= (deltaBuf[pos++] << 24) >>> 0;
      cpOffset >>>= 0;

      let cpSize = 0;
      if (cmd & 0x10) cpSize |= deltaBuf[pos++];
      if (cmd & 0x20) cpSize |= deltaBuf[pos++] << 8;
      if (cmd & 0x40) cpSize |= deltaBuf[pos++] << 16;
      if (cpSize === 0) cpSize = 0x10000;

      if (pos > deltaBuf.length || cpOffset + cpSize > baseBuf.length || outPos + cpSize > tgtSize) {
        throw new Error('Delta copy out of bounds');
      }
      baseBuf.copy(out, outPos, cpOffset, cpOffset + cpSize);
      outPos += cpSize;
    } else if (cmd > 0) {
      if (pos + cmd > deltaBuf.length || outPos + cmd > tgtSize) {
        throw new Error('Delta insert out of bounds');
      }
      deltaBuf.copy(out, outPos, pos, pos + cmd);
      pos += cmd;
      outPos += cmd;
    } else {
      throw new Error('Invalid delta opcode 0');
    }
  }

  if (outPos !== tgtSize) {
    throw new Error(`Delta target size mismatch: expected ${tgtSize}, wrote ${outPos}`);
  }
  return out;
}

function inflateFromPack(packBuf: Buffer, startPos: number, endLimit: number): { buffer: Buffer; bytesConsumed: number } {
  const slice = packBuf.subarray(startPos, endLimit);
  try {
    const res = zlib.inflateSync(slice, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (res && Buffer.isBuffer(res.buffer) && res.engine && typeof res.engine.bytesWritten === 'number') {
      return { buffer: res.buffer, bytesConsumed: res.engine.bytesWritten };
    }
  } catch {
    // Fallback below if {info:true} fails
  }

  // Fallback: binary/incremental search if needed
  for (let len = 2; len <= slice.length; len++) {
    try {
      const buf = zlib.inflateSync(slice.subarray(0, len));
      return { buffer: buf, bytesConsumed: len };
    } catch {
      // keep trying larger slice
    }
  }
  throw new Error('Failed to inflate pack entry');
}

function unpackPackfile(repo: Repo, packBuf: Buffer): void {
  if (packBuf.length < 32) {
    throw new Error('Packfile too short');
  }
  if (packBuf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('Invalid packfile signature');
  }
  const version = packBuf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported packfile version: ${version}`);
  }
  const count = packBuf.readUInt32BE(8);
  const dataEnd = packBuf.length - 20;

  let pos = 12;
  const byOffset = new Map<number, UnpackedEntry>();
  const bySha = new Map<string, UnpackedEntry>();
  let pending: PendingDelta[] = [];

  for (let i = 0; i < count; i++) {
    if (pos >= dataEnd) throw new Error('Unexpected end of packfile');
    const entryOffset = pos;

    let b = packBuf[pos++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (pos >= dataEnd) throw new Error('Truncated pack entry header');
      b = packBuf[pos++];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }

    if (typeCode >= 1 && typeCode <= 4) {
      const { buffer, bytesConsumed } = inflateFromPack(packBuf, pos, dataEnd);
      if (buffer.length !== size) {
        throw new Error(`Pack entry size mismatch: expected ${size}, got ${buffer.length}`);
      }
      pos += bytesConsumed;
      const type = CODE_TO_OBJ_TYPE[typeCode];
      const sha = gitObjectSha(type, buffer);
      const entry: UnpackedEntry = { type, buf: buffer, sha, offset: entryOffset };
      byOffset.set(entryOffset, entry);
      bySha.set(sha, entry);
    } else if (typeCode === 6) {
      // OFS_DELTA
      if (pos >= dataEnd) throw new Error('Truncated ofs-delta offset');
      let c = packBuf[pos++];
      let negOffset = c & 0x7f;
      while (c & 0x80) {
        if (pos >= dataEnd) throw new Error('Truncated ofs-delta offset');
        negOffset += 1;
        c = packBuf[pos++];
        negOffset = negOffset * 128 + (c & 0x7f);
      }
      const baseOffset = entryOffset - negOffset;
      if (baseOffset < 12 || baseOffset >= entryOffset) {
        throw new Error(`Invalid ofs-delta base offset: ${baseOffset}`);
      }
      const { buffer: deltaBuf, bytesConsumed } = inflateFromPack(packBuf, pos, dataEnd);
      if (deltaBuf.length !== size) {
        throw new Error(`ofs-delta size mismatch: expected ${size}, got ${deltaBuf.length}`);
      }
      pos += bytesConsumed;

      const base = byOffset.get(baseOffset);
      if (base) {
        const reconstructed = applyGitDelta(base.buf, deltaBuf);
        const sha = gitObjectSha(base.type, reconstructed);
        const entry: UnpackedEntry = { type: base.type, buf: reconstructed, sha, offset: entryOffset };
        byOffset.set(entryOffset, entry);
        bySha.set(sha, entry);
      } else {
        pending.push({ kind: 'ofs', offset: entryOffset, baseOffset, deltaBuf });
      }
    } else if (typeCode === 7) {
      // REF_DELTA
      if (pos + 20 > dataEnd) throw new Error('Truncated ref-delta base sha');
      const baseSha = packBuf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { buffer: deltaBuf, bytesConsumed } = inflateFromPack(packBuf, pos, dataEnd);
      if (deltaBuf.length !== size) {
        throw new Error(`ref-delta size mismatch: expected ${size}, got ${deltaBuf.length}`);
      }
      pos += bytesConsumed;

      const base = bySha.get(baseSha) ?? repo.objects.get(baseSha);
      if (base) {
        const reconstructed = applyGitDelta(base.buf, deltaBuf);
        const sha = gitObjectSha(base.type, reconstructed);
        const entry: UnpackedEntry = { type: base.type, buf: reconstructed, sha, offset: entryOffset };
        byOffset.set(entryOffset, entry);
        bySha.set(sha, entry);
      } else {
        pending.push({ kind: 'ref', offset: entryOffset, baseSha, deltaBuf });
      }
    } else {
      throw new Error(`Unsupported pack entry type: ${typeCode}`);
    }
  }

  if (pos !== dataEnd) {
    throw new Error(`Packfile trailing bytes mismatch: pos=${pos}, expected=${dataEnd}`);
  }

  // Verify 20-byte SHA-1 checksum at end of packfile
  const expectedChecksum = createHash('sha1').update(packBuf.subarray(0, dataEnd)).digest();
  const actualChecksum = packBuf.subarray(dataEnd, packBuf.length);
  if (!expectedChecksum.equals(actualChecksum)) {
    throw new Error('Packfile checksum mismatch');
  }

  // Resolve any out-of-order pending deltas
  while (pending.length > 0) {
    const nextPending: PendingDelta[] = [];
    let progressed = false;
    for (const item of pending) {
      if (item.kind === 'ofs') {
        const base = byOffset.get(item.baseOffset);
        if (base) {
          const reconstructed = applyGitDelta(base.buf, item.deltaBuf);
          const sha = gitObjectSha(base.type, reconstructed);
          const entry: UnpackedEntry = { type: base.type, buf: reconstructed, sha, offset: item.offset };
          byOffset.set(item.offset, entry);
          bySha.set(sha, entry);
          progressed = true;
        } else {
          nextPending.push(item);
        }
      } else {
        const base = bySha.get(item.baseSha) ?? repo.objects.get(item.baseSha);
        if (base) {
          const reconstructed = applyGitDelta(base.buf, item.deltaBuf);
          const sha = gitObjectSha(base.type, reconstructed);
          const entry: UnpackedEntry = { type: base.type, buf: reconstructed, sha, offset: item.offset };
          byOffset.set(item.offset, entry);
          bySha.set(sha, entry);
          progressed = true;
        } else {
          nextPending.push(item);
        }
      }
    }
    if (!progressed) {
      throw new Error('Unresolved delta base object in packfile');
    }
    pending = nextPending;
  }

  // Commit all unpacked objects into the repository store
  for (const entry of bySha.values()) {
    storeObject(repo, entry.type, entry.buf);
  }
  lastFetchCache.delete(repo);
}

// ---------------------------------------------------------------------------
// Fast-forward check helper
// ---------------------------------------------------------------------------

function isCommitAncestor(repo: Repo, ancestorSha: string, descendantSha: string): boolean {
  if (ancestorSha === descendantSha) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendantSha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestorSha) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.buf);
    for (const p of c.parents) {
      if (p === ancestorSha) return true;
      if (!seen.has(p)) stack.push(p);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route handlers: info/refs, git-upload-pack, git-receive-pack
// ---------------------------------------------------------------------------

function sendBytes(res: ServerResponse, status: number, contentType: string, buf: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'content-length': String(buf.length),
  });
  res.end(buf);
}

function handleInfoRefs(repo: Repo, res: ServerResponse, url: URL): void {
  const service = url.searchParams.get('service');
  if (service === 'git-upload-pack') {
    const body = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      FLUSH_PKT,
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unbundle\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('server-option\n'),
      pktLine('object-format=sha1\n'),
      FLUSH_PKT,
    ]);
    sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return;
  }

  if (service === 'git-receive-pack') {
    const packets: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH_PKT];
    if (repo.refs.size === 0) {
      packets.push(pktLine(`${ZERO_SHA} capabilities^{}\0${RECEIVE_CAPS}\n`));
    } else {
      const sortedRefs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const defaultRef = `refs/heads/${repo.defaultBranch}`;
      const defaultSha = repo.refs.get(defaultRef);
      if (defaultSha !== undefined) {
        packets.push(pktLine(`${defaultSha} ${defaultRef}\0${RECEIVE_CAPS}\n`));
        for (const [refname, sha] of sortedRefs) {
          if (refname === defaultRef) continue;
          packets.push(pktLine(`${sha} ${refname}\n`));
        }
      } else {
        const [firstRef, firstSha] = sortedRefs[0];
        packets.push(pktLine(`${firstSha} ${firstRef}\0${RECEIVE_CAPS}\n`));
        for (let i = 1; i < sortedRefs.length; i++) {
          const [refname, sha] = sortedRefs[i];
          packets.push(pktLine(`${sha} ${refname}\n`));
        }
      }
    }
    packets.push(FLUSH_PKT);
    sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(packets));
    return;
  }

  sendJson(res, 403, { message: 'Unsupported service' });
}

function handleUploadPackLsRefs(repo: Repo, preLines: string[], args: string[], res: ServerResponse): void {
  let wantPeel = false;
  let wantSymrefs = false;
  const refPrefixes: string[] = [];

  for (const arg of args) {
    if (arg === 'peel') wantPeel = true;
    else if (arg === 'symrefs') wantSymrefs = true;
    else if (arg.startsWith('ref-prefix ')) refPrefixes.push(arg.slice('ref-prefix '.length));
  }

  const matchesPrefix = (refname: string): boolean => {
    if (refPrefixes.length === 0) return true;
    return refPrefixes.some((p) => refname.startsWith(p));
  };

  const packets: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.branchTip.get(repo.defaultBranch) ?? repo.refs.get(defaultRef);

  if (defaultTip && matchesPrefix('HEAD')) {
    if (wantSymrefs) {
      packets.push(pktLine(`${defaultTip} HEAD symref-target:${defaultRef}\n`));
    } else {
      packets.push(pktLine(`${defaultTip} HEAD\n`));
    }
  }

  const sortedRefs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [refname, sha] of sortedRefs) {
    if (!matchesPrefix(refname)) continue;
    if (wantPeel && repo.objects.get(sha)?.type === 'tag') {
      const peeledSha = peel(repo, sha);
      packets.push(pktLine(`${sha} ${refname} peeled:${peeledSha}\n`));
    } else {
      packets.push(pktLine(`${sha} ${refname}\n`));
    }
  }

  packets.push(FLUSH_PKT);
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(packets));
}

type CachedFetchResult = {
  key: string;
  shallowBoundaries: string[];
  rawPack: Buffer;
  sidebandPackWithFlush: Buffer;
};

const lastFetchCache = new WeakMap<Repo, CachedFetchResult>();

function handleUploadPackFetchV2(repo: Repo, preLines: string[], argLines: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallows = new Set<string>();
  let hasDone = false;
  let waitForDone = false;
  let deepen: number | null = null;
  let deepenSince: number | null = null;
  let useSideband = false;

  const allLines = [...preLines, ...argLines];
  for (const line of allLines) {
    if (line.startsWith('want ')) {
      const sha = line.slice(5).trim().split(/\s+/)[0];
      if (/^[0-9a-fA-F]{40}$/.test(sha)) wants.push(sha.toLowerCase());
    } else if (line.startsWith('have ')) {
      const sha = line.slice(5).trim().split(/\s+/)[0];
      if (/^[0-9a-fA-F]{40}$/.test(sha)) haves.push(sha.toLowerCase());
    } else if (line === 'done') {
      hasDone = true;
    } else if (line === 'wait-for-done') {
      waitForDone = true;
    } else if (
      line === 'side-band-64k' ||
      line === 'side-band' ||
      line === 'sideband-all' ||
      line.startsWith('agent=git/')
    ) {
      useSideband = true;
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    } else if (line.startsWith('deepen-since ')) {
      const ts = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(ts)) deepenSince = ts;
    } else if (line.startsWith('shallow ')) {
      const sha = line.slice(8).trim();
      if (/^[0-9a-fA-F]{40}$/.test(sha)) clientShallows.add(sha.toLowerCase());
    }
  }

  const packets: Buffer[] = [];

  if (haves.length > 0 && !hasDone) {
    packets.push(pktLine('acknowledgments\n'));
    const commonHaves = haves.filter((h) => repo.objects.has(h));
    if (commonHaves.length === 0) {
      packets.push(pktLine('NAK\n'));
    } else {
      for (const h of commonHaves) {
        packets.push(pktLine(`ACK ${h}\n`));
      }
    }
    if (waitForDone) {
      packets.push(FLUSH_PKT);
      sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(packets));
      return;
    }
    packets.push(pktLine('ready\n'));
    packets.push(DELIM_PKT);
  }

  const cacheKey = `${repo.objects.size}:${deepen ?? ''}:${deepenSince ?? ''}:${wants.join(',')}:${haves.join(',')}:${[...clientShallows].join(',')}`;
  let cached = lastFetchCache.get(repo);
  if (!cached || cached.key !== cacheKey) {
    const { objectsToSend, shallowBoundaries } = collectFetchObjects(
      repo,
      wants,
      haves,
      deepen,
      deepenSince,
      clientShallows,
    );
    const rawPack = buildPackfile(repo, objectsToSend);
    const sidebandPackWithFlush = Buffer.concat([...sidebandPackets(1, rawPack), FLUSH_PKT]);
    cached = {
      key: cacheKey,
      shallowBoundaries,
      rawPack,
      sidebandPackWithFlush,
    };
    lastFetchCache.set(repo, cached);
  }

  if (deepen !== null || deepenSince !== null || clientShallows.size > 0) {
    packets.push(pktLine('shallow-info\n'));
    for (const bSha of cached.shallowBoundaries) {
      packets.push(pktLine(`shallow ${bSha}\n`));
    }
    packets.push(DELIM_PKT);
  }

  packets.push(pktLine('packfile\n'));
  packets.push(cached.sidebandPackWithFlush);

  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(packets));
}

function handleUploadPackV0(repo: Repo, allLines: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallows = new Set<string>();
  const caps = new Set<string>();
  let hasDone = false;
  let deepen: number | null = null;

  for (let i = 0; i < allLines.length; i++) {
    let line = allLines[i];
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const c of line.slice(nul + 1).trim().split(/\s+/)) if (c) caps.add(c);
        line = line.slice(0, nul);
      } else if (line.startsWith('want ')) {
        const parts = line.slice(5).trim().split(/\s+/);
        if (parts.length > 1) {
          for (const c of parts.slice(1)) caps.add(c);
          line = `want ${parts[0]}`;
        }
      }
    }
    if (line.startsWith('want ')) {
      const sha = line.slice(5).trim().split(/\s+/)[0];
      if (/^[0-9a-fA-F]{40}$/.test(sha)) wants.push(sha.toLowerCase());
    } else if (line.startsWith('have ')) {
      const sha = line.slice(5).trim().split(/\s+/)[0];
      if (/^[0-9a-fA-F]{40}$/.test(sha)) haves.push(sha.toLowerCase());
    } else if (line === 'done') {
      hasDone = true;
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    } else if (line.startsWith('shallow ')) {
      const sha = line.slice(8).trim();
      if (/^[0-9a-fA-F]{40}$/.test(sha)) clientShallows.add(sha.toLowerCase());
    }
  }

  const packets: Buffer[] = [];
  const { objectsToSend, shallowBoundaries } = collectFetchObjects(repo, wants, haves, deepen, null, clientShallows);

  if (deepen !== null) {
    for (const bSha of shallowBoundaries) {
      packets.push(pktLine(`shallow ${bSha}\n`));
    }
    packets.push(FLUSH_PKT);
  }

  if (haves.length > 0 && !hasDone) {
    const common = haves.filter((h) => repo.objects.has(h));
    if (common.length === 0) {
      packets.push(pktLine('NAK\n'));
    } else {
      for (const h of common) {
        packets.push(pktLine(`ACK ${h} continue\n`));
      }
    }
    sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(packets));
    return;
  }

  const common = haves.filter((h) => repo.objects.has(h));
  if (common.length > 0) {
    packets.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  } else {
    packets.push(pktLine('NAK\n'));
  }

  const packBuf = buildPackfile(repo, objectsToSend);
  if (caps.has('side-band-64k') || caps.has('side-band')) {
    packets.push(...sidebandPackets(1, packBuf));
    packets.push(FLUSH_PKT);
  } else {
    packets.push(packBuf);
  }

  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(packets));
}

function handleUploadPack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const preLines: string[] = [];
  const argLines: string[] = [];
  const allLines: string[] = [];
  let seenDelim = false;
  let offset = 0;

  while (offset < body.length) {
    const item = readOnePkt(body, offset);
    if (!item) break;
    offset = item.nextOffset;
    if (item.kind === 'flush' || item.kind === 'end') {
      // In v0, wants and haves are separated by a flush packet; keep reading if more pkt-lines follow
      if (preLines.some((l) => l.startsWith('command='))) {
        break;
      }
      continue;
    }
    if (item.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    const line = pktLineToString(item.data);
    allLines.push(line);
    if (!seenDelim) preLines.push(line);
    else argLines.push(line);
  }

  const cmdLine = preLines.find((l) => l.startsWith('command='));
  if (cmdLine) {
    const cmd = cmdLine.slice('command='.length).trim();
    if (cmd === 'ls-refs') {
      handleUploadPackLsRefs(repo, preLines, argLines, res);
      return;
    }
    if (cmd === 'fetch') {
      handleUploadPackFetchV2(repo, preLines, argLines, res);
      return;
    }
    sendJson(res, 400, { message: `Unsupported git protocol v2 command: ${cmd}` });
    return;
  }

  // Protocol v0 fallback
  handleUploadPackV0(repo, allLines, res);
}

type ReceiveCommand = {
  oldSha: string;
  newSha: string;
  refname: string;
};

function sendReceivePackReport(
  res: ServerResponse,
  useSideband: boolean,
  unpackStatus: string,
  refStatuses: { refname: string; ok: boolean; reason?: string }[],
): void {
  const reportPkts: Buffer[] = [pktLine(`${unpackStatus}\n`)];
  for (const st of refStatuses) {
    if (st.ok) {
      reportPkts.push(pktLine(`ok ${st.refname}\n`));
    } else {
      reportPkts.push(pktLine(`ng ${st.refname} ${st.reason ?? 'failed'}\n`));
    }
  }
  reportPkts.push(FLUSH_PKT);
  const reportBuf = Buffer.concat(reportPkts);

  if (useSideband) {
    const wrapped = Buffer.concat([...sidebandPackets(1, reportBuf), FLUSH_PKT]);
    sendBytes(res, 200, 'application/x-git-receive-pack-result', wrapped);
  } else {
    sendBytes(res, 200, 'application/x-git-receive-pack-result', reportBuf);
  }
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const commands: ReceiveCommand[] = [];
  const caps = new Set<string>();
  let offset = 0;
  let seenFlush = false;
  let isFirstLine = true;

  try {
    while (offset < body.length) {
      const item = readOnePkt(body, offset);
      if (!item) break;
      offset = item.nextOffset;
      if (item.kind === 'flush') {
        seenFlush = true;
        break;
      }
      if (item.kind === 'delim' || item.kind === 'end') continue;

      let line = pktLineToString(item.data);
      if (isFirstLine) {
        isFirstLine = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const capStr = line.slice(nul + 1).trim();
          for (const c of capStr.split(/\s+/)) {
            if (c) caps.add(c);
          }
          line = line.slice(0, nul);
        }
      }

      const m = /^([0-9a-fA-F]{40}) ([0-9a-fA-F]{40}) (.+)$/.exec(line.trim());
      if (!m) {
        throw new Error(`Invalid receive-pack command line: ${line}`);
      }
      commands.push({
        oldSha: m[1].toLowerCase(),
        newSha: m[2].toLowerCase(),
        refname: m[3].trim(),
      });
    }
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'Malformed pkt-line stream' });
    return;
  }

  if (!seenFlush || commands.length === 0) {
    sendJson(res, 400, { message: 'Missing receive-pack commands or flush packet' });
    return;
  }

  const useSideband = caps.has('side-band-64k') || caps.has('side-band');
  const packSlice = body.subarray(offset);
  const hasNonDelete = commands.some((c) => c.newSha !== ZERO_SHA);

  if (packSlice.length > 0 || hasNonDelete) {
    try {
      if (packSlice.length > 0) {
        unpackPackfile(repo, packSlice);
      }
    } catch (err) {
      const msg = (err instanceof Error ? err.message : 'corrupt pack').replace(/[\r\n]+/g, ' ');
      const failedRefs = commands.map((c) => ({
        refname: c.refname,
        ok: false,
        reason: 'unpacker error',
      }));
      sendReceivePackReport(res, useSideband, `unpack ${msg}`, failedRefs);
      return;
    }
  }

  const refStatuses: { refname: string; ok: boolean; reason?: string }[] = [];

  for (const cmd of commands) {
    const { oldSha, newSha, refname } = cmd;

    // Delete command
    if (newSha === ZERO_SHA) {
      const currentSha = repo.refs.get(refname);
      if (oldSha !== ZERO_SHA && currentSha !== undefined && currentSha !== oldSha) {
        refStatuses.push({ refname, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (refname.startsWith('refs/heads/')) {
        const branch = refname.slice('refs/heads/'.length);
        deleteBranch(repo, branch);
      } else {
        repo.refs.delete(refname);
      }
      repo.updatedAt = tickIso();
      refStatuses.push({ refname, ok: true });
      continue;
    }

    // Create / Update command
    const targetObj = repo.objects.get(newSha);
    if (!targetObj) {
      refStatuses.push({ refname, ok: false, reason: 'missing object' });
      continue;
    }

    const isTagRef = refname.startsWith('refs/tags/');
    if (!isTagRef && targetObj.type === 'commit') {
      const parsed = parseCommit(targetObj.buf);
      if (!parsed.tree || !repo.objects.has(parsed.tree)) {
        refStatuses.push({ refname, ok: false, reason: 'missing object' });
        continue;
      }

      const currentSha = repo.refs.get(refname);
      if (oldSha !== ZERO_SHA) {
        if (currentSha !== undefined && currentSha !== oldSha) {
          refStatuses.push({ refname, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (!isCommitAncestor(repo, oldSha, newSha)) {
          refStatuses.push({ refname, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      } else if (currentSha !== undefined && !isCommitAncestor(repo, currentSha, newSha)) {
        refStatuses.push({ refname, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }

    if (refname.startsWith('refs/heads/')) {
      const branch = refname.slice('refs/heads/'.length);
      const peeled = peel(repo, newSha);
      if (repo.objects.get(peeled)?.type !== 'commit') {
        refStatuses.push({ refname, ok: false, reason: 'not a commit' });
        continue;
      }
      setBranchTip(repo, branch, peeled);
    } else {
      repo.refs.set(refname, newSha);
    }

    repo.updatedAt = tickIso();
    refStatuses.push({ refname, ok: true });
  }

  sendReceivePackReport(res, useSideband, 'unpack ok', refStatuses);
}

// ---------------------------------------------------------------------------
// Auth & Main Entry Point
// ---------------------------------------------------------------------------

function checkGitAuth(req: IncomingMessage): boolean {
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

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isHandlerCtx(v: HandlerCtx | IncomingMessage): v is HandlerCtx {
  return typeof v === 'object' && v !== null && 'req' in v && 'res' in v && 'body' in v;
}

function dispatchGit(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): boolean {
  try {
    if (!checkGitAuth(req)) {
      sendJson(res, 401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="forge"' });
      return true;
    }

    const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!m) {
      return false;
    }

    const owner = safeDecode(m[1]);
    const repoName = safeDecode(m[2]);
    const endpoint = m[3];

    const repo = lookupRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    const method = (req.method ?? 'GET').toUpperCase();

    if (endpoint === 'info/refs') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      handleInfoRefs(repo, res, url);
      return true;
    }

    if (endpoint === 'git-upload-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      handleUploadPack(repo, body, res);
      return true;
    }

    if (endpoint === 'git-receive-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return true;
      }
      handleReceivePack(repo, body, res);
      return true;
    }

    return false;
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad Request' });
    } else {
      res.end();
    }
    return true;
  }
}

export function handleGit(
  ctxOrReq: HandlerCtx | IncomingMessage,
  maybeRes?: ServerResponse,
  maybeUrl?: URL,
): boolean | Promise<boolean> {
  if (isHandlerCtx(ctxOrReq)) {
    return dispatchGit(ctxOrReq.req, ctxOrReq.res, ctxOrReq.url, ctxOrReq.body);
  }
  const req = ctxOrReq;
  const res = maybeRes as ServerResponse;
  const url = maybeUrl ?? new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return dispatchGit(req, res, url, Buffer.alloc(0));
  }
  return readBody(req).then((body) => dispatchGit(req, res, url, body));
}
