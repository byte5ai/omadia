import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { applyStableIdTokenization } from '@omadia/plugin-privacy-guard/dist/stableIdTokenization.js';
import { createTokenizeMap } from '@omadia/plugin-privacy-guard/dist/tokenizeMap.js';

// ---------------------------------------------------------------------------
// Privacy-Shield v3 (stable-id tokenization, slice 1) — tool-aware PII
// pre-pass. Walks a tool's structured result against operator-declared
// `piiFields` annotations and rewrites annotated leaves into stable
// tokens BEFORE the NER detectors run. Replaces partial-name leaks
// ("«PERSON_5» Vomberg") with whole-field tokenization, and avoids
// the row-doubling failure mode where the same employee yields two
// different counter tokens within the same tool call.
// ---------------------------------------------------------------------------

describe('applyStableIdTokenization · slice 1', () => {
  it('rewrites a top-level field by path', () => {
    const map = createTokenizeMap();
    const raw = { employee_id: 162, name: 'Marvin Vomberg', dept: 'Backend' };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'name', idPath: 'employee_id', type: 'PERSON' }],
      map,
    );
    assert.equal(result.replaced, 1);
    assert.equal(result.skipped, 0);
    const v = result.value as Record<string, unknown>;
    assert.ok(typeof v.name === 'string');
    assert.match(v.name as string, /^«PERSON_\d+»$/);
    assert.equal(v.dept, 'Backend'); // unrelated fields untouched
    // Restoration via the same map yields the original string.
    assert.equal(map.resolve(v.name as string), 'Marvin Vomberg');
  });

  it('rewrites an array-spread (HR-Urlaubsranking shape)', () => {
    const map = createTokenizeMap();
    const raw = {
      employees: [
        { employee_id: 162, name: 'Marvin Vomberg', days: 17 },
        { employee_id: 103, name: 'Dennis Zille', days: 16.69 },
        { employee_id: 198, name: 'Sophie Neumann', days: 13 },
      ],
    };
    const result = applyStableIdTokenization(
      raw,
      [
        {
          path: 'employees[].name',
          idPath: 'employees[].employee_id',
          type: 'PERSON',
        },
      ],
      map,
    );
    assert.equal(result.replaced, 3);
    assert.equal(result.skipped, 0);
    const employees = (result.value as { employees: Array<Record<string, unknown>> })
      .employees;
    for (const emp of employees) {
      assert.match(emp.name as string, /^«PERSON_\d+»$/);
    }
    // Numeric fields and ids stay untouched.
    assert.equal(employees[0]?.employee_id, 162);
    assert.equal(employees[0]?.days, 17);
  });

  it('value-dedup: the same name across rows yields the same token (slice 1)', () => {
    // Slice 1 uses value-keyed dedup. Two rows referencing the same
    // employee by the same string get the same token (good for the
    // typical case). Slice 1.5 will additionally disambiguate
    // homonyms via idPath.
    const map = createTokenizeMap();
    const raw = {
      bookings: [
        { id: 1257, name: 'Marvin Vomberg' },
        { id: 1085, name: 'Marvin Vomberg' },
        { id: 1077, name: 'Dennis Zille' },
      ],
    };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'bookings[].name', idPath: 'bookings[].id', type: 'PERSON' }],
      map,
    );
    assert.equal(result.replaced, 3);
    const bookings = (result.value as { bookings: Array<Record<string, unknown>> })
      .bookings;
    assert.equal(bookings[0]?.name, bookings[1]?.name);
    assert.notEqual(bookings[0]?.name, bookings[2]?.name);
  });

  it('skips leaves that are missing, null, undefined, or non-string', () => {
    const map = createTokenizeMap();
    const raw = {
      items: [
        { id: 1, name: 'Real Name' },
        { id: 2, name: null }, // null leaf
        { id: 3 }, // missing field
        { id: 4, name: 42 }, // wrong type
        { id: 5, name: '' }, // empty string
        { id: 6, name: 'Other Name' },
      ],
    };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'items[].name', idPath: 'items[].id', type: 'PERSON' }],
      map,
    );
    // Only the two real string leaves get tokenised.
    assert.equal(result.replaced, 2);
    const items = (result.value as { items: Array<Record<string, unknown>> }).items;
    assert.match(items[0]?.name as string, /^«PERSON_\d+»$/);
    assert.equal(items[1]?.name, null);
    assert.equal(items[2]?.name, undefined);
    assert.equal(items[3]?.name, 42);
    assert.equal(items[4]?.name, '');
    assert.match(items[5]?.name as string, /^«PERSON_\d+»$/);
  });

  it('skips the annotation entirely when path/idPath shapes disagree', () => {
    const map = createTokenizeMap();
    const raw = {
      employees: [{ employee_id: 1, name: 'Anna' }],
      meta: { batch_id: 42 },
    };
    // path goes through one `[]`, idPath through none — must reject.
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'employees[].name', idPath: 'meta.batch_id', type: 'PERSON' }],
      map,
    );
    assert.equal(result.replaced, 0);
    assert.equal(result.skipped, 1);
    // The data is unchanged on shape-mismatch.
    const employees = (result.value as { employees: Array<Record<string, unknown>> })
      .employees;
    assert.equal(employees[0]?.name, 'Anna');
  });

  it('skips when parallel arrays have different lengths', () => {
    const map = createTokenizeMap();
    // Build a shape where `employees[]` resolves to 3 leaves but
    // `partners[]` resolves to 2 — the walker cannot zip them.
    const raw = {
      employees: [
        { name: 'Anna' },
        { name: 'Beate' },
        { name: 'Clara' },
      ],
      partners: [{ id: 1 }, { id: 2 }],
    };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'employees[].name', idPath: 'partners[].id', type: 'PERSON' }],
      map,
    );
    assert.equal(result.replaced, 0);
    assert.equal(result.skipped, 1);
  });

  it('returns the input untouched when annotations are empty', () => {
    const map = createTokenizeMap();
    const raw = { name: 'Alice' };
    const result = applyStableIdTokenization(raw, [], map);
    assert.equal(result.replaced, 0);
    assert.equal(result.skipped, 0);
    assert.strictEqual(result.value, raw); // same reference — no clone
  });

  it('returns input untouched when raw is not a plain object', () => {
    const map = createTokenizeMap();
    const result = applyStableIdTokenization(
      'just a string',
      [{ path: 'name', idPath: 'id', type: 'PERSON' }],
      map,
    );
    assert.equal(result.replaced, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.value, 'just a string');
  });

  it('does not mutate the caller-supplied object', () => {
    const map = createTokenizeMap();
    const raw = {
      employees: [{ employee_id: 162, name: 'Marvin Vomberg' }],
    };
    const before = JSON.stringify(raw);
    applyStableIdTokenization(
      raw,
      [
        {
          path: 'employees[].name',
          idPath: 'employees[].employee_id',
          type: 'PERSON',
        },
      ],
      map,
    );
    assert.equal(JSON.stringify(raw), before);
  });

  it('defaults type to PERSON when omitted', () => {
    const map = createTokenizeMap();
    const raw = { name: 'Anna Müller', id: 1 };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'name', idPath: 'id' }],
      map,
    );
    assert.equal(result.replaced, 1);
    const v = result.value as Record<string, unknown>;
    assert.match(v.name as string, /^«PERSON_\d+»$/);
  });

  it('handles non-PERSON types (EMAIL)', () => {
    const map = createTokenizeMap();
    const raw = { user_id: 7, email: 'anna@example.com' };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'email', idPath: 'user_id', type: 'EMAIL' }],
      map,
    );
    assert.equal(result.replaced, 1);
    const v = result.value as Record<string, unknown>;
    assert.match(v.email as string, /^«EMAIL_\d+»$/);
    assert.equal(map.resolve(v.email as string), 'anna@example.com');
  });

  it('walks nested objects (user.name shape)', () => {
    const map = createTokenizeMap();
    const raw = { record: { user: { name: 'Jane Doe', age: 30 } } };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'record.user.name', idPath: 'record.user.age', type: 'PERSON' }],
      map,
    );
    assert.equal(result.replaced, 1);
    const name = (result.value as { record: { user: { name: string } } }).record.user
      .name;
    assert.match(name, /^«PERSON_\d+»$/);
  });

  it('applies multiple annotations independently', () => {
    const map = createTokenizeMap();
    const raw = {
      employees: [{ id: 1, name: 'Anna', email: 'anna@x.de' }],
    };
    const result = applyStableIdTokenization(
      raw,
      [
        { path: 'employees[].name', idPath: 'employees[].id', type: 'PERSON' },
        { path: 'employees[].email', idPath: 'employees[].id', type: 'EMAIL' },
      ],
      map,
    );
    assert.equal(result.replaced, 2);
    const emp = (result.value as { employees: Array<Record<string, unknown>> })
      .employees[0]!;
    assert.match(emp.name as string, /^«PERSON_\d+»$/);
    assert.match(emp.email as string, /^«EMAIL_\d+»$/);
  });

  it('silently skips on missing intermediate segments', () => {
    const map = createTokenizeMap();
    const raw = { other: { unrelated: true } };
    const result = applyStableIdTokenization(
      raw,
      [{ path: 'missing[].name', idPath: 'missing[].id', type: 'PERSON' }],
      map,
    );
    assert.equal(result.replaced, 0);
    // Zero leaves found on either side, lengths match (both 0), so
    // not counted as a shape-mismatch — annotation no-ops.
    assert.equal(result.skipped, 0);
  });
});
