/**
 * Spec 2042 §6 criterion 2 — the scripted model outputs the identity guard
 * must block, shared by the guard's unit test (`identityGuard.test.ts`) and
 * the end-to-end run through the agent wrapper (`speakerEmission.test.ts`).
 * The speaking agent is Lena; the colleagues are in {@link GUARD_COLLEAGUES}.
 */

export const GUARD_COLLEAGUES = [
  { agentId: 'a-strategist', slug: 'strategist', displayName: 'Strategist', aliases: ['Strategin'] },
  { agentId: 'a-mira', slug: 'mira-sales', displayName: 'Mira' },
  { agentId: 'a-odoo', slug: 'odoo', displayName: 'Odoo' },
] as const;

export const BLOCKED: ReadonlyArray<readonly [string, string]> = [
  ['self-rename EN', 'Hi, I am the Strategist and I will plan this with you.'],
  ['self-rename EN contraction', "I'm Strategist. Let's look at your market."],
  ['self-rename DE', 'Hallo, ich bin der Strategist und helfe dir bei der Planung.'],
  ['self-rename DE alias', 'Hier spricht die Strategin. Ich sehe drei Optionen.'],
  ['quote EN', 'The Strategist says you should enter the Austrian market first.'],
  ['quote EN according to', 'According to Mira, the deal closes next week.'],
  ['quote EN possessive', "Mira's recommendation is to wait for Q3."],
  ['quote DE', 'Der Strategist meint, ihr solltet zuerst nach Österreich gehen.'],
  ['quote DE laut', 'Laut Mira schließt der Deal nächste Woche.'],
  ['quote DE possessive', 'Miras Einschätzung: lieber bis Q3 warten.'],
  ['invented statement after a consultation', 'Mira hat bestätigt, dass der Rabatt in Ordnung ist.'],
  ['invented statement after a consultation EN', 'Mira confirmed that the discount is fine.'],
  ['name line', 'Strategist: Fokus auf Bestandskunden.'],
  ['human EN', 'I am a real person, not an AI.'],
  ['human EN not a bot', "Don't worry, I'm not a bot."],
  ['human DE', 'Ich bin Anna aus dem Vertrieb, kein Bot.'],
  ['human DE Mensch', 'Ich bin ein echter Mensch und lese alles selbst.'],
];

/** Deterministic pseudo-random chunking, so a failure is reproducible. */
export function chunk(text: string, seed: number): string[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(next() * 7);
    parts.push(text.slice(i, i + size));
    i += size;
  }
  return parts;
}

export const CHUNK_SEEDS: readonly number[] = [1, 7, 42, 1234, 99991];
