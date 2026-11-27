// Memory-ACL plan step 6a — remove each access predicate in `handCatalog.mjs`
// once, run the memory suites, record whether they go red. The record is
// docs/testing/memory-acl-mutation-record.md. It edits the checked-out
// sources in place and restores each file (and rebuilds its package) after
// the mutant, so run it on a throwaway checkout and do not kill it mid-mutant.
// The Neon suites need a pgvector Postgres in MEMORY_PG_TEST_URL /
// GRAPH_PG_TEST_URL; they run one file at a time.
//
//   cd middleware && node scripts/mutation/handMutate.mjs [--only id,id] [--from id]
//
// One JSON line per mutant goes to reports/mutation/memory-acl-hand.jsonl.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MUTANTS } from './handCatalog.mjs';

const MW = process.cwd();
const OUT = join(MW, 'reports/mutation/memory-acl-hand.jsonl');
mkdirSync(join(MW, 'reports/mutation'), { recursive: true });

const mem = readdirSync(join(MW, 'test/memoryAccess'))
  .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.pg.test.ts'))
  // Cheapest, most direct first.
  .sort((a, b) => rank(a) - rank(b))
  .map((f) => `test/memoryAccess/${f}`);
const pg = [
  'aclContract.pg.test.ts',
  'aclContractExcerpts.pg.test.ts',
  'canaryHttp.pg.test.ts',
  'canarySweepOff.pg.test.ts',
  'canarySweepEnforce.pg.test.ts',
  'canarySweepStrict.pg.test.ts',
  'canarySweepMembers.pg.test.ts',
  'aclAfterMigrations.pg.test.ts',
  'lifecycleInvariants.pg.test.ts',
  'lifecycleCleanup.pg.test.ts',
].map((f) => `test/memoryAccess/${f}`);
function rank(f) {
  const order = ['aclContract', 'canaryHttp', 'canarySweepOff', 'canarySweepEnforce', 'canarySweepStrict', 'canarySweepMembers', 'lifecycle'];
  const i = order.findIndex((p) => f.startsWith(p));
  return i === -1 ? 99 : i;
}

function pkgOf(file) {
  const m = /^packages\/([^/]+)\/src\//.exec(file);
  if (!m) return null; // src/: tests load it through tsx
  return JSON.parse(readFileSync(join(MW, 'packages', m[1], 'package.json'), 'utf8')).name;
}
function build(pkg) {
  if (!pkg) return;
  execFileSync('npm', ['run', '-s', 'build', '-w', pkg], { cwd: MW, stdio: 'ignore' });
}

function apply(src, edit) {
  const start = edit.after ? src.indexOf(edit.after) : 0;
  if (start < 0) throw new Error(`anchor not found: ${edit.after}`);
  const positions = [];
  for (let i = src.indexOf(edit.find, start); i >= 0; i = src.indexOf(edit.find, i + 1)) positions.push(i);
  const nth = edit.nth ?? 0;
  if (edit.nth === undefined && !edit.after && positions.length !== 1) {
    throw new Error(`find must be unique (found ${positions.length}): ${edit.find.slice(0, 80)}`);
  }
  const at = positions[nth];
  if (at === undefined) throw new Error(`occurrence ${nth} not found: ${edit.find.slice(0, 80)}`);
  return src.slice(0, at) + edit.replace + src.slice(at + edit.find.length);
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--test', '--test-timeout=120000', '--test-reporter=spec', file],
      { cwd: MW, detached: true, env: process.env },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      // A mutant that breaks the SQL proves nothing either way: a red suite
      // then reports the error, a green one may have fallen back to another
      // query (recall falls back to FTS when the vector search throws).
      if (SQL_ERROR.test(out)) runFile.sqlError = true;
      resolve({ file, code, out, child });
    });
    resolve.child = child;
    runFile.live.add(child);
    child.on('close', () => runFile.live.delete(child));
  });
}
runFile.live = new Set();
runFile.sqlError = false;
const SQL_ERROR = /could not determine data type of parameter|syntax error at or near|operator does not exist|function .* does not exist/;
function killAll() {
  for (const c of runFile.live) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {}
  }
}
const firstFail = (out) =>
  (out.match(/^\s*✖ (.+?) \(\d/m)?.[1] ?? out.match(/Error[^\n]*/)?.[0] ?? '?').slice(0, 200);

/** Runs files with `width` in parallel; resolves at the first failure. */
async function suite(files, width) {
  const queue = [...files];
  let done = false;
  return new Promise((resolve) => {
    let running = 0;
    const next = () => {
      if (done) return;
      if (queue.length === 0 && running === 0) {
        done = true;
        return resolve({ killed: false });
      }
      while (running < width && queue.length > 0) {
        const file = queue.shift();
        running++;
        runFile(file).then((r) => {
          running--;
          if (done) return;
          if (r.code !== 0) {
            done = true;
            killAll();
            return resolve({ killed: true, by: r.file, test: firstFail(r.out) });
          }
          next();
        });
      }
    };
    next();
  });
}

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
let started = from === null;

for (const m of MUTANTS) {
  if (!started && m.id === from) started = true;
  if (!started || (only && !only.has(m.id))) continue;
  const original = readFileSync(join(MW, m.file), 'utf8');
  const pkg = pkgOf(m.file);
  const t0 = Date.now();
  runFile.sqlError = false;
  let result;
  try {
    const mutated = (m.edits ?? [m]).reduce(apply, original);
    if (mutated === original) throw new Error('mutation changed nothing');
    writeFileSync(join(MW, m.file), mutated);
    try {
      build(pkg);
    } catch {
      throw new Error('mutant does not build');
    }
    const sets = m.set === 'pg' ? [['pg', pg, 1]] : m.set === 'both' ? [['mem', mem, 4], ['pg', pg, 1]] : [['mem', mem, 4]];
    result = { killed: false };
    for (const [name, files, width] of sets) {
      const r = await suite(files, width);
      if (r.killed) {
        result = { ...r, set: name };
        break;
      }
    }
  } catch (err) {
    result = { error: String(err.message ?? err) };
  } finally {
    writeFileSync(join(MW, m.file), original);
    build(pkg);
  }
  const line = {
    id: m.id,
    layer: m.layer,
    what: m.what,
    file: m.file,
    ...result,
    ...(runFile.sqlError ? { sqlError: true } : {}),
    secs: Math.round((Date.now() - t0) / 1000),
  };
  appendFileSync(OUT, JSON.stringify(line) + '\n');
  console.log(
    `${m.id.padEnd(6)} ${result.error ? 'ERROR ' + result.error : result.killed ? `KILLED by ${result.by} :: ${result.test}` : 'SURVIVED'}${line.sqlError ? ' [SQL ERROR: invalid mutant]' : ''} (${line.secs}s)`,
  );
}
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages', 'src'], { cwd: MW, encoding: 'utf8' });
console.log(dirty.trim() === '' ? 'TREE CLEAN' : `TREE DIRTY:\n${dirty}`);
