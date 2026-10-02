/**
 * Which returned `Error:` texts the dispatch seams withhold whole instead of
 * redacting (`looksExceptionShaped`, `toolErrorRedaction.ts`): the record
 * dumps a driver, an ORM or a serializer prints, where regex redaction would
 * mask the e-mail and leave the name.
 *
 * This file covers the shapes beyond JSON, Python dicts and JavaScript object
 * literals (those are in `toolErrorRedaction.test.ts`):
 *  - Postgres detail lines. A NOT NULL or CHECK violation reports the failing
 *    row (`DETAIL:  Failing row contains (42, Jane Doe, …)`); psycopg keeps it
 *    in the message and Odoo's JSON-RPC `data.message` passes it on.
 *  - Records printed with keyword fields: a Python dataclass or namedtuple
 *    repr, a Kotlin data class, Lombok's `toString`, a Java record, a Java
 *    `Map`.
 *  - Records printed with bare `Key:value` fields: Go's `%+v` and maps.
 *
 * And the hints that must stay readable next to them. Imported from SOURCE so
 * a stale `dist/` cannot hide a change. All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { TOOL_ERROR_PREFIX, withheldToolErrorNotice } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { createPrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import {
  guardControlFlowResult,
  looksExceptionShaped,
} from '../../packages/harness-orchestrator/src/toolErrorRedaction.js';

const NAME = 'Jane Doe';
const EMAIL = 'jane.doe@example.com';

/** psycopg2 `str(err)` for a NOT NULL violation: two lines, two spaces after `DETAIL:`. */
const PG_NOT_NULL =
  'null value in column "street" of relation "res_partner" violates not-null constraint\n' +
  `DETAIL:  Failing row contains (42, ${NAME}, ${EMAIL}, null, t).`;
/** psycopg2 `str(err)` for a CHECK violation. */
const PG_CHECK =
  'new row for relation "res_partner" violates check constraint "res_partner_check_name"\n' +
  `DETAIL:  Failing row contains (42, ${NAME}, ${EMAIL}).`;
/** What an Odoo JSON-RPC error carries in `data.message` for the same failure. */
const ODOO_RPC_MESSAGE = `The operation cannot be completed: ${PG_CHECK}`;

beforeEach(() => {
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});
afterEach(() => {
  mock.restoreAll();
});

describe('looksExceptionShaped — Postgres detail lines', () => {
  it('flags the failing row of a NOT NULL or CHECK violation, as psycopg and Odoo pass it on', () => {
    for (const text of [
      ` ${PG_NOT_NULL}`,
      ` ${PG_CHECK}`,
      ` Odoo: ${ODOO_RPC_MESSAGE}`,
      // A wrapper that joined the lines.
      ` ${PG_CHECK.replace('\n', ' ')}`,
      // psycopg's `err.diag.message_detail`, or node-postgres' `err.detail`, alone.
      ` write failed: Failing row contains (42, ${NAME}, ${EMAIL}).`,
      // Any other detail line quotes a value, too.
      ` invalid input syntax for type json\nDETAIL:  Token "${NAME}" is invalid.`,
    ]) {
      assert.equal(looksExceptionShaped(text), true, text);
    }
  });
});

describe('looksExceptionShaped — keyword and bare-key records', () => {
  it('flags a record printed with keyword fields', () => {
    for (const text of [
      ` could not sync Partner(id=42, name=${NAME}, email=${EMAIL})`, // Kotlin data class, Lombok
      ` could not sync Partner(id=42, name='${NAME}')`, // Python dataclass / namedtuple
      ` could not sync Partner[id=42, name=${NAME}]`, // Java record
      ` could not sync Partner(42, name=${NAME})`, // a positional field first
      ` could not sync res.partner.Row(id=42, name=${NAME})`, // a dotted class name
      ` could not sync Partner(\n    id=42,\n    name='${NAME}',\n)`, // pretty-printed
      ` could not sync {name=${NAME}, id=42}`, // Java Map#toString
    ]) {
      assert.equal(looksExceptionShaped(text), true, text);
    }
  });

  it('flags a record printed with bare `Key:value` fields (Go)', () => {
    for (const text of [
      ` could not sync {Name:${NAME}}`,
      ` could not sync {Name:${NAME} Email:${EMAIL}}`,
      ` could not sync &{ID:42 Name:${NAME}}`,
      ` could not sync map[name:${NAME} id:42]`,
    ]) {
      assert.equal(looksExceptionShaped(text), true, text);
    }
  });
});

describe('looksExceptionShaped — hints stay readable', () => {
  it('leaves driver hints, Odoo hints and kernel notices alone', () => {
    const notice = withheldToolErrorNotice(
      'odoo_write',
      Object.assign(new Error('x'), { name: 'DatabaseError', code: '22P02' }),
      'err_0a1b2c3d4e5f',
    );
    for (const text of [
      ' 22P02 — invalid input syntax for type uuid: "ds_00000000-0000-0000-0000-000000000000"',
      ' function lower(integer) does not exist\nHINT:  No function matches the given name and argument types.',
      " invalid domain term ('state', '=', 'draft')",
      ' Record does not exist or has been deleted.\n(Record: res.partner(42,), User: 2)',
      ' filter(amount>=100) is not supported',
      ' filter(state==draft) is not supported',
      ' rate limited (HTTP 429), retry after 30 s.',
      ' invalid input for `crm_search` — query: String must contain at least 1 character(s); <root>: Required',
      " 1 validation error for search_issues\nlimit\n  Input should be a valid integer [type=int_parsing, input_value='abc', input_type=str]",
      notice.slice(TOOL_ERROR_PREFIX.length),
    ]) {
      assert.equal(looksExceptionShaped(text), false, text);
    }
  });
});

describe('guardControlFlowResult — the real provider would leave the name', () => {
  it('withholds a detail line, a keyword record and a Go record whole', async () => {
    const privacy = createPrivacyTurnHandle({
      service: createPrivacyGuardService(),
      sessionId: 's-shape',
      turnId: 't-shape',
    });
    const results = [
      `Error: Odoo: ${ODOO_RPC_MESSAGE}`,
      `Error: could not sync Partner(id=42, name=${NAME}, email=${EMAIL})`,
      `Error: could not sync {Name:${NAME} Email:${EMAIL}}`,
    ];
    for (const result of results) {
      // Premise: C0 masks the e-mail but detects no name, so redaction alone
      // would hand the name to the model.
      const alone = await privacy.redactToolErrorText({
        toolName: 'odoo_write',
        text: result.slice(TOOL_ERROR_PREFIX.length),
      });
      assert.ok(alone?.outcome === 'redacted' && alone.text.includes(NAME), `premise: ${result}`);

      const out = await guardControlFlowResult({ toolName: 'odoo_write', result, privacy, site: 'test' });
      assert.equal(out.includes(NAME), false, out);
      assert.equal(out.includes(EMAIL), false, out);
      assert.match(out, /^Error: tool `odoo_write` reported an error whose text looked like a raw/);
    }
    const receipt = await privacy.finalize();
    assert.deepEqual(
      receipt?.toolErrors?.map((e) => [e.carrier, e.outcome]),
      results.map(() => ['returned', 'withheld']),
    );
  });
});
