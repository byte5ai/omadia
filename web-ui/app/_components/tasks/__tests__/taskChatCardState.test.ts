import { describe, expect, it } from 'vitest';

import {
  isTaskStartToolName,
  parseTaskStartResult,
  taskCardLabel,
} from '../taskChatCardState';

/**
 * W2-2 (issue #543) — the generic task card's parser.
 *
 * The card is the only thing a user sees when a tool defers, so a false positive
 * (rendering a card for a non-task tool) and a false negative (dropping a real
 * handle back to a plain tool row) are both user-visible bugs.
 */
describe('parseTaskStartResult', () => {
  it('parses a task_started result into a seed', () => {
    const seed = parseTaskStartResult(
      JSON.stringify({
        status: 'task_started',
        taskId: 't-1',
        tool: 'ask_research_start',
        kind: 'subagent.Research',
        phase: 'queued',
      }),
    );
    expect(seed).toEqual({
      taskId: 't-1',
      tool: 'ask_research_start',
      kind: 'subagent.Research',
      phase: 'queued',
    });
  });

  it('defaults phase to queued when absent', () => {
    expect(
      parseTaskStartResult(JSON.stringify({ status: 'task_started', taskId: 't-2' }))?.phase,
    ).toBe('queued');
  });

  it('returns null for an Error refusal string', () => {
    expect(parseTaskStartResult('Error: `question` must be a non-empty string.')).toBeNull();
  });

  it('returns null for a start payload using a different status envelope', () => {
    // A tool that ships its own richer card emits its own status value, not
    // `task_started`. The generic card must not hijack it.
    expect(
      parseTaskStartResult(
        JSON.stringify({ status: 'job_started', jobId: 'j-1', repoId: 'r-1' }),
      ),
    ).toBeNull();
  });

  it('returns null for a missing or empty taskId', () => {
    expect(parseTaskStartResult(JSON.stringify({ status: 'task_started' }))).toBeNull();
    expect(
      parseTaskStartResult(JSON.stringify({ status: 'task_started', taskId: '' })),
    ).toBeNull();
    expect(
      parseTaskStartResult(JSON.stringify({ status: 'task_started', taskId: 7 })),
    ).toBeNull();
  });

  it('returns null for prose, malformed JSON, undefined and non-objects', () => {
    expect(parseTaskStartResult(undefined)).toBeNull();
    expect(parseTaskStartResult('')).toBeNull();
    expect(parseTaskStartResult('just some prose')).toBeNull();
    expect(parseTaskStartResult('{not json')).toBeNull();
    expect(parseTaskStartResult('[1,2,3]')).toBeNull();
    expect(parseTaskStartResult('null')).toBeNull();
  });
});

describe('isTaskStartToolName', () => {
  it('matches only the seam start half', () => {
    expect(isTaskStartToolName('ask_research_start')).toBe(true);
    expect(isTaskStartToolName('dev_job_start')).toBe(true);
    expect(isTaskStartToolName('ask_research_status')).toBe(false);
    expect(isTaskStartToolName('ask_research_list')).toBe(false);
    expect(isTaskStartToolName('query_knowledge_graph')).toBe(false);
  });
});

describe('taskCardLabel', () => {
  it('strips the ask_ prefix and _start suffix', () => {
    expect(taskCardLabel('ask_research_start')).toBe('research');
    expect(taskCardLabel('ask_odoo_hr_start')).toBe('odoo hr');
  });

  it('falls back to the raw name when there is nothing to strip', () => {
    expect(taskCardLabel('weird')).toBe('weird');
  });

  it('degrades to a non-empty label for a degenerate name', () => {
    // `ask_start` -> strip `_start` -> `ask`; the `^ask_` strip no longer
    // matches, so the label is `ask` rather than empty. Never blank.
    expect(taskCardLabel('ask_start')).toBe('ask');
    expect(taskCardLabel('_start')).toBe('_start');
  });
});
