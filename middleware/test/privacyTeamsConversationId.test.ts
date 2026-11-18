/**
 * Teams/Skype conversation ids ("19:…@thread.skype") are routing keys, not
 * e-mail addresses. The C0 baseline must leave them in clear text — a masked
 * id reaches a tool as a pseudonym it cannot resolve. Real addresses, also
 * ones that merely contain "thread", keep being masked.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { detectBaselineSync } from '@omadia/plugin-privacy-guard/dist/promptMask.js';

const emails = (text: string): string[] =>
  detectBaselineSync(text)
    .filter((span) => span.type === 'email')
    .map((span) => text.slice(span.start, span.end));

describe('C0 email detector vs Teams conversation ids', () => {
  for (const id of [
    '19:9cdb0cd5c91049ad99667e30b0795de6@thread.skype',
    '19:0f3c2a1b4d5e6f708192a3b4c5d6e7f8@thread.v2',
    '19:a1b2c3d4e5f60718293a4b5c6d7e8f90@thread.tacv2',
    '19:328d16de-4575-437b-94d2-1086a4904fd7_72e41d28-6a37-4dfc-95fb-2591bc1034cd@unq.gbl.spaces',
  ]) {
    it(`leaves ${id.split('@')[1]} ids unmasked`, () => {
      assert.deepEqual(emails(`Konversation teams/${id}: Platz 1`), []);
    });
  }

  it('still masks real addresses, including thread-like domains', () => {
    const text = 'Mail an anna.berg@example.com, ops@thread.skype.example.org und team@threads.io';
    assert.deepEqual(emails(text), ['anna.berg@example.com', 'ops@thread.skype.example.org', 'team@threads.io']);
  });
});
