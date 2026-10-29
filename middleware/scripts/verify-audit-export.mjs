#!/usr/bin/env node
/**
 * #761 — offline verifier for an omadia audit export (JSONL from
 * `GET /api/v1/operator/provenance/export`).
 *
 * ZERO dependencies beyond node:crypto/node:fs — deliberately: verification
 * that only works while trusting the exporting server proves nothing. Run
 * this against the export file plus the public key you received OUT-OF-BAND:
 *
 *   node verify-audit-export.mjs export.jsonl --pubkey omadia-audit.pub.pem \
 *     [--anchor audit-anchors.jsonl]
 *
 * Without --pubkey the key embedded in the export header is used — that
 * checks internal consistency only: whoever handed you the export could have
 * re-signed it with their own key. The result is then "not proven" (exit 3),
 * never "verified".
 *
 * --anchor (#1565) compares the external anchor file (`AUDIT_ANCHOR_PATH`,
 * fetched from the storage the DB admin cannot rewrite) with the export:
 * every anchored checkpoint must still be in the export with the same hash,
 * and no anchored seq may lie beyond the last exported entry. Without it an
 * admin who deletes the newest rows TOGETHER with their checkpoints leaves
 * no trace inside the export.
 *
 * Same rules as the server verify (`middleware/src/receipts/verify.ts`),
 * from the recorded head and settings the export header carries:
 *   - a reaped prefix is anchored by ANY signature-valid checkpoint that
 *     certifies a surviving entry (#1567);
 *   - with a key, at least one such checkpoint must exist once the oldest
 *     entry is older than two checkpoint intervals (#1565);
 *   - a checkpoint at or above the first entry with no entry is orphaned,
 *     and the recorded head must match the newest entry (#1566);
 *   - a reaped row provably younger than retention is premature_deletion;
 *   - without any key the result is UNSIGNED, never "verified", and an
 *     unanchored retention prefix is a note, not a failure (#1568).
 * Only the server's in-process witness has no offline counterpart.
 *
 * Exit codes: 0 = verified with the out-of-band key, 1 = broken/finding,
 *             2 = usage/parse error, 3 = consistent but NOT proven (no key,
 *             or only the key embedded in the export).
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
const optionValue = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const pubkeyPath = optionValue('--pubkey');
const anchorPath = optionValue('--anchor');
const file = args.find((a, i) => !a.startsWith('--') && !['--pubkey', '--anchor'].includes(args[i - 1]));
if (!file) {
  console.error('usage: node verify-audit-export.mjs <export.jsonl> [--pubkey key.pem] [--anchor anchors.jsonl]');
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

const firstSeq = entries[0]?.seq;
const lastEntry = entries[entries.length - 1];
const lastSeq = lastEntry?.seq;
const key = publicKeyPem ? createPublicKey(publicKeyPem) : undefined;
const exportedAtMs = Date.parse(header.exportedAt);
const DAY_MS = 24 * 60 * 60 * 1000;

function signatureValid(seq, headHashHex, signedAtIso, signatureBase64) {
  try {
    return edVerify(
      null,
      checkpointSigningInput(streamId, seq, headHashHex, signedAtIso),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

// Recorded head (exported in the header): a head beyond the newest entry is
// tail truncation; a head at the newest entry must carry its hash.
if (typeof header.recordedHeadSeq === 'number' && lastSeq !== undefined) {
  if (header.recordedHeadSeq > lastSeq) {
    findings.push(`head_beyond_entries: the recorded head is seq ${header.recordedHeadSeq} but the export ends at ${lastSeq}`);
  } else if (
    header.recordedHeadSeq === lastSeq &&
    typeof header.recordedHeadHashHex === 'string' &&
    header.recordedHeadHashHex !== lastEntry.entryHashHex
  ) {
    findings.push(`head_hash_mismatch: the recorded head hash differs from entry seq ${lastSeq}`);
  }
}

// Checkpoints: the row comparison runs with or without a key; signatures
// only with one. A checkpoint at or above the first entry with no entry is
// orphaned — inside the range or beyond the last entry (tail truncation).
const entryBySeq = new Map(entries.map((e) => [e.seq, e]));
let cpVerified = 0;
let certifying = 0;
const validSignedAt = [];
for (const c of checkpoints) {
  if (key && !signatureValid(c.seq, c.headHashHex, c.signedAtIso, c.signatureBase64)) {
    findings.push(`bad_signature on checkpoint seq ${c.seq}`);
    continue;
  }
  if (key) validSignedAt.push([c.seq, Date.parse(c.signedAtIso)]);
  const row = entryBySeq.get(c.seq);
  if (row && row.entryHashHex !== c.headHashHex) {
    findings.push(`checkpoint seq ${c.seq} certifies a DIFFERENT hash than the exported row`);
    continue;
  }
  if (!row && firstSeq !== undefined && c.seq >= firstSeq) {
    findings.push(`orphaned_checkpoint seq ${c.seq}: certified row missing from the export`);
    continue;
  }
  if (!key) continue;
  cpVerified += 1;
  if (row) certifying += 1;
}
if (!key && checkpoints.length > 0) {
  console.warn('no public key available — checkpoint signatures NOT checked');
}
const notes = [];
if (key && entries.length > 0 && certifying === 0) {
  // Grace while every entry is younger than two checkpoint intervals at
  // export time: the signer has not had a pass since the first receipt.
  const graceMs = 2 * (header.checkpointIntervalMinutes ?? 60) * 60_000;
  const oldest = Math.min(...entries.map((e) => Date.parse(e.createdAt)));
  if (Number.isFinite(oldest) && exportedAtMs - oldest < graceMs) {
    notes.push('no checkpoint yet — every entry is younger than two checkpoint intervals');
  } else {
    findings.push(
      'no_signed_checkpoint: a signing key is in use but no signature-valid checkpoint certifies any exported entry (checkpoints deleted?)',
    );
  }
}

// Retention prefix (#1567): any certifying checkpoint covers the first
// survivor's prev_hash transitively — no exact boundary alignment needed.
if (firstSeq !== undefined && firstSeq > 1) {
  const reapedUpTo = firstSeq - 1;
  if (certifying > 0) {
    notes.push(`rows 1..${reapedUpTo} removed by retention — anchored by a signed checkpoint`);
  } else if (key) {
    findings.push(
      `unanchored_prefix: rows 1..${reapedUpTo} are absent (retention?) and no signed checkpoint certifies a surviving entry`,
    );
  } else {
    notes.push(`rows 1..${reapedUpTo} removed by retention — NOT anchored: no signing key`);
  }
  // Premature deletion: the highest valid checkpoint BELOW the youngest
  // reaped row proves that row was created after its signing time.
  const below = validSignedAt.filter(([seq]) => seq < reapedUpTo).sort((a, b) => b[0] - a[0])[0];
  if (below && typeof header.retentionDays === 'number' && exportedAtMs - below[1] < header.retentionDays * DAY_MS) {
    findings.push(
      `premature_deletion: a checkpoint proves row ${reapedUpTo} was created after ${new Date(below[1]).toISOString()}, inside the ${header.retentionDays}-day retention window`,
    );
  }
}

// External anchor (#1565). Same record shape the server accepts; lines that
// are not records (a torn final write) are noted, not findings — the DB
// admin cannot write this file. Fetch the anchor BEFORE taking the export:
// a record signed after the export's `exportedAt` then means the header was
// backdated to hide truncated checkpoints (security review N1) — a finding.
let anchorSummary;
if (anchorPath) {
  let anchorLines;
  try {
    anchorLines = readFileSync(anchorPath, 'utf-8').split('\n');
  } catch (err) {
    console.error(`cannot read anchor file ${anchorPath}: ${err.message}`);
    process.exit(2);
  }
  const cpBySeq = new Map(checkpoints.map((c) => [c.seq, c]));
  let records = 0;
  let matched = 0;
  let malformed = 0;
  let newer = 0;
  for (const line of anchorLines) {
    if (line.trim().length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (
      !rec ||
      typeof rec !== 'object' ||
      typeof rec.streamId !== 'string' ||
      !Number.isSafeInteger(rec.seq) ||
      rec.seq < 1 ||
      typeof rec.headHashHex !== 'string' ||
      !/^[0-9a-f]{64}$/.test(rec.headHashHex) ||
      typeof rec.signedAtIso !== 'string' ||
      typeof rec.signatureBase64 !== 'string' ||
      typeof rec.publicKeyFingerprint !== 'string'
    ) {
      malformed += 1;
      continue;
    }
    if (rec.streamId !== streamId) continue;
    records += 1;
    if (key && !signatureValid(rec.seq, rec.headHashHex, rec.signedAtIso, rec.signatureBase64)) {
      findings.push(`anchor_bad_signature: anchor record seq ${rec.seq} does not verify with the key`);
      continue;
    }
    if (!(Date.parse(rec.signedAtIso) <= exportedAtMs)) {
      newer += 1;
      findings.push(
        `anchor_newer_than_export: anchor record seq ${rec.seq} was signed after the export's exportedAt — fetch the anchor file BEFORE taking the export, then re-run`,
      );
      continue;
    }
    if (lastSeq === undefined || rec.seq > lastSeq) {
      findings.push(
        `anchor_beyond_export: the anchor certifies seq ${rec.seq} but the export ends at ${lastSeq ?? 0} — newest entries were deleted`,
      );
    }
    const cp = cpBySeq.get(rec.seq);
    if (!cp) {
      findings.push(`anchor_checkpoint_missing: anchored checkpoint seq ${rec.seq} is not in the export`);
    } else if (cp.headHashHex !== rec.headHashHex) {
      findings.push(`anchor_mismatch: checkpoint seq ${rec.seq} certifies a different hash than the anchor`);
    } else {
      matched += 1;
    }
  }
  anchorSummary = `${records} records, ${matched} match the export`;
  if (newer > 0) anchorSummary += `, ${newer} signed after the export`;
  if (malformed > 0) anchorSummary += `, ${malformed} malformed line(s) ignored`;
}

console.log(`stream:      ${streamId}`);
console.log(`entries:     ${entries.length} (${checked} verified in chain order)`);
console.log(
  `checkpoints: ${checkpoints.length} (${key ? `${cpVerified} verified, key: ${keySource}` : 'signatures NOT checked — no key'})`,
);
if (anchorSummary) console.log(`anchor:      ${anchorSummary}`);
for (const n of notes) console.log(`note:        ${n}`);
if (findings.length > 0) {
  console.error('\n✗ VERIFICATION FAILED:');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
if (entries.length === 0) {
  console.error('\n✗ export contains zero chain entries — nothing was verified (refusing to report green)');
  process.exit(1);
}
if (!key) {
  console.log(
    '\n⚠ UNSIGNED — entries are internally consistent, but no signing key: nothing vouches for the chain (not verified)',
  );
  process.exit(3);
}
if (certifying === 0) {
  console.log('\n⚠ NOT YET SIGNED — entries are consistent, but no checkpoint covers them yet (not verified)');
  process.exit(3);
}
if (!pubkeyPath) {
  console.log(
    '\n⚠ NOT PROVEN — consistent against the key embedded in the export only; pass the key you received out-of-band with --pubkey',
  );
  process.exit(3);
}
if (!anchorPath) {
  console.log(
    'note:        no --anchor given — deleting the newest entries together with their checkpoints is only detectable against the external anchor file',
  );
}
console.log('\n✓ chain verified: every entry matches its recorded hash, links are intact, checkpoints agree');
process.exit(0);
