// Copy the precompiled standalone validator (gen output, gitignored) into the
// build output so the compiled plugin/validator can import it at runtime.
// tsc does not emit .mjs/.d.mts assets, so this runs as a postbuild step.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(pkgRoot, 'dist', 'src');
mkdirSync(outDir, { recursive: true });

for (const file of ['validators.generated.mjs', 'validators.generated.d.mts']) {
  copyFileSync(join(pkgRoot, 'src', file), join(outDir, file));
  console.log(`copied ${file} → dist/src/`);
}
