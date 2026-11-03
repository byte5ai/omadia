/**
 * Generic LLM-free row details (omadia-ui-orchestrator rowDetailsGeneric.ts):
 * a table another read tool filled ("list_open_issues" of a builder agent)
 * opens through the same agent's detail tool ("get_issue"), picked by the
 * decision model (`canvas.detail-tool`) on fixed text only.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { DecisionChoiceRequest, DecisionModelService } from '@omadia/plugin-api';

import type { FastPathService, FastPathToolDefinition, RefreshSource } from '../packages/harness-plugin-fast-path/src/index.js';
import {
  DETAIL_TOOL_TASK,
  detailCandidates,
  detailFields,
  detailRecord,
  genericRowDetails,
  keyParameter,
} from '../packages/omadia-ui-orchestrator/src/rowDetailsGeneric.js';

const AGENT = '@omadia/agent-github-issue-tracker';
const VIA = 'query_github_issue_tracker';
const ISSUES = [
  { id: 9001, number: 1671, title: 'Canvas gate', state: 'open', user: { login: 'weegy' } },
  { id: 9002, number: 1672, title: 'No source fits', state: 'open', user: { login: 'anna' } },
];
const ISSUE = {
  ok: true,
  issue: {
    id: 9002,
    node_id: 'I_x',
    url: 'https://api.github.com/x',
    html_url: 'https://github.com/byte5ai/omadia/issues/1672',
    number: 1672,
    title: 'No source fits',
    state: 'open',
    user: { login: 'anna', id: 1 },
    labels: [{ name: 'bug' }, { name: 'fast-path' }],
    comments: 3,
    body: 'x'.repeat(900),
    recent_comments: [{ user: 'a', body: 'b' }],
  },
};

function defs(calls: Array<{ name: string; input: unknown }>): FastPathToolDefinition[] {
  const tool = (name: string, schema: Record<string, unknown>, out: unknown, description: string): FastPathToolDefinition => ({
    name,
    description,
    input_schema: schema,
    via: VIA,
    agentId: AGENT,
    invoke: (input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(JSON.stringify(out));
    },
  });
  return [
    tool('list_open_issues', { type: 'object', properties: { labels: { type: 'string' } } }, { ok: true, items: ISSUES }, 'Lists open issues.'),
    tool('get_issue', { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] }, ISSUE, 'Reads one issue incl. body.'),
    tool('post_comment', { type: 'object', properties: { number: { type: 'integer' }, body: { type: 'string' } }, required: ['number', 'body'] }, {}, 'Posts a comment.'),
    { name: 'get_space', description: 'Other agent.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }, via: 'query_confluence', agentId: '@omadia/agent-confluence' },
  ];
}

const RECIPE = (rowKey: string): RefreshSource => ({
  tool: 'list_open_issues',
  input: {},
  itemsPath: 'items',
  map: { number: 'number', title: 'title', author: 'user.login' },
  rowKey,
});

function fp(answer?: { choice: string; confidence: number }): { fp: FastPathService; reqs: DecisionChoiceRequest[] } {
  const reqs: DecisionChoiceRequest[] = [];
  const decide: DecisionModelService | undefined = answer
    ? { provider: 'jev', choose: (req) => (reqs.push(req), Promise.resolve({ ...answer, model: 'jev-1.14.0' })) }
    : undefined;
  return { fp: { decisionModel: () => decide, timeZone: 'Europe/Berlin' } as unknown as FastPathService, reqs };
}

describe('generic row details — building blocks', () => {
  it('candidates: same agent, read-named, one key parameter — never a write tool or another agent', () => {
    const d = defs([]);
    assert.deepEqual(detailCandidates(d, 'list_open_issues').map((c) => c.name), ['get_issue']);
    assert.deepEqual(keyParameter(d[1]!), { name: 'number', numeric: true });
    assert.deepEqual(detailCandidates(d, 'unknown_tool'), [], 'no owner → none');
  });

  it('detailRecord: the nested record of { ok, issue }, a one-element array, else the root', () => {
    assert.equal(detailRecord(JSON.stringify(ISSUE))?.['number'], 1672);
    assert.equal(detailRecord(JSON.stringify([{ a: 1 }]))?.['a'], 1);
    assert.equal(detailRecord(JSON.stringify([{ a: 1 }, { a: 2 }])), undefined);
    assert.equal(detailRecord('not json'), undefined);
  });

  it('detailFields: plain values, names of nested objects, ids and API urls out, long text capped', () => {
    const f = detailFields(ISSUE.issue, 'de');
    const by = Object.fromEntries(f.map((x) => [x.key, x.value]));
    assert.equal(by['user'], 'anna');
    assert.equal(by['labels'], 'bug, fast-path');
    assert.equal(by['html_url'], 'https://github.com/byte5ai/omadia/issues/1672');
    assert.equal(by['recent_comments'], '1 Einträge');
    assert.equal(by['body']?.length, 600);
    for (const gone of ['id', 'node_id', 'url']) assert.equal(by[gone], undefined, gone);
    assert.equal(f.find((x) => x.key === 'html_url')?.field, 'Link');
  });
});

describe('generic row details — end to end', () => {
  const run = async (rowKey: string, key: string, answer?: { choice: string; confidence: number }) => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const d = defs(calls);
    const f = fp(answer);
    const out = await genericRowDetails({
      fp: f.fp,
      recipe: RECIPE(rowKey),
      rowKey: key,
      definitions: d,
      permitted: new Set(d.map((x) => x.name)),
      baseInvoke: () => Promise.reject(new Error('never ctx.tools.invoke')),
      lang: 'de',
      log: () => {},
    });
    return { out, calls, reqs: f.reqs };
  };

  it('Jev picks get_issue; the row key IS the number → one direct call, Feld/Wert view, decision on done', async () => {
    const { out, calls, reqs } = await run('number', '1672', { choice: 'tool:get_issue', confidence: 0.93 });
    assert.ok(out.hit);
    assert.deepEqual(calls, [{ name: 'get_issue', input: { number: 1672 } }]);
    assert.equal(reqs[0]?.task, DETAIL_TOOL_TASK);
    assert.doesNotMatch(reqs[0]?.input ?? '', /1672|No source fits/, 'no row value reaches the decision model');
    if (out.hit) {
      assert.equal(out.prose, 'Details zu #1672 No source fits.');
      assert.equal(out.decision?.tool, 'get_issue');
      assert.equal(out.decision?.answered, true);
      assert.deepEqual(out.decision?.steps?.map((s) => s.task), [DETAIL_TOOL_TASK]);
    }
  });

  it('rows keyed by id: the number comes from the row record (one re-run of the table recipe)', async () => {
    const { out, calls } = await run('id', '9002', { choice: 'tool:get_issue', confidence: 0.9 });
    assert.ok(out.hit);
    assert.deepEqual(calls.map((c) => c.name), ['list_open_issues', 'get_issue']);
    assert.deepEqual(calls[1]?.input, { number: 1672 });
  });

  it('without a decision model a single candidate is taken; Jev saying none still falls back to it', async () => {
    assert.ok((await run('number', '1671')).out.hit);
    assert.ok((await run('number', '1671', { choice: 'none', confidence: 0.9 })).out.hit);
  });

  it('a key the tool cannot take is a miss (non-numeric for an integer parameter)', async () => {
    const { out, calls } = await run('number', 'abc', { choice: 'tool:get_issue', confidence: 0.9 });
    assert.deepEqual(out, { hit: false, reason: 'key-unresolved' });
    assert.deepEqual(calls, []);
  });
});

describe('generic row details — any integration shape', () => {
  it('a CRM-like agent: list_contacts → get_contact(contactId: string), root record, own link, owner name', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const mk = (name: string, schema: Record<string, unknown>, out: unknown): FastPathToolDefinition => ({
      name,
      description: `${name}.`,
      input_schema: schema,
      via: 'query_crm',
      agentId: '@acme/agent-crm',
      invoke: (input: unknown) => (calls.push({ name, input }), Promise.resolve(JSON.stringify(out))),
    });
    const d = [
      mk('list_contacts', { type: 'object', properties: { city: { type: 'string' } } }, { data: { rows: [] } }),
      mk(
        'get_contact',
        { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
        {
          contactId: 'c-17',
          fullName: 'Anna Becker',
          owner: { displayName: 'Ben Cordes' },
          tags: ['vip', 'berlin'],
          web_url: 'https://crm.example/contacts/c-17',
          avatar_url: 'https://cdn.example/a.png',
          active: true,
        },
      ),
    ];
    const out = await genericRowDetails({
      fp: fp().fp,
      recipe: { tool: 'list_contacts', input: {}, map: { name: 'fullName' }, rowKey: 'contactId' },
      rowKey: 'c-17',
      definitions: d,
      permitted: new Set(d.map((x) => x.name)),
      baseInvoke: () => Promise.reject(new Error('never')),
      lang: 'en',
      log: () => {},
    });
    assert.ok(out.hit);
    assert.deepEqual(calls, [{ name: 'get_contact', input: { contactId: 'c-17' } }]);
    if (out.hit) {
      const rows = JSON.stringify(out.tree);
      assert.match(rows, /"Owner","value":"Ben Cordes"/);
      assert.match(rows, /"Link","value":"https:\/\/crm\.example\/contacts\/c-17"/);
      assert.match(rows, /"Active","value":"Yes"/);
      assert.doesNotMatch(rows, /cdn\.example/, 'API/asset URLs are not shown');
    }
  });
});
