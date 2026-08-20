#!/usr/bin/env node
/**
 * #761 — offline verifier for an omadia audit export (JSONL from
 * `GET /api/v1/operator/provenance/export`).
 *
 * ZERO dependencies beyond node:crypto/node:fs — deliberately: verification
 * that only works while trusting the exporting server proves nothing. Run
 * this against the export file plus the public key you received OUT-OF-BAND:
 *
 *   node verify-audit-export.mjs export.jsonl --pubkey omadia-audit.pub.pem
 *
 * Without --pubkey the key embedded in the export header is used — that
 * checks internal consistency only, and the tool says so loudly.
 *
 * Exit codes: 0 = verified, 1 = broken/finding, 2 = usage/parse error.
 *
 * The canonicalization and hash layout below intentionally DUPLICATE
 * `middleware/src/receipts/chain.ts` / `checkpoints.ts` — an independent
 * implementation is the point. Any change there is a `hash_version` bump
 * and a matching change here.
 */

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function genesisHashHex(streamId) {
  return createHash('sha256').update(`genesis:${streamId}`, 'utf-8').digest('hex');
}

function entryHashHex(streamId, seq, prevHashHex, payload) {
  return createHash('sha256')
    .update(`${streamId}\n${String(seq)}\n${prevHashHex}\n${canonicalJson(payload)}`, 'utf-8')
    .digest('hex');
}

function checkpointSigningInput(streamId, seq, headHashHex, signedAtIso) {
  return Buffer.from(
    `omadia-audit-checkpoint-v1\n${streamId}\n${String(seq)}\n${headHashHex}\n${signedAtIso}`,
    'utf-8',
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const pubkeyIdx = args.indexOf('--pubkey');
const pubkeyPath = pubkeyIdx >= 0 ? args[pubkeyIdx + 1] : undefined;
if (!file) {
  console.error('usage: node verify-audit-export.mjs <export.jsonl> [--pubkey key.pem]');
  process.exit(2);
}

let lines;
try {
  lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  process.exit(2);
}

let header;
let trailer;
const entries = [];
const checkpoints = [];
for (const [i, line] of lines.entries()) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    console.error(`line ${i + 1}: not valid JSON`);
    process.exit(2);
  }
  if (obj.kind === 'header') header = obj;
  else if (obj.kind === 'entry') entries.push(obj);
  else if (obj.kind === 'checkpoint') checkpoints.push(obj);
  else if (obj.kind === 'trailer') trailer = obj;
}
if (!header || header.format !== 'omadia-audit-export-v1') {
  console.error('missing or unknown export header (expected format omadia-audit-export-v1)');
  process.exit(2);
}
// A file cut at a line boundary looks internally consistent — the trailer's
// absence (or a count mismatch) is what makes truncation detectable.
if (!trailer) {
  console.error('✗ export has no trailer record — the file is truncated or incomplete');
  process.exit(1);
}
if (trailer.entries !== entries.length || trailer.checkpoints !== checkpoints.length) {
  console.error(
    `✗ trailer counts disagree with the file: trailer says ${trailer.entries} entries / ${trailer.checkpoints} checkpoints, file has ${entries.length} / ${checkpoints.length}`,
  );
  process.exit(1);
}
for (const e of entries) {
  if (e.hashVersion !== 1) {
    console.error(`✗ entry seq ${e.seq} uses hash_version ${e.hashVersion} — this verifier only understands version 1`);
    process.exit(1);
  }
}
if (typeof header.preChainRows === 'number' && header.preChainRows > 0) {
  console.warn(
    `note: ${header.preChainRows} pre-chain rows exist on the server but are not part of the chain and are not in this export`,
  );
}

let publicKeyPem;
let keySource;
if (pubkeyPath) {
  publicKeyPem = readFileSync(pubkeyPath, 'utf-8');
  keySource = `out-of-band (${pubkeyPath})`;
} else if (header.publicKeyPem) {
  publicKeyPem = header.publicKeyPem;
  keySource = 'EXPORT HEADER — internal consistency only, pin the key out-of-band for a real proof';
}

const streamId = header.streamId;
const findings = [];

// Chain walk.
entries.sort((a, b) => a.seq - b.seq);
let prev = entries.length > 0 && entries[0].seq === 1 ? genesisHashHex(streamId) : entries[0]?.prevHashHex;
let expected = entries[0]?.seq;
let checked = 0;
for (const e of entries) {
  if (e.seq !== expected) {
    findings.push(`seq_gap: expected ${expected}, found ${e.seq}`);
    break;
  }
  if (e.prevHashHex !== prev) {
    findings.push(`link_mismatch at seq ${e.seq}`);
    break;
  }
  const recomputed = entryHashHex(streamId, e.seq, e.prevHashHex, e.payload);
  if (recomputed !== e.entryHashHex) {
    findings.push(`hash_mismatch at seq ${e.seq} — the payload does not match its recorded hash`);
    break;
  }
  prev = e.entryHashHex;
  expected = e.seq + 1;
  checked += 1;
}
if (entries.length > 0 && entries[0].seq > 1) {
  const anchor = checkpoints.find((c) => c.seq === entries[0].seq - 1);
  if (!anchor || anchor.headHashHex !== entries[0].prevHashHex) {
    findings.push(
      `unanchored_prefix: rows 1..${entries[0].seq - 1} are absent (retention?) and no signed checkpoint vouches for the first surviving row's prev_hash`,
    );
  }
}

// Checkpoints.
const entryBySeq = new Map(entries.map((e) => [e.seq, e]));
let cpVerified = 0;
if (publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  for (const c of checkpoints) {
    const ok = edVerify(
      null,
      checkpointSigningInput(streamId, c.seq, c.headHashHex, c.signedAtIso),
      key,
      Buffer.from(c.signatureBase64, 'base64'),
    );
    if (!ok) {
      findings.push(`bad_signature on checkpoint seq ${c.seq}`);
      continue;
    }
    const row = entryBySeq.get(c.seq);
    if (row && row.entryHashHex !== c.headHashHex) {
      findings.push(`checkpoint seq ${c.seq} certifies a DIFFERENT hash than the exported row`);
      continue;
    }
    if (!row && entries.length > 0 && c.seq >= entries[0].seq) {
      findings.push(`orphaned_checkpoint seq ${c.seq}: certified row missing from the export`);
      continue;
    }
    cpVerified += 1;
  }
} else {
  console.warn('no public key available — checkpoint signatures NOT checked');
}

console.log(`stream:      ${streamId}`);
console.log(`entries:     ${entries.length} (${checked} verified in chain order)`);
console.log(`checkpoints: ${checkpoints.length} (${cpVerified} verified${publicKeyPem ? `, key: ${keySource}` : ''})`);
if (findings.length > 0) {
  console.error('\n✗ VERIFICATION FAILED:');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
if (entries.length === 0) {
  console.error('\n✗ export contains zero chain entries — nothing was verified (refusing to report green)');
  process.exit(1);
}
console.log('\n✓ chain verified: every entry matches its recorded hash, links are intact, checkpoints agree');
process.exit(0);
