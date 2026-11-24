import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const resume = fileURLToPath(new URL('./resume', import.meta.url));

test('resume restores shell activation after snapshot profiles are reset', () => {
  const home = mkdtempSync(join(tmpdir(), 'omadia-resume-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    mkdirSync(join(home, '.config/omadia'), { recursive: true });
    // Database startup is unrelated to shell activation. Keep this test
    // runnable without Docker or sudo while exercising the real resume script.
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(home, '.config/omadia/orb-env.sh'),
      'export OMADIA_TEST_ACTIVATIONS=$((${OMADIA_TEST_ACTIVATIONS:-0} + 1))\n',
    );
    const env = { HOME: home, PATH: `${bin}:/usr/local/bin:/usr/bin:/bin` };
    for (let activation = 0; activation < 2; activation++) {
      // Amp replaces setup-time profile edits before activating a snapshot.
      writeFileSync(join(home, '.bash_profile'), 'export PROFILE_CONTROL=preserved\n');
      execFileSync('/bin/bash', [resume], { env });
      execFileSync('/bin/bash', [resume], { env });
      const output = execFileSync(
        '/bin/bash',
        ['-lc', 'printf "%s %s" "${OMADIA_TEST_ACTIVATIONS:-0}" "$PROFILE_CONTROL"'],
        { env, encoding: 'utf8' },
      );
      assert.equal(output, '1 preserved');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
