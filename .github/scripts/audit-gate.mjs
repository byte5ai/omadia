// Decides one leg of the dependency audit from npm's JSON reports.
//
// `npm audit --audit-level=high` fails on any high or critical advisory in the
// full tree, development tooling included, and that stays the default. A few
// advisories have no fixed release and reach the tree only through a
// development tool, for example a linter's glob matcher. For those the leg
// accepts a dated exception from `.github/audit-exceptions.json`, and only when:
//   - the advisory is absent from the production tree (`npm audit --omit=dev`),
//   - every route to the vulnerable package starts at a devDependency the
//     exception names (`via`), and none of those is a runtime that merely sits
//     in devDependencies (`electron` for the desktop, security-architecture §4a),
//   - the exception names the advisory, the package and this workspace, gives a
//     reason, and has not expired (at most 90 days after its review).
//
// Usage (from a workspace directory, as the CI audit step runs it):
//   node ../.github/scripts/audit-gate.mjs --workspace web-ui \
//     --full audit-report.json --prod audit-prod.json \
//     --package package.json --exceptions ../.github/audit-exceptions.json
// Tests: node --test .github/scripts/audit-gate.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** devDependencies that ship as a runtime: their advisories count like production ones. */
export const RUNTIME_DEV_DEPENDENCIES = Object.freeze({ desktop: Object.freeze(['electron']) });

/** The longest an exception may run from its review before it has to be reviewed again. */
export const MAX_EXCEPTION_DAYS = 90;

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const GHSA_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_REASON_LENGTH = 40;

/**
 * The high and critical advisories of an `npm audit --json` report, one entry
 * per advisory and vulnerable package. Throws when the input is not such a
 * report, so an error page or an empty file never reads as a clean tree.
 */
export function blockingAdvisories(report) {
  if (report === null || typeof report !== 'object' || report.vulnerabilities === null || typeof report.vulnerabilities !== 'object') {
    throw new Error('not an npm audit JSON report (no "vulnerabilities" object)');
  }
  const found = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    for (const via of entry?.via ?? []) {
      if (via === null || typeof via !== 'object' || !BLOCKING_SEVERITIES.has(via.severity)) continue;
      const pkg = typeof via.name === 'string' && via.name !== '' ? via.name : name;
      const id = advisoryId(via);
      found.set(`${id} ${pkg}`, { id, package: pkg, severity: via.severity, url: via.url ?? '' });
    }
  }
  return [...found.values()];
}

function advisoryId(via) {
  const match = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(via.url ?? '');
  return match ? match[0] : `npm-advisory-${String(via.source)}`;
}

/**
 * The direct dependencies through which `pkg` enters the tree, following the
 * report's `effects` links upwards. A chain that ends at a package that is
 * neither direct nor depended on yields `unrooted:<name>`, which no exception
 * names, so an unexpected report shape fails closed.
 */
export function rootsOf(report, pkg) {
  const roots = new Set();
  const seen = new Set();
  const queue = [pkg];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = report.vulnerabilities[name];
    const parents = Array.isArray(entry?.effects) ? entry.effects : [];
    if (entry?.isDirect === true) roots.add(name);
    else if (parents.length === 0) roots.add(`unrooted:${name}`);
    queue.push(...parents);
  }
  return [...roots].sort();
}

/** Why an exception entry is not acceptable as written; empty when it is. */
export function exceptionProblems(entry) {
  const problems = [];
  if (entry === null || typeof entry !== 'object') return ['not an object'];
  if (typeof entry.advisory !== 'string' || !GHSA_ID.test(entry.advisory)) problems.push('"advisory" must be a GHSA id');
  if (typeof entry.package !== 'string' || entry.package === '') problems.push('"package" is missing');
  if (!nonEmptyStrings(entry.workspaces)) problems.push('"workspaces" must list at least one workspace');
  if (!nonEmptyStrings(entry.via)) problems.push('"via" must list the devDependencies the package is reached through');
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
    problems.push(`"reason" must explain in at least ${MIN_REASON_LENGTH} characters why the code is not reachable`);
  }
  const reviewed = parseDate(entry.reviewed);
  const expires = parseDate(entry.expires);
  if (reviewed === null) problems.push('"reviewed" must be a YYYY-MM-DD date');
  if (expires === null) problems.push('"expires" must be a YYYY-MM-DD date');
  if (reviewed !== null && expires !== null) {
    const days = (expires - reviewed) / DAY_MS;
    if (days < 0) problems.push('"expires" lies before "reviewed"');
    else if (days > MAX_EXCEPTION_DAYS) problems.push(`"expires" lies more than ${MAX_EXCEPTION_DAYS} days after "reviewed"`);
  }
  return problems;
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v !== '');
}

function parseDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

/**
 * The decision for one workspace. `failures` fail the leg, `warnings` and
 * `notices` are reported. `today` is a YYYY-MM-DD date (UTC).
 */
export function evaluate({ workspace, full, prod, packageJson, exceptions, today }) {
  const failures = [];
  const warnings = [];
  const notices = [];

  const valid = [];
  const entries = Array.isArray(exceptions?.exceptions) ? exceptions.exceptions : [];
  entries.forEach((entry, index) => {
    const problems = exceptionProblems(entry);
    if (problems.length > 0) failures.push(`audit-exceptions.json entry ${index + 1}: ${problems.join('; ')}`);
    else valid.push(entry);
  });

  const inProduction = new Set();
  for (const advisory of blockingAdvisories(prod)) {
    inProduction.add(`${advisory.id} ${advisory.package}`);
    failures.push(
      `${advisory.severity} ${advisory.id} in ${advisory.package} is in the production tree (${advisory.url}); ` +
        'no exception covers a production dependency',
    );
  }

  const devDependencies = new Set(Object.keys(packageJson?.devDependencies ?? {}));
  const runtime = new Set(RUNTIME_DEV_DEPENDENCIES[workspace] ?? []);
  const used = new Set();
  for (const advisory of blockingAdvisories(full)) {
    if (inProduction.has(`${advisory.id} ${advisory.package}`)) continue;
    const roots = rootsOf(full, advisory.package);
    const label = `${advisory.severity} ${advisory.id} in ${advisory.package} (via ${roots.join(', ')})`;
    const entry = valid.find(
      (e) => e.advisory.toUpperCase() === advisory.id.toUpperCase() && e.package === advisory.package && e.workspaces.includes(workspace),
    );
    if (entry === undefined) {
      failures.push(`${label} has no exception in .github/audit-exceptions.json; upgrade or remove the dependency`);
      continue;
    }
    used.add(entry);
    if (today > entry.expires) {
      failures.push(`${label}: its exception expired on ${entry.expires}; review it again or remove the dependency`);
      continue;
    }
    const runtimeRoots = roots.filter((root) => runtime.has(root));
    const nonDevRoots = roots.filter((root) => !devDependencies.has(root));
    const unnamedRoots = roots.filter((root) => !entry.via.includes(root));
    if (runtimeRoots.length > 0) {
      failures.push(`${label}: ${runtimeRoots.join(', ')} ships as a runtime, so its advisories count like production ones`);
    } else if (nonDevRoots.length > 0) {
      failures.push(`${label}: ${nonDevRoots.join(', ')} is not a devDependency of ${workspace}`);
    } else if (unnamedRoots.length > 0) {
      failures.push(`${label}: the exception does not name ${unnamedRoots.join(', ')} in "via"`);
    } else {
      notices.push(`${label} accepted until ${entry.expires}: ${entry.reason}`);
    }
  }

  for (const entry of valid) {
    if (entry.workspaces.includes(workspace) && !used.has(entry)) {
      warnings.push(`the exception for ${entry.advisory} in ${entry.package} matches nothing in ${workspace} any more; remove it`);
    }
  }
  return { failures, warnings, notices };
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) throw new Error(`missing ${name}`);
  return argv[index + 1];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

function main(argv) {
  let result;
  try {
    const todayArg = argv.includes('--today') ? argValue(argv, '--today') : new Date().toISOString().slice(0, 10);
    result = evaluate({
      workspace: argValue(argv, '--workspace'),
      full: readJson(argValue(argv, '--full')),
      prod: readJson(argValue(argv, '--prod')),
      packageJson: readJson(argValue(argv, '--package')),
      exceptions: readJson(argValue(argv, '--exceptions')),
      today: todayArg,
    });
  } catch (err) {
    console.log(`::error::audit gate: ${err.message}`);
    return 1;
  }
  for (const line of result.notices) console.log(`::notice::${line}`);
  for (const line of result.warnings) console.log(`::warning::${line}`);
  for (const line of result.failures) console.log(`::error::${line}`);
  return result.failures.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
