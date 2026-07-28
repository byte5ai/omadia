import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { detectBootstrapCommand } from '../src/bootstrapDetect.js';

describe('detectBootstrapCommand', () => {
  it('returns null for an empty directory — not every repo needs a bootstrap step', () => {
    assert.equal(detectBootstrapCommand([]), null);
  });

  it('returns null when nothing recognizable is present', () => {
    assert.equal(detectBootstrapCommand(['README.md', 'src', '.git']), null);
  });

  it('detects npm ci from package-lock.json', () => {
    assert.equal(detectBootstrapCommand(['package.json', 'package-lock.json']), 'npm ci');
  });

  it('detects npm ci from npm-shrinkwrap.json', () => {
    assert.equal(detectBootstrapCommand(['package.json', 'npm-shrinkwrap.json']), 'npm ci');
  });

  it('detects yarn from yarn.lock', () => {
    assert.equal(detectBootstrapCommand(['package.json', 'yarn.lock']), 'yarn install --frozen-lockfile');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    assert.equal(detectBootstrapCommand(['package.json', 'pnpm-lock.yaml']), 'pnpm install --frozen-lockfile');
  });

  it('falls back to npm install for a bare package.json with no lockfile', () => {
    assert.equal(detectBootstrapCommand(['package.json']), 'npm install');
  });

  it('prefers a lockfile over the bare manifest when both are present', () => {
    assert.equal(detectBootstrapCommand(['package.json', 'package-lock.json', 'yarn.lock']), 'npm ci');
  });

  it('detects pip from requirements.txt', () => {
    assert.equal(detectBootstrapCommand(['requirements.txt']), 'pip install -r requirements.txt');
  });

  it('detects pipenv from Pipfile', () => {
    assert.equal(detectBootstrapCommand(['Pipfile']), 'pipenv install');
  });

  it('detects cargo from Cargo.toml', () => {
    assert.equal(detectBootstrapCommand(['Cargo.toml']), 'cargo fetch');
  });

  it('detects go modules from go.mod', () => {
    assert.equal(detectBootstrapCommand(['go.mod']), 'go mod download');
  });

  it('does not run npm ci from a lockfile with no matching package.json', () => {
    // Regression: found live against byte5ai/omadia's actual repo root — a
    // stray, empty-packages package-lock.json survives from before the repo
    // moved to per-workspace-directory manifests (middleware/package.json,
    // web-ui/package.json), with no root package.json at all. `npm ci`
    // fundamentally requires both files; running it anyway failed with a
    // real, reported exit code (254) instead of gracefully skipping.
    assert.equal(detectBootstrapCommand(['package-lock.json', 'README.md']), null);
  });

  it('does not run yarn/pnpm from a lockfile with no matching package.json either', () => {
    assert.equal(detectBootstrapCommand(['yarn.lock']), null);
    assert.equal(detectBootstrapCommand(['pnpm-lock.yaml']), null);
  });

  it('does not detect a manifest sitting in a subdirectory — root only', () => {
    // Directory listings are flat (one level), so this case is really "the
    // caller only passed root entries" — documented behavior, not a bug to
    // fix here: a monorepo with per-workspace manifests needs an explicit
    // bootstrap_command (see this module's doc comment).
    assert.equal(detectBootstrapCommand(['middleware', 'web-ui', 'README.md']), null);
  });
});
