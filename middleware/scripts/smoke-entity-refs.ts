/**
 * End-to-end smoke test for the EntityRef capture path. Exercises:
 *
 *   Odoo/Confluence proxy response → extractor → EntityRefBus → Orchestrator
 *   collection window → SessionLogger → transcript .md on disk
 *
 * Runs without Anthropic or upstream API credentials: it fakes the proxy
 * response shapes directly and inspects the resulting Markdown. Purpose is to
 * confirm the HTML-comment anchor actually lands in the transcript before a
 * first real run wires in managed agents.
 *
 * Run:  npx ts-node --transpile-only scripts/smoke-entity-refs.ts
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemMemoryStore } from '@omadia/memory';
import {
  extractConfluencePageRef,
  extractConfluencePageRefs,
} from '@omadia/integration-confluence';
import { EntityRefBus } from '../src/services/entityRefBus.js';
import { extractOdooEntityRefs } from '@omadia/integration-odoo';
import { SessionLogger } from '../src/services/sessionLogger.js';
import { turnContext } from '../src/services/turnContext.js';

async function main(): Promise<void> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'odoo-bot-smoke-'));
  console.log(`[smoke] tmp memory root: ${tmpRoot}`);

  const store = new FilesystemMemoryStore(tmpRoot);
  await store.init();

  const bus = new EntityRefBus();
  const logger = new SessionLogger(store);
  const scope = 'smoke-scope';
  const turnId = 'smoke-turn-1';

  // Also publish noise from a different "turn" to verify the correlation
  // filter actually drops cross-turn refs instead of leaking them.
  const noiseTurnId = 'smoke-noise-turn';

  // 1. Orchestrator opens its collection for the real turn.
  const collection = bus.beginCollection(turnId);

  // 2. Simulate two proxy calls happening during the turn. Everything runs
  //    inside turnContext.run(turnId, …) so the bus tags each publish with
  //    the correct turnId via AsyncLocalStorage.
  await turnContext.run(turnId, async () => {
    const odooResult = [
      { id: 42, name: 'Müller, Anna', department_id: [3, 'Engineering'] },
      { id: 43, name: 'Schmidt, Ben' },
    ];
    for (const ref of extractOdooEntityRefs('hr.employee', 'search_read', odooResult)) {
      bus.publish(ref);
    }

    const confluenceSearchResult = {
      results: [
        { content: { id: '12345', title: 'Onboarding Playbook' } },
        { content: { id: '67890', title: 'OKR Q2' } },
      ],
    };
    for (const ref of extractConfluencePageRefs(confluenceSearchResult)) {
      bus.publish(ref);
    }

    const confluencePage = { id: '12345', title: 'Onboarding Playbook' };
    const pageRef = extractConfluencePageRef(confluencePage);
    if (pageRef) bus.publish(pageRef);
  });

  // 2b. Noise from a parallel turn — must NOT land in our collection.
  await turnContext.run(noiseTurnId, async () => {
    const noise = [{ id: 999, name: 'Noise, Should Not Appear' }];
    for (const ref of extractOdooEntityRefs('hr.employee', 'search_read', noise)) {
      bus.publish(ref);
    }
  });

  // 3. Orchestrator drains at turn end and hands refs to the session logger.
  const entityRefs = collection.drain();
  console.log(`[smoke] captured ${entityRefs.length} refs (pre-dedup)`);

  // Await the log write directly — sessionLogger.log is fire-and-forget in
  // the real path but we need to observe the file here.
  await logger.log({
    scope,
    userMessage: 'Wer ist für Onboarding zuständig?',
    assistantAnswer: 'Anna Müller (Engineering) — Details im Onboarding-Playbook.',
    toolCalls: 3,
    iterations: 2,
    entityRefs,
  });

  // 4. Read back the transcript and assert the anchor comment is in there.
  const day = new Date().toISOString().slice(0, 10);
  const sessionsDir = join(tmpRoot, 'sessions', scope);
  if (!existsSync(sessionsDir)) {
    throw new Error(`[smoke] FAIL — sessions dir not created at ${sessionsDir}`);
  }
  const files = readdirSync(sessionsDir);
  console.log(`[smoke] transcript files: ${files.join(', ')}`);
  const transcriptPath = join(sessionsDir, `${day}.md`);
  const transcript = readFileSync(transcriptPath, 'utf8');

  console.log('\n--- transcript ---');
  console.log(transcript);
  console.log('--- /transcript ---\n');

  const commentMatch = transcript.match(/<!-- entities: (\[.*\]) -->/);
  if (!commentMatch) {
    throw new Error('[smoke] FAIL — entity anchor comment missing from transcript');
  }
  const parsed = JSON.parse(commentMatch[1]!) as Array<Record<string, unknown>>;
  console.log(`[smoke] parsed ${parsed.length} entities from comment:`);
  for (const p of parsed) {
    console.log('         ', p);
  }

  // Expected: 2 hr.employee + 2 confluence.page (one deduped against pageRef).
  const expected = 4;
  if (parsed.length !== expected) {
    throw new Error(
      `[smoke] FAIL — expected ${expected} deduped entities, got ${parsed.length}`,
    );
  }

  const hasMueller = parsed.some(
    (p) => p['m'] === 'hr.employee' && p['id'] === 42 && p['n'] === 'Müller, Anna',
  );
  if (!hasMueller) {
    throw new Error('[smoke] FAIL — hr.employee(42, Müller) not found in anchor');
  }
  const hasNoise = parsed.some((p) => p['id'] === 999);
  if (hasNoise) {
    throw new Error(
      '[smoke] FAIL — noise from parallel turn leaked into this turn (correlation broken)',
    );
  }

  console.log('[smoke] PASS — end-to-end EntityRef flow verified');

  // Cleanup only on success — keep tmpdir on failure for inspection.
  rmSync(tmpRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
