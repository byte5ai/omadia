import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  UNATTENDED_DROPPED_TOOLS,
  toolsForTurn,
} from '@omadia/orchestrator/dist/toolsOffTurn.js';

describe('#1770 / ADR 0242 — tool list of an unattended turn', () => {
  const build = () => [{ name: 'memory' }, { name: 'ask_user_choice' }, { name: 'suggest_follow_ups' }, { name: 'odoo_search' }];

  it('drops the interactive tools only', () => {
    assert.deepEqual(
      toolsForTurn({ unattended: true }, build).map((t: { name: string }) => t.name),
      ['memory', 'odoo_search'],
    );
    assert.deepEqual([...UNATTENDED_DROPPED_TOOLS].sort(), ['ask_user_choice', 'suggest_follow_ups']);
  });

  it('leaves an attended turn alone and a tool-less turn empty', () => {
    assert.equal(toolsForTurn({}, build).length, 4);
    assert.equal(toolsForTurn({ toolsOff: true, unattended: true }, build).length, 0);
  });
});
