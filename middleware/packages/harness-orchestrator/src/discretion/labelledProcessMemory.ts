/**
 * Spec 2042 §5.11 / #2194 — a stored process keeps the labels of the turns
 * that wrote it, and every read of it adds them to the reading turn. A process
 * can name people and HR facts, and it is read tenant-wide: by the process
 * tools, by the plan-runner (which turns a matching process into the turn's
 * plan) and by the context recall.
 *
 * Wraps the `processMemory@1` provider itself (the kernel decorates it when
 * the provider registers, `ServiceRegistry.decorateOnProvide`), so no
 * consumer reaches a process around its labels:
 *  - `write` keeps the active turn's labels under the subject `process`;
 *  - `edit` adds the earlier writes' labels to the turn first and then keeps
 *    the union (labels only grow per process);
 *  - `query`, `get`, `history` and a duplicate hit on `write` (it names the
 *    stored process back) add the process's labels to the turn.
 *
 * Fail closed as for recalled turns: a failed lookup labels the turn
 * unreadable. Outside a labelled turn (background jobs) nothing is recorded
 * or added. A failed label write is logged and the process stays as written
 * (`labelSubjectWithTurn`).
 */

import type {
  EditProcessInput,
  EditProcessResult,
  ProcessMemoryService,
  ProcessQueryHit,
  ProcessRecord,
  QueryProcessesInput,
  WriteProcessInput,
  WriteProcessResult,
} from '@omadia/plugin-api';

import { turnContext } from '../turnContext.js';
import type { DiscretionPort } from './port.js';
import { labelSubjectWithTurn, labelTurnWithSubjects } from './toolFlow.js';

const SUBJECT = 'process' as const;

export class LabelledProcessMemory implements ProcessMemoryService {
  constructor(
    private readonly inner: ProcessMemoryService,
    private readonly port: DiscretionPort,
  ) {}

  async write(input: WriteProcessInput): Promise<WriteProcessResult> {
    const result = await this.inner.write(input);
    if (result.ok) await this.keep(result.record.id);
    else if (result.reason === 'duplicate') await this.read([result.conflictingId]);
    return result;
  }

  async edit(input: EditProcessInput): Promise<EditProcessResult> {
    const result = await this.inner.edit(input);
    if (result.ok) {
      await this.read([result.record.id]);
      await this.keep(result.record.id);
    }
    return result;
  }

  async query(input: QueryProcessesInput): Promise<readonly ProcessQueryHit[]> {
    const hits = await this.inner.query(input);
    await this.read(hits.map((hit) => hit.record.id));
    return hits;
  }

  async get(id: string): Promise<ProcessRecord | null> {
    const record = await this.inner.get(id);
    if (record) await this.read([record.id]);
    return record;
  }

  async history(id: string): Promise<readonly ProcessRecord[]> {
    const records = await this.inner.history(id);
    if (records.length > 0) await this.read([id]);
    return records;
  }

  private async read(ids: readonly string[]): Promise<void> {
    await labelTurnWithSubjects(this.port, SUBJECT, ids);
  }

  private async keep(id: string): Promise<void> {
    await labelSubjectWithTurn(this.port, SUBJECT, id, turnContext.currentAgentSlug() ?? 'default');
  }
}

/** The kernel's `processMemory` decorator: labelled, never twice. */
export function labelProcessMemory(inner: ProcessMemoryService, port: DiscretionPort): ProcessMemoryService {
  return inner instanceof LabelledProcessMemory ? inner : new LabelledProcessMemory(inner, port);
}
