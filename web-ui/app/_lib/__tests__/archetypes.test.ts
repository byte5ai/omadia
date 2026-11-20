import { describe, expect, it } from 'vitest';

import {
  archetypeText,
  parseOperatorArchetypes,
  parsePluginArchetype,
} from '../archetypes';

/**
 * #2088 — archetypes as the operator UI reads them: the descriptor of an
 * install refusal and the list of `GET /v1/operator/archetypes`. Both arrive
 * untyped, so both are parsed defensively.
 */
describe('archetypes', () => {
  it('picks the text in the operator language, else the other one', () => {
    const text = { en: 'Facilitators', de: 'Facilitatoren' };
    expect(archetypeText(text, 'de')).toBe('Facilitatoren');
    expect(archetypeText(text, 'de-AT')).toBe('Facilitatoren');
    expect(archetypeText(text, 'en')).toBe('Facilitators');
    expect(archetypeText({ en: 'Coach' }, 'de')).toBe('Coach');
    expect(archetypeText({ de: 'Coach' }, 'en')).toBe('Coach');
    expect(archetypeText('As written', 'de')).toBe('As written');
    expect(archetypeText('  ', 'de')).toBeUndefined();
    expect(archetypeText(null, 'de')).toBeUndefined();
    expect(archetypeText(undefined, 'en')).toBeUndefined();
  });

  it('reads the descriptor of an install refusal and tolerates what is missing', () => {
    expect(
      parsePluginArchetype({
        id: 'facilitator',
        omits: ['memory', 'plugin_grant'],
        adds: ['agent_turn'],
        requires: ['own_channel_identity'],
        noun: 'a facilitator',
        label: { en: 'Facilitator', de: 'Facilitator' },
        description: 'Moderates.',
        roleContract: 'not shown',
      }),
    ).toEqual({
      id: 'facilitator',
      omits: ['memory', 'plugin_grant'],
      adds: ['agent_turn'],
      requires: ['own_channel_identity'],
      noun: 'a facilitator',
      label: { en: 'Facilitator', de: 'Facilitator' },
      description: 'Moderates.',
    });
    expect(parsePluginArchetype({ id: 'coach', omits: 'memory' })).toEqual({
      id: 'coach',
      omits: [],
      adds: [],
      requires: [],
    });
    expect(parsePluginArchetype(null)).toBeNull();
    expect(parsePluginArchetype({ omits: [] })).toBeNull();
  });

  it('reads the archetype list and drops rows it cannot use', () => {
    const list = parseOperatorArchetypes({
      archetypes: [
        { id: 'standard', source: 'kernel', built_in: true, omits: [], adds: [], requires: [], plugin: null, agent_count: 12 },
        {
          id: 'facilitator',
          source: '@omadia/agent-facilitator',
          built_in: false,
          label: { en: 'Facilitator' },
          label_plural: { en: 'Facilitators', de: 'Facilitatoren' },
          description: null,
          omits: ['memory'],
          adds: ['agent_turn'],
          requires: [],
          plugin: { id: '@omadia/agent-facilitator', status: 'active' },
          agent_count: 1,
        },
        { source: 'kernel' },
        'nonsense',
      ],
    });
    expect(list.map((a) => a.id)).toEqual(['standard', 'facilitator']);
    expect(list[0]).toMatchObject({ built_in: true, plugin: null, agent_count: 12, label: null });
    expect(list[1]).toMatchObject({
      plugin: { id: '@omadia/agent-facilitator', status: 'active' },
      label_plural: { en: 'Facilitators', de: 'Facilitatoren' },
    });
    expect(parseOperatorArchetypes({})).toEqual([]);
    expect(parseOperatorArchetypes(null)).toEqual([]);
  });
});
