// Decides one leg of the dependency audit from npm's JSON reports and the lockfile.
//
// `npm audit --audit-level=high` fails on any high or critical advisory in the
// full tree, development tooling included, and that stays the default. A few
// advisories have no fixed release and reach the tree only through a
// development tool, for example a linter's glob matcher. For those the leg
// accepts a dated exception from `.github/audit-exceptions.json`, and only when:
//   - the advisory is absent from the production tree (`npm audit --omit=dev`),
//   - every route from the project (the root or a workspace) to a vulnerable
//     copy starts at a devDependency the exception names in `via`, and no route
//     passes through a runtime that merely sits in devDependencies (`electron`
//     for the desktop, security-architecture §4a),
//   - the exception names the advisory, the package and this workspace, gives a
//     reason, was reviewed by today, and has not expired (at most 90 days after
//     its review).
// The routes come from `package-lock.json`, resolved the way Node resolves
// `node_modules`, not from the report's `effects` links: npm leaves dependents
// out of `effects` (only the first advisory per range records them, and a
// dependent whose range also allows a fixed version is skipped).
//
// Usage (from a workspace directory, as the CI audit step runs it):
//   node ../.github/scripts/audit-gate.mjs --workspace web-ui \
//     --full audit-report.json --prod audit-prod.json \
//     --lock package-lock.json --exceptions ../.github/audit-exceptions.json
// Tests: node --test .github/scripts/audit-gate.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** devDependencies that ship as a runtime: their advisories count like production ones. */
export const RUNTIME_DEV_DEPENDENCIES = Object.freeze({ desktop: Object.freeze(['electron']) });

/** The longest an exception may run from its review before it has to be reviewed again. */
export const MAX_EXCEPTION_DAYS = 90;

/** How far ahead of its expiry an exception is announced. */
export const EXPIRY_NOTICE_DAYS = 14;

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const GHSA_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_REASON_LENGTH = 40;
const NODE_MODULES = 'node_modules/';

/**
 * The high and critical advisories of an `npm audit --json` report, one entry
 * per advisory and vulnerable package, with the report's `nodes` (lockfile
 * paths of the vulnerable copies). Throws when the input is not such a report,
 * so an error page or an empty file never reads as a clean tree.
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
      const nodes = Array.isArray(report.vulnerabilities[pkg]?.nodes) ? report.vulnerabilities[pkg].nodes : [];
      found.set(`${id} ${pkg}`, { id, package: pkg, severity: via.severity, url: via.url ?? '', nodes });
    }
  }
  return [...found.values()];
}

function advisoryId(via) {
  const match = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(via.url ?? '');
  return match ? match[0] : `npm-advisory-${String(via.source)}`;
}

/** The package name of a lockfile path (`node_modules/a/node_modules/@s/b` is `@s/b`), or null for the root and workspaces. */
export function packageNameOf(lockPath) {
  const at = lockPath.lastIndexOf(NODE_MODULES);
  if (at === -1 || (at > 0 && lockPath[at - 1] !== '/')) return null;
  return lockPath.slice(at + NODE_MODULES.length);
}

function resolveFrom(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `${NODE_MODULES}${name}` : `${base}/${NODE_MODULES}${name}`;
    const entry = packages[candidate];
    if (entry !== undefined) return entry.link === true && typeof entry.resolved === 'string' ? entry.resolved : candidate;
    if (base === '') return null;
    const cut = base.lastIndexOf(`/${NODE_MODULES}`);
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

/**
 * The dependency graph of an npm v2/v3 lockfile, as reverse edges. The root
 * and every workspace directory are "owners": their devDependencies are
 * installed, so their edges carry the dependency type ("dev" or "prod"). An
 * optional or peer dependency that is not installed has no edge.
 */
export function lockGraph(lock) {
  const packages = lock?.packages;
  if (packages === null || typeof packages !== 'object' || packages[''] === undefined) {
    throw new Error('not an npm lockfile (no "packages" map with a root entry)');
  }
  const owners = new Set(Object.keys(packages).filter((p) => p === '' || !p.split('/').includes('node_modules')));
  const reverse = new Map();
  const forward = new Map();
  for (const [from, entry] of Object.entries(packages)) {
    if (entry?.link === true) continue;
    const fields = [
      ['dependencies', 'prod'],
      ['optionalDependencies', 'prod'],
      ['peerDependencies', 'prod'],
      ...(owners.has(from) ? [['devDependencies', 'dev']] : []),
    ];
    for (const [field, type] of fields) {
      for (const name of Object.keys(entry?.[field] ?? {})) {
        const target = resolveFrom(packages, from, name);
        if (target === null) continue;
        const edges = reverse.get(target) ?? [];
        edges.push({ from, name, type });
        reverse.set(target, edges);
        forward.set(from, [...(forward.get(from) ?? []), target]);
      }
    }
  }
  // Everything the project actually reaches; a lockfile entry outside this set
  // (an orphan, or a cycle nothing leads into) is not part of any route.
  const reachable = new Set(owners);
  const queue = [...owners];
  while (queue.length > 0) {
    for (const next of forward.get(queue.shift()) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return { packages, owners, reverse, reachable };
}

/**
 * Every route from an owner to the given lockfile paths: the owner-level
 * dependencies the routes start at, the paths with no route upwards, and the
 * first runtime package (by name) any route passes through.
 */
export function routesTo(graph, locations, runtimeNames = new Set()) {
  const roots = new Map();
  const unrooted = [];
  let runtime = null;
  const seen = new Set();
  const queue = [...locations];
  while (queue.length > 0) {
    const at = queue.shift();
    if (seen.has(at)) continue;
    seen.add(at);
    // An aliased install (`"x": "npm:electron@44"`) keeps the real name in the entry.
    const names = [packageNameOf(at), graph.packages[at]?.name].filter((n) => typeof n === 'string');
    if (runtime === null && names.some((n) => runtimeNames.has(n))) runtime = at;
    const incoming = graph.reverse.get(at) ?? [];
    if (!graph.owners.has(at) && !graph.reachable.has(at)) unrooted.push(at);
    for (const edge of incoming) {
      if (graph.owners.has(edge.from)) roots.set(`${edge.from}|${edge.name}|${edge.type}`, { owner: edge.from, name: edge.name, type: edge.type });
      else queue.push(edge.from);
    }
  }
  return { roots: [...roots.values()].sort((a, b) => `${a.owner}|${a.name}`.localeCompare(`${b.owner}|${b.name}`)), unrooted, runtime };
}

/** Why an exception entry is not acceptable as written; empty when it is. */
export function exceptionProblems(entry) {
  const problems = [];
  if (entry === null || typeof entry !== 'object') return ['not an object'];
  if (typeof entry.advisory !== 'string' || !GHSA_ID.test(entry.advisory)) problems.push('"advisory" must be a GHSA id');
  if (typeof entry.package !== 'string' || entry.package === '') problems.push('"package" is missing');
  if (!nonEmptyStrings(entry.workspaces)) problems.push('"workspaces" must list at least one workspace');
  if (!nonEmptyStrings(entry.via)) problems.push('"via" must list the devDependencies the package is reached through');
  else {
    for (const workspace of entry.workspaces ?? []) {
      const runtime = (RUNTIME_DEV_DEPENDENCIES[workspace] ?? []).filter((name) => entry.via.includes(name));
      if (runtime.length > 0) problems.push(`"via" names ${runtime.join(', ')}, a runtime of ${workspace}; its advisories cannot be excepted`);
    }
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
    problems.push(`"reason" must explain in at least ${MIN_REASON_LENGTH} characters why the code is not reachable`);
  }
  const reviewed = parseDate(entry.reviewed);
  const expires = parseDate(entry.expires);
  if (reviewed === null) problems.push('"reviewed" must be a valid YYYY-MM-DD date');
  if (expires === null) problems.push('"expires" must be a valid YYYY-MM-DD date');
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

/** Milliseconds of a YYYY-MM-DD date, or null; a date that does not exist (2026-02-31) is null. */
function parseDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  return time;
}

function routeLabel(root) {
  return root.owner === '' ? root.name : `${root.owner}:${root.name}`;
}

/**
 * The decision for one workspace. `failures` fail the leg, `warnings` and
 * `notices` are reported. `today` is a YYYY-MM-DD date (UTC).
 */
export function evaluate({ workspace, full, prod, lock, exceptions, today }) {
  const failures = [];
  const warnings = [];
  const notices = [];
  if (parseDate(today) === null) throw new Error(`"${today}" is not a valid date`);

  const valid = [];
  const entries = Array.isArray(exceptions?.exceptions) ? exceptions.exceptions : [];
  if (!Array.isArray(exceptions?.exceptions)) failures.push('audit-exceptions.json has no "exceptions" array');
  entries.forEach((entry, index) => {
    const problems = exceptionProblems(entry);
    if (entry?.reviewed > today) problems.push(`"reviewed" (${entry.reviewed}) lies in the future`);
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

  const fullAdvisories = blockingAdvisories(full);
  const graph = fullAdvisories.some((a) => !inProduction.has(`${a.id} ${a.package}`)) ? lockGraph(lock) : null;
  const runtimeNames = new Set(RUNTIME_DEV_DEPENDENCIES[workspace] ?? []);
  const used = new Set();
  for (const advisory of fullAdvisories) {
    if (inProduction.has(`${advisory.id} ${advisory.package}`)) continue;
    if (advisory.nodes.length === 0) {
      failures.push(`${advisory.severity} ${advisory.id} in ${advisory.package}: the report lists no vulnerable copies ("nodes"), so its routes cannot be checked`);
      continue;
    }
    const { roots, unrooted, runtime } = routesTo(graph, advisory.nodes, runtimeNames);
    const label = `${advisory.severity} ${advisory.id} in ${advisory.package} (via ${roots.map(routeLabel).join(', ') || 'no route'})`;
    const entry = valid.find(
      (e) => e.advisory.toUpperCase() === advisory.id.toUpperCase() && e.package === advisory.package && e.workspaces.includes(workspace),
    );
    if (entry === undefined) {
      failures.push(`${label} has no exception in .github/audit-exceptions.json; upgrade or remove the dependency`);
      continue;
    }
    used.add(entry);
    const unnamed = [...new Set(roots.filter((r) => !entry.via.includes(r.name)).map(routeLabel))];
    if (today > entry.expires) {
      failures.push(`${label}: its exception expired on ${entry.expires}; review it again or remove the dependency`);
    } else if (runtime !== null) {
      failures.push(`${label}: a route passes through ${runtime}, which ships as a runtime, so its advisories count like production ones`);
    } else if (unrooted.length > 0) {
      failures.push(`${label}: ${unrooted.join(', ')} has no route from the project in package-lock.json`);
    } else if (roots.length === 0) {
      failures.push(`${label}: no route from the project reaches it in package-lock.json`);
    } else if (roots.some((r) => r.type !== 'dev')) {
      const production = roots.filter((r) => r.type !== 'dev').map(routeLabel);
      failures.push(`${label}: ${production.join(', ')} is not a devDependency`);
    } else if (unnamed.length > 0) {
      failures.push(`${label}: the exception does not name ${unnamed.join(', ')} in "via"`);
    } else {
      notices.push(`${label} accepted until ${entry.expires}: ${entry.reason}`);
      const stale = entry.via.filter((name) => !roots.some((r) => r.name === name));
      if (stale.length > 0) warnings.push(`the exception for ${entry.advisory} in ${entry.package} names ${stale.join(', ')} in "via", which is no route any more`);
      const daysLeft = (parseDate(entry.expires) - parseDate(today)) / DAY_MS;
      if (daysLeft <= EXPIRY_NOTICE_DAYS) {
        warnings.push(`the exception for ${entry.advisory} in ${entry.package} expires on ${entry.expires}: review it again or remove the dependency before then`);
      }
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

export function main(argv) {
  let result;
  try {
    result = evaluate({
      workspace: argValue(argv, '--workspace'),
      full: readJson(argValue(argv, '--full')),
      prod: readJson(argValue(argv, '--prod')),
      lock: readJson(argValue(argv, '--lock')),
      exceptions: readJson(argValue(argv, '--exceptions')),
      today: argv.includes('--today') ? argValue(argv, '--today') : new Date().toISOString().slice(0, 10),
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

function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = 1;
  process.exitCode = main(process.argv.slice(2));
}
