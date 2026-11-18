/**
 * CI gate for the manifest text convention (#1401): every visible text in an
 * in-tree `packages/<pkg>/manifest.yaml` is a `{ en, de }` map.
 *
 * Out-of-tree (Hub) packages are not checked here — they load with a warning
 * (`manifestLoader`), never a rejection. Run: `npm run manifest:i18n:check`.
 * `--list` prints every gap instead of a per-package summary.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  auditManifestI18n,
  describeManifestI18nGaps,
} from '../src/plugins/manifestI18nAudit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(here, '../packages');
const listAll = process.argv.includes('--list');

const entries = await fs.readdir(packagesDir, { withFileTypes: true });
let total = 0;
for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const manifestPath = path.join(packagesDir, entry.name, 'manifest.yaml');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    continue;
  }
  const gaps = auditManifestI18n(parse(raw));
  if (gaps.length === 0) continue;
  total += gaps.length;
  console.log(
    listAll
      ? `${entry.name}/manifest.yaml:\n  ${gaps.map((g) => describeManifestI18nGaps([g])).join('\n  ')}`
      : `${entry.name}/manifest.yaml: ${gaps.length} text(s) not localized as {en, de}`,
  );
}

if (total > 0) {
  console.error(
    `\nmanifest-i18n: ${total} visible manifest text(s) are not {en, de} maps. ` +
      'Write them as `{ en: "…", de: "…" }` (see docs/middleware-agent-handoff.md, #1401).',
  );
  process.exit(1);
}
console.log('manifest-i18n: OK — every in-tree manifest text is an {en, de} map');
