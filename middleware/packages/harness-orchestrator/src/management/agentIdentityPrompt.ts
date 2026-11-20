/**
 * #2056 — the system prompt starts from the agent's own identity (spec 2042
 * G1, §5.5). The old default ("an AI assistant that answers requests by
 * delegating to specialised domain agents") described an orchestrator; an
 * agent is a virtual colleague who speaks only as itself.
 *
 * Two parts:
 *  - {@link DEFAULT_AGENT_IDENTITY}: the opening for an agent whose operator
 *    authored no identity text;
 *  - {@link identityRules}: appended to EVERY agent's identity, authored or
 *    not — who it is, which colleagues it may consult, that it never speaks as
 *    another agent and never claims to be human. The identity guard enforces
 *    the same rules on the output; the prompt makes them the agent's own.
 */

/** The opening of an agent's system prompt when its operator authored none. */
export const DEFAULT_AGENT_IDENTITY =
  'Du bist ein KI-Agent und arbeitest als virtueller Kollege in diesem Team: mit eigenem Namen, eigener Rolle und den Fähigkeiten, die dir freigegeben sind. Du merkst dir Lernpunkte über Sessions hinweg.';

/**
 * The identity rules every agent's prompt carries. `colleagues` are the
 * agents it may consult (directed consultation grants, #2047); absent or
 * empty = none.
 */
export function identityRules(colleagues: readonly string[] = []): string {
  const consult =
    colleagues.length > 0
      ? `Kollegen, die du um einen Beitrag bitten darfst: ${colleagues.join(', ')}. Ihre Beiträge stellt das System unverändert und unter ihrem Namen zu; du verweist nur darauf.`
      : 'Rückfragen bei Kollegen sind für dich nicht eingerichtet.';
  return [
    '## Wer du bist',
    '- Du sprichst immer nur als du selbst. Du gibst dich nie als ein anderer Agent aus und nie als Mensch; wirst du gefragt, sagst du offen, dass du ein KI-Agent bist.',
    '- Du gibst nicht wieder, was ein Kollege gesagt, gemeint oder empfohlen hat. Weißt du, dass ein Kollege besser helfen kann, nenne ihn, damit man ihn direkt ansprechen kann.',
    `- ${consult}`,
  ].join('\n');
}

/** Appends {@link identityRules} to an identity text. */
export function withIdentityRules(identity: string | undefined, colleagues?: readonly string[]): string {
  const base = identity?.trim() || DEFAULT_AGENT_IDENTITY;
  return `${base}\n\n${identityRules(colleagues)}`;
}
