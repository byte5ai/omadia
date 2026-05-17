import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  ChatTurnInput,
  ChatTurnResult,
  SemanticAnswer,
} from '@omadia/channel-sdk';
import { turnContext } from '@omadia/orchestrator';
import type { JobHandler, JobSpec } from '@omadia/plugin-api';

import {
  InMemoryProactiveSenderRegistry,
  type ProactiveSender,
} from '../src/plugins/routines/proactiveSender.js';
import {
  parseRoutineOutputTemplate,
  type RoutineOutputTemplate,
} from '../src/plugins/routines/routineOutputTemplate.js';
import {
  RoutineRunner,
  type JobSchedulerLike,
  type OrchestratorLike,
} from '../src/plugins/routines/routineRunner.js';
import type {
  InsertRoutineRunInput,
  RoutineRun,
  RoutineRunsStore,
} from '../src/plugins/routines/routineRunsStore.js';
import type {
  CreateRoutineInput,
  RecordRunInput,
  Routine,
  RoutineStatus,
  RoutineStore,
} from '../src/plugins/routines/routineStore.js';

/**
 * Phase C.8 — HR Routine Migration Integration Test.
 *
 * End-to-end smoke for the templated-routine pipeline against the
 * reference HR template at `seed/routine-templates/hr-daily-summary.json`.
 * Stubs the orchestrator to simulate what a real HR sub-agent run would
 * produce:
 *
 *   - tool dispatch fires `captureRawToolResult('query_odoo_hr', '<text + JSON block>')`
 *     (the renderer's `extractFirstJsonBlock` digs the structured rows
 *     out of natural-language prose)
 *   - LLM textual answer is the slot JSON `{ intro, summary }`
 *
 * Verifies:
 *   - the directive is appended to the routine prompt (C.5)
 *   - tool-result capture is live (C.2)
 *   - slot parsing handles real-world prose-wrapped JSON (C.3)
 *   - markdown rendering composes intro + grouped absences table +
 *     birthdays list + summary + footer (C.4)
 *   - adaptive-card rendering of the same template produces a `Table`
 *     element + bullets via TextBlocks (C.6)
 *   - sender receives both `message.text` (markdown fallback) and
 *     `cardBody` (Adaptive Card items) for the adaptive-card variant
 *
 * The reference template lives on disk so this test also acts as a
 * schema regression: if the operator-facing artifact drifts, this
 * test fails first.
 */

class StubScheduler implements JobSchedulerLike {
  private readonly entries = new Map<
    string,
    { agentId: string; spec: JobSpec; handler: JobHandler }
  >();

  register(agentId: string, spec: JobSpec, handler: JobHandler): () => void {
    if (this.entries.has(spec.name)) {
      throw new Error(`StubScheduler: duplicate name '${spec.name}'`);
    }
    this.entries.set(spec.name, { agentId, spec, handler });
    return () => {
      this.entries.delete(spec.name);
    };
  }

  stopForPlugin(agentId: string): void {
    for (const [name, entry] of [...this.entries.entries()]) {
      if (entry.agentId === agentId) this.entries.delete(name);
    }
  }

  async fire(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`StubScheduler: no handler for '${name}'`);
    await entry.handler(new AbortController().signal);
  }
}

class InMemoryRoutineStore {
  public readonly rows = new Map<string, Routine>();
  public recordRunCalls: RecordRunInput[] = [];
  private nextId = 1;

  async create(input: CreateRoutineInput): Promise<Routine> {
    const id = `routine-${this.nextId++}`;
    const now = new Date();
    const routine: Routine = {
      id,
      tenant: input.tenant,
      userId: input.userId,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      channel: input.channel,
      conversationRef: input.conversationRef,
      status: 'active',
      timeoutMs: input.timeoutMs ?? 600_000,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      outputTemplate: input.outputTemplate ?? null,
    };
    this.rows.set(id, routine);
    return routine;
  }

  async get(id: string): Promise<Routine | null> {
    return this.rows.get(id) ?? null;
  }

  async listForUser(): Promise<Routine[]> {
    return [...this.rows.values()];
  }

  async listAllActive(): Promise<Routine[]> {
    return [...this.rows.values()].filter((r) => r.status === 'active');
  }

  async countActiveForUser(): Promise<number> {
    return [...this.rows.values()].length;
  }

  async setStatus(id: string, status: RoutineStatus): Promise<Routine | null> {
    const existing = this.rows.get(id);
    if (!existing) return null;
    const updated: Routine = { ...existing, status, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async recordRun(input: RecordRunInput): Promise<void> {
    this.recordRunCalls.push(input);
    const existing = this.rows.get(input.id);
    if (!existing) return;
    this.rows.set(input.id, {
      ...existing,
      lastRunAt: new Date(),
      lastRunStatus: input.status,
      lastRunError: input.error ?? null,
    });
  }
}

class InMemoryRoutineRunsStore {
  public readonly inserts: InsertRoutineRunInput[] = [];

  async insert(input: InsertRoutineRunInput): Promise<RoutineRun | null> {
    this.inserts.push(input);
    return null;
  }

  async listForRoutine(): Promise<RoutineRun[]> {
    return [];
  }

  async get(): Promise<RoutineRun | null> {
    return null;
  }
}

class StubSender implements ProactiveSender {
  public readonly channel = 'teams';
  public readonly calls: Array<{
    conversationRef: unknown;
    message: SemanticAnswer;
    cardBody?: readonly unknown[];
  }> = [];

  async send(opts: {
    conversationRef: unknown;
    message: SemanticAnswer;
    cardBody?: readonly unknown[];
  }): Promise<void> {
    this.calls.push(opts);
  }
}

const HR_SUB_AGENT_REALISTIC_RESPONSE = `Hier der Stand zu den HR-Daten für heute:

\`\`\`json
{
  "absences": [
    {
      "name": "Anna Müller",
      "department": "External Service / PHP",
      "position": "Senior Developer",
      "absent_until": "2026-05-18",
      "type": "Urlaub"
    },
    {
      "name": "Ben Lee",
      "department": "External Service / Ops",
      "position": "DevOps Engineer",
      "absent_until": "2026-05-16",
      "type": "Urlaub"
    },
    {
      "name": "Carla Schmidt",
      "department": "External Service / PHP",
      "position": "Junior Developer",
      "absent_until": "2026-05-25",
      "type": "Krank"
    }
  ],
  "birthdays": [
    {
      "name": "Dora Hoffmann",
      "department": "External Service / Backend",
      "date": "17.05."
    }
  ]
}
\`\`\`

Insgesamt 3 Mitarbeiter abwesend, davon 2 wegen Urlaub und 1 krank. Geburtstag
diese Woche: Dora am 17.05.`;

const LLM_SLOT_RESPONSE = JSON.stringify({
  slots: {
    intro: 'Heute, 15. Mai 2026 — Stand 09:00.',
    summary:
      '- 3 Personen abwesend (2× Urlaub, 1× Krank)\n- Konzentration in PHP-Team (2 von 3)\n- 1 Geburtstag diese Woche',
  },
});

async function loadReferenceTemplate(): Promise<RoutineOutputTemplate> {
  const file = path.resolve(
    process.cwd(),
    'seed/routine-templates/hr-daily-summary.json',
  );
  const raw = await fs.readFile(file, 'utf8');
  const parsed = parseRoutineOutputTemplate(JSON.parse(raw));
  if (!parsed.ok) {
    throw new Error(`reference HR template failed schema check: ${parsed.reason}`);
  }
  return parsed.value;
}

function makeHrOrchestrator(): OrchestratorLike {
  return {
    async runTurn(_input: ChatTurnInput): Promise<ChatTurnResult> {
      const capture = turnContext.current()?.captureRawToolResult;
      capture?.('query_odoo_hr', HR_SUB_AGENT_REALISTIC_RESPONSE);
      return {
        answer: LLM_SLOT_RESPONSE,
        toolCalls: 1,
        iterations: 2,
      };
    },
  };
}

async function makeRunner(template: RoutineOutputTemplate): Promise<{
  runner: RoutineRunner;
  store: InMemoryRoutineStore;
  scheduler: StubScheduler;
  sender: StubSender;
}> {
  const store = new InMemoryRoutineStore();
  const runsStore = new InMemoryRoutineRunsStore();
  const scheduler = new StubScheduler();
  const sender = new StubSender();
  const senderRegistry = new InMemoryProactiveSenderRegistry();
  senderRegistry.register(sender);
  const runner = new RoutineRunner({
    store: store as unknown as RoutineStore,
    runsStore: runsStore as unknown as RoutineRunsStore,
    scheduler,
    orchestrator: makeHrOrchestrator(),
    senderRegistry,
    log: () => {},
  });
  void template;
  return { runner, store, scheduler, sender };
}

describe('Phase C.8 — HR routine end-to-end with reference template', () => {
  it('reference template on disk passes schema validation', async () => {
    const tpl = await loadReferenceTemplate();
    assert.equal(tpl.format, 'markdown');
    assert.ok(tpl.sections.length >= 4);
    const slotIds = tpl.sections
      .filter(
        (s): s is { kind: 'narrative-slot'; id: string } =>
          s.kind === 'narrative-slot',
      )
      .map((s) => s.id);
    assert.ok(slotIds.includes('intro'));
    assert.ok(slotIds.includes('summary'));
  });

  it('markdown render: full HR-daily output composes intro + grouped absences + birthdays + summary + footer', async () => {
    const template = await loadReferenceTemplate();
    const { runner, scheduler, sender } = await makeRunner(template);
    const routine = await runner.createRoutine({
      tenant: 'tenant-A',
      userId: 'user-1',
      name: 'HR-Daily',
      cron: '0 9 * * 1-5',
      prompt: 'Erzeuge die HR-Tagesübersicht für heute.',
      channel: 'teams',
      conversationRef: { conversation: { id: 'conv-1' } },
      outputTemplate: template,
    });
    await scheduler.fire(routine.id);
    assert.equal(sender.calls.length, 1);
    const text = sender.calls[0]!.message.text;

    // Intro narrative-slot rendered.
    assert.match(text, /Heute, 15\. Mai 2026 — Stand 09:00\./);

    // Absences title + groupBy sub-headers (Urlaub, Krank) in first-seen order.
    assert.match(text, /## Abwesenheiten heute & geplant/);
    const urlaubIdx = text.indexOf('### Urlaub');
    const krankIdx = text.indexOf('### Krank');
    assert.ok(urlaubIdx >= 0, 'Urlaub group header present');
    assert.ok(krankIdx > urlaubIdx, 'Krank group after Urlaub (first-seen order)');

    // All three names present in the table (from raw Odoo data — no LLM
    // tokenisation, no token cruft).
    assert.match(text, /\| Anna Müller \|/);
    assert.match(text, /\| Ben Lee \|/);
    assert.match(text, /\| Carla Schmidt \|/);

    // Date formatting (Intl de-DE).
    assert.match(text, /18\.05\.2026/);
    assert.match(text, /16\.05\.2026/);
    assert.match(text, /25\.05\.2026/);

    // Birthdays data-list with Mustache interpolation.
    assert.match(text, /## Geburtstage diese Woche/);
    assert.match(text, /- \*\*Dora Hoffmann\*\* \(External Service \/ Backend\) — 17\.05\./);

    // Summary slot rendered.
    assert.match(text, /3 Personen abwesend/);
    assert.match(text, /Konzentration in PHP-Team/);

    // Footer static-markdown rendered.
    assert.match(text, /_Quelle: Odoo HR/);

    // No privacy token shapes anywhere — Phase C's structural guarantee.
    assert.doesNotMatch(text, /«[A-Z_]+_\d+»/);
    assert.doesNotMatch(text, /\[Name\]/);
    assert.doesNotMatch(text, /\[Adresse\]/);

    // No JSON leakage from the LLM's response into user-facing output.
    assert.doesNotMatch(text, /"slots"/);
    assert.doesNotMatch(text, /\{[^}]*"absences"/);
  });

  it('adaptive-card render: same template with format swapped produces Table + TextBlocks + cardBody on sender', async () => {
    const markdownTpl = await loadReferenceTemplate();
    const template: RoutineOutputTemplate = {
      ...markdownTpl,
      format: 'adaptive-card',
    };
    const { runner, scheduler, sender } = await makeRunner(template);
    const routine = await runner.createRoutine({
      tenant: 'tenant-A',
      userId: 'user-1',
      name: 'HR-Daily-Card',
      cron: '0 9 * * 1-5',
      prompt: 'Erzeuge die HR-Tagesübersicht für heute.',
      channel: 'teams',
      conversationRef: { conversation: { id: 'conv-2' } },
      outputTemplate: template,
    });

    await scheduler.fire(routine.id);

    assert.equal(sender.calls.length, 1);
    const call = sender.calls[0]!;

    // Markdown fallback in message.text — same content as the markdown-format
    // test (renderer ran a second pass for the text body).
    assert.match(call.message.text, /Anna Müller/);
    assert.match(call.message.text, /## Abwesenheiten/);

    // Adaptive Card body items shipped via the side channel.
    assert.ok(call.cardBody !== undefined, 'cardBody should be set for adaptive-card format');
    const items = call.cardBody!;
    // Intro TextBlock, then absences title + sub-headers + tables,
    // birthdays title + TextBlock-bullets, summary, footer.
    assert.ok(items.length >= 7, `expected >= 7 card items, got ${items.length}`);

    // First item: intro TextBlock with our slot text.
    const intro = items[0] as Record<string, unknown>;
    assert.equal(intro['type'], 'TextBlock');
    assert.equal(intro['text'], 'Heute, 15. Mai 2026 — Stand 09:00.');

    // Find the absences title.
    const absencesTitleIdx = items.findIndex(
      (it) =>
        (it as Record<string, unknown>)['type'] === 'TextBlock' &&
        (it as Record<string, unknown>)['text'] === 'Abwesenheiten heute & geplant',
    );
    assert.ok(absencesTitleIdx > 0, 'absences title TextBlock present');

    // Right after the title: a sub-header + Table (group bucket).
    const urlaubHeader = items[absencesTitleIdx + 1] as Record<string, unknown>;
    assert.equal(urlaubHeader['text'], 'Urlaub');
    const urlaubTable = items[absencesTitleIdx + 2] as Record<string, unknown>;
    assert.equal(urlaubTable['type'], 'Table');

    // Birthdays bullets land as a single TextBlock with markdown.
    const birthdaysTitleIdx = items.findIndex(
      (it) =>
        (it as Record<string, unknown>)['type'] === 'TextBlock' &&
        (it as Record<string, unknown>)['text'] === 'Geburtstage diese Woche',
    );
    assert.ok(birthdaysTitleIdx > 0);
    const birthdayBlock = items[birthdaysTitleIdx + 1] as Record<string, unknown>;
    assert.equal(birthdayBlock['type'], 'TextBlock');
    assert.match(
      birthdayBlock['text'] as string,
      /- \*\*Dora Hoffmann\*\* \(External Service \/ Backend\) — 17\.05\./,
    );
  });

  it('graceful degradation: malformed sub-agent JSON falls back to empty-data sections, not a crash', async () => {
    const template = await loadReferenceTemplate();
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        const capture = turnContext.current()?.captureRawToolResult;
        // No JSON block at all in the sub-agent answer.
        capture?.('query_odoo_hr', 'Heute keine Daten verfügbar, Odoo timeout.');
        return { answer: LLM_SLOT_RESPONSE, toolCalls: 1, iterations: 1 };
      },
    };
    const store = new InMemoryRoutineStore();
    const runsStore = new InMemoryRoutineRunsStore();
    const scheduler = new StubScheduler();
    const sender = new StubSender();
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    senderRegistry.register(sender);
    const runner = new RoutineRunner({
      store: store as unknown as RoutineStore,
      runsStore: runsStore as unknown as RoutineRunsStore,
      scheduler,
      orchestrator,
      senderRegistry,
      log: () => {},
    });
    const routine = await runner.createRoutine({
      tenant: 'tenant-A',
      userId: 'user-1',
      name: 'HR-Daily-Degraded',
      cron: '0 9 * * 1-5',
      prompt: 'Erzeuge die HR-Tagesübersicht.',
      channel: 'teams',
      conversationRef: {},
      outputTemplate: template,
    });

    await scheduler.fire(routine.id);

    assert.equal(sender.calls.length, 1);
    const text = sender.calls[0]!.message.text;
    // Narrative slots still render.
    assert.match(text, /Heute, 15\. Mai 2026/);
    // Data sections fall back to emptyText.
    assert.match(text, /Heute keine Abwesenheiten gemeldet\./);
    assert.match(text, /Diese Woche keine Geburtstage\./);
    // Footer still ships.
    assert.match(text, /_Quelle: Odoo HR/);
  });
});
