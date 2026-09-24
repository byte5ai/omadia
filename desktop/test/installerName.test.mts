/**
 * The Windows installer's file name (#559).
 *
 * `nsis.artifactName` is load-bearing twice over: Azure Trusted Signing gets
 * the path unquoted (a space truncates it), and GitHub stores a spaced upload
 * as `omadia.Setup.X.exe` while latest.yml points at `omadia-Setup-X.exe`, so
 * Windows auto-update 404s. The public onboarding skill downloads the
 * installer by matching that name, so a rename that forgets it silently hands
 * new users a stale build and, once 20 newer releases exist, nothing at all.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const desktopDir = path.join(import.meta.dirname, '..');
const builderYml = fs.readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8');
const onboarding = fs.readFileSync(
  path.join(desktopDir, '..', 'docs', 'onboarding', 'SKILL.md'),
  'utf8',
);

/** The NSIS installer name electron-builder produces for `version`. */
function installerName(version: string): string {
  const productName = /^productName:\s*(\S+)\s*$/m.exec(builderYml)?.[1];
  const nsisBlock = /^nsis:\n((?:[ \t]+.*\n|[ \t]*\n)*)/m.exec(builderYml)?.[1];
  const template = /^[ \t]+artifactName:\s*(.+?)\s*$/m.exec(nsisBlock ?? '')?.[1];
  assert.ok(productName, 'electron-builder.yml has no productName');
  assert.ok(template, 'electron-builder.yml has no nsis.artifactName');
  return template
    .replace(/^(['"])(.*)\1$/, '$2')
    .replaceAll('${productName}', productName)
    .replaceAll('${version}', version)
    .replaceAll('${ext}', 'exe');
}

describe('Windows installer name (#559)', () => {
  it('contains no whitespace', () => {
    const name = installerName('0.1.0');
    assert.doesNotMatch(name, /\s/, `installer name ${JSON.stringify(name)} contains whitespace`);
  });

  it('is found by the onboarding skill, as are older releases', () => {
    const pattern = /\$_\.name -match '([^']+)'/.exec(onboarding)?.[1];
    assert.ok(pattern, 'docs/onboarding/SKILL.md has no Windows `-match` pattern');
    // PowerShell's -match is case-insensitive.
    const matcher = new RegExp(pattern, 'i');
    assert.match(installerName('0.1.0'), matcher);
    // Releases before #559 stay inside the skill's 20-release window for a while.
    assert.match('omadia.Setup.0.164.0.exe', matcher);
    assert.doesNotMatch(`${installerName('0.1.0')}.blockmap`, matcher);
  });

  it('matches the example in the onboarding table', () => {
    const row = /^\| Windows \|.*\| `([^`]+)` \|$/m.exec(onboarding)?.[1];
    assert.equal(row, installerName('0.1.0'));
  });
});
