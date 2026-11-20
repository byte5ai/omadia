import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ApiError } from '../../_lib/api';
import type { HelperOutOfServiceCode } from '../../_lib/agentBuilder';
import { HELPER_REFUSAL_CODES, helperRefusalCode } from './helperRefusal';

/**
 * #2050 — DB sub-agents are the agent's internal helpers (spec 2042 §5.2): the
 * Agent Builder calls the node "helper" and explains it, and no string of the
 * Builder or of the grant lists presents one as a "sub-agent".
 */

type MessageNode = string | { [key: string]: MessageNode };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.resolve(HERE, '..', '..', '..', 'messages');

function load(locale: string): Record<string, MessageNode> {
  return JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as Record<
    string,
    MessageNode
  >;
}

function at(tree: Record<string, MessageNode>, dotted: string): MessageNode | undefined {
  let node: MessageNode | undefined = tree;
  for (const part of dotted.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = node[part];
  }
  return node;
}

function strings(node: MessageNode | undefined): string[] {
  if (node === undefined) return [];
  if (typeof node === 'string') return [node];
  return Object.values(node).flatMap(strings);
}

const SUB_AGENT = /sub-?agent/i;

describe.each(['en', 'de'])('helper copy (%s)', (locale) => {
  const messages = load(locale);

  it('the Builder node is a helper, never a sub-agent', () => {
    const label = at(messages, 'admin.builder.nodes.subagent');
    expect(typeof label).toBe('string');
    expect(label).toMatch(locale === 'de' ? /^Helfer$/ : /^Helper$/);
  });

  it('no Agent Builder string says sub-agent', () => {
    expect(strings(at(messages, 'admin.builder')).filter((s) => SUB_AGENT.test(s))).toEqual([]);
  });

  it('the grant and audit lists call the holder a helper', () => {
    for (const key of ['adminMcp.grants.kind.subagent', 'adminMcp.audit.kind.subagent']) {
      const value = at(messages, key);
      expect(typeof value).toBe('string');
      expect(value).not.toMatch(SUB_AGENT);
    }
  });

  it('every helper refusal code has a sentence', () => {
    for (const code of HELPER_REFUSAL_CODES) {
      const value = at(messages, `admin.builder.helperErrors.${code}`);
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('every out-of-service code has a sentence, and the reason is shown', () => {
    const codes: HelperOutOfServiceCode[] = ['helper_model_not_allowed', 'helper_name_conflict'];
    for (const code of codes) {
      const value = at(messages, `admin.builder.helperOutOfService.${code}`);
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
    expect(at(messages, 'admin.builder.helperOutOfService.reason')).toMatch(/\{reason\}/);
    expect(typeof at(messages, 'admin.builder.nodes.subagentOutOfService')).toBe('string');
  });
});

describe('helperRefusalCode', () => {
  it('reads the code of a refused helper write, nothing else', () => {
    const refused = new ApiError(
      409,
      'POST failed: 409',
      JSON.stringify({ error: 'helper_refused', code: 'helper_name_collision', message: 'x' }),
    );
    expect(helperRefusalCode(refused)).toBe('helper_name_collision');
    expect(
      helperRefusalCode(new ApiError(409, 'POST failed: 409', JSON.stringify({ error: 'config_validation' }))),
    ).toBeNull();
    expect(helperRefusalCode(new Error('boom'))).toBeNull();
  });
});
