#!/usr/bin/env node
// Generates Keep-a-Changelog-style entries from Conventional Commit subjects.
// Zero dependencies (git + node only) so it runs in CI without a package install.
//
// Modes:
//   notes <fromRef> <toRef> <outPath>
//     Categorize commits in the range and write the markdown body (no version
//     header) to outPath — used as `gh release create --notes-file`.
//
//   cut <fromRef> <toRef> <version> <date> <notesOutPath>
//     Promote docs/CHANGELOG.md's [Unreleased] section into a dated
//     `## [version] - date` section: any hand-written Unreleased prose is kept
//     verbatim above a mechanically generated Added/Changed/Fixed breakdown of
//     every commit in the range, so the entry is never empty even if nobody
//     wrote release notes by hand. Also writes the same categorized body to
//     notesOutPath for reuse as the GitHub Release notes. Idempotent — no-ops
//     if the version section already exists.
//
//   backfill
//     One-off/rerunnable: for every existing git tag not yet present as a
//     `## [x.y.z]` section, insert a generated section in the right place
//     (newest-first, above the oldest already-documented version). Leaves
//     [Unreleased] untouched.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CHANGELOG_PATH = 'docs/CHANGELOG.md';
const REPO_URL = 'https://github.com/byte5ai/omadia';

const EXCLUDE_TYPES = new Set(['chore', 'docs', 'test', 'ci', 'style', 'build']);
const SECTION_BY_TYPE = { feat: 'Added', fix: 'Fixed', perf: 'Changed', refactor: 'Changed', revert: 'Changed' };
const SECTION_ORDER = ['Added', 'Changed', 'Fixed'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function categorize(range) {
  const RS = '\x1e';
  const FS = '\x1f';
  const raw = git(['log', '--no-merges', `--pretty=format:%H${FS}%s${FS}%b${RS}`, range]);
  const sections = { Added: [], Changed: [], Fixed: [] };
  const breaking = [];

  for (const rec of raw.split(RS)) {
    const trimmed = rec.replace(/^\n/, '');
    if (!trimmed.trim()) continue;
    const parts = trimmed.split(FS);
    const subject = parts[1] ?? '';
    const body = parts.slice(2).join(FS) ?? '';
    const m = subject.match(/^([a-z]+)(\(([^)]+)\))?(!)?:\s*(.+)$/);
    if (!m) continue;
    const [, type, , scope, bang, desc] = m;
    const entry = scope ? `**${scope}**: ${desc}` : desc;
    const isBreaking = Boolean(bang) || /BREAKING CHANGE/.test(body);
    if (isBreaking) breaking.push(entry);
    if (EXCLUDE_TYPES.has(type)) continue;
    const section = SECTION_BY_TYPE[type] || 'Changed';
    sections[section].push(entry);
  }

  let out = '';
  if (breaking.length) {
    out += `### ⚠ BREAKING CHANGES\n\n${breaking.map((e) => `- ${e}`).join('\n')}\n\n`;
  }
  for (const section of SECTION_ORDER) {
    if (!sections[section].length) continue;
    out += `### ${section}\n\n${sections[section].map((e) => `- ${e}`).join('\n')}\n\n`;
  }
  if (!out.trim()) {
    out = '_No user-facing changes._\n';
  }
  return out.trim() + '\n';
}

function readChangelog() {
  return readFileSync(CHANGELOG_PATH, 'utf8');
}

function extractUnreleasedBody(content) {
  const m = content.match(/## \[Unreleased\]\n([\s\S]*?)\n(?=---\n\n## \[)/);
  return m ? m[1].trim() : '';
}

function setUnreleasedLink(content, latestTag) {
  return content.replace(
    /\[Unreleased\]: [^\n]+/,
    `[Unreleased]: ${REPO_URL}/compare/${latestTag}...HEAD`,
  );
}

function cut(fromRef, toRef, version, date, notesOutPath) {
  let content = readChangelog();
  if (content.includes(`## [${version}]`)) {
    console.log(`Skip: [${version}] already present in ${CHANGELOG_PATH}`);
    if (notesOutPath) writeFileSync(notesOutPath, categorize(`${fromRef}..${toRef}`));
    return;
  }

  const generated = categorize(`${fromRef}..${toRef}`);
  if (notesOutPath) writeFileSync(notesOutPath, generated);

  const unreleasedPrelude = extractUnreleasedBody(content);
  const versionBody = unreleasedPrelude ? `${unreleasedPrelude}\n\n${generated}` : generated;

  content = content.replace(
    /## \[Unreleased\]\n[\s\S]*?\n(?=---\n\n## \[)/,
    `## [Unreleased]\n\n---\n\n## [${version}] - ${date}\n\n${versionBody.trim()}\n\n`,
  );
  content = setUnreleasedLink(content, toRef);
  content = content.replace(
    /(\[Unreleased\]: [^\n]+\n)/,
    `$1[${version}]: ${REPO_URL}/compare/${fromRef}...${toRef}\n`,
  );

  writeFileSync(CHANGELOG_PATH, content);
  console.log(`Cut [${version}] into ${CHANGELOG_PATH}`);
}

function backfill() {
  const tags = git(['tag', '-l', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=v:refname'])
    .trim()
    .split('\n')
    .filter(Boolean);

  const content0 = readChangelog();
  const missing = [];
  for (let i = 1; i < tags.length; i++) {
    const tag = tags[i];
    const version = tag.replace(/^v/, '');
    if (!content0.includes(`## [${version}]`)) {
      missing.push({ prev: tags[i - 1], tag, version });
    }
  }
  if (!missing.length) {
    console.log('Nothing to backfill — every tag already has a changelog section.');
    return;
  }

  missing.reverse(); // newest first, matches file order (Unreleased -> newest -> oldest)

  let block = '';
  for (const { prev, tag, version } of missing) {
    const date = git(['log', '-1', '--format=%ad', '--date=short', tag]).trim();
    const body = categorize(`${prev}..${tag}`);
    block += `## [${version}] - ${date}\n\n${body}\n---\n\n`;
  }

  // Anchor immediately above the newest already-documented version section
  // (found by scanning `tags` for one whose section already exists — not by
  // arithmetic, since documented tags aren't guaranteed to be a contiguous
  // prefix of the array).
  let content = content0;
  const documented = tags.filter((t) => content0.includes(`## [${t.replace(/^v/, '')}]`));
  const anchorTag = documented.at(-1);
  if (!anchorTag) {
    throw new Error('Could not locate an already-documented version to anchor the backfill against.');
  }
  const marker = `## [${anchorTag.replace(/^v/, '')}]`;
  content = content.replace(marker, `${block}${marker}`);

  const footerLines = missing.map(({ prev, tag, version }) => `[${version}]: ${REPO_URL}/compare/${prev}...${tag}`).join('\n');
  content = content.replace(/(\[Unreleased\]: [^\n]+\n)/, `$1${footerLines}\n`);
  content = setUnreleasedLink(content, tags[tags.length - 1]);

  writeFileSync(CHANGELOG_PATH, content);
  console.log(`Backfilled ${missing.length} version section(s): ${missing.map((m) => m.version).join(', ')}`);
}

const [, , mode, ...args] = process.argv;

switch (mode) {
  case 'notes': {
    const [fromRef, toRef, outPath] = args;
    writeFileSync(outPath, categorize(`${fromRef}..${toRef}`));
    break;
  }
  case 'cut': {
    const [fromRef, toRef, version, date, notesOutPath] = args;
    cut(fromRef, toRef, version, date, notesOutPath);
    break;
  }
  case 'backfill':
    backfill();
    break;
  default:
    console.error('Usage: generate-changelog.mjs <notes|cut|backfill> ...');
    process.exit(1);
}
