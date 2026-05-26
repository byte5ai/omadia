/**
 * Privacy Shield v4 — On-the-wire confidentiality harness (US4).
 *
 * Turns guarantee G1 into a verifiable property. Given an LLM-bound payload
 * (the Anthropic `messages.create` params — system prompt + message history +
 * `tool_result` blocks) and the set of real identity values for a turn, it
 * reports every place an identity value appears. Zero leaks ⇒ confidentiality
 * held on the wire (SC-003, SC-006).
 *
 * Pure and dependency-free: usable as a unit assertion over fixture payloads
 * and, later, as a live interceptor at the Anthropic SDK call seam.
 */

export interface IdentityLeak {
  /** JSON-path-like location of the leak within the payload. */
  readonly path: string;
  /** The identity value that leaked. */
  readonly value: string;
}

/** Visit every string reachable in an arbitrary JSON-like value. */
function walkStrings(
  node: unknown,
  path: string,
  visit: (path: string, value: string) => void,
): void {
  if (typeof node === 'string') {
    visit(path, node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) =>
      walkStrings(item, `${path}[${String(i)}]`, visit),
    );
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      walkStrings(value, `${path}.${key}`, visit);
    }
  }
}

/**
 * Scan an LLM-bound payload for identity values. Returns every occurrence;
 * an empty array means the payload is identity-free.
 */
export function findIdentityLeaks(
  payload: unknown,
  identityValues: ReadonlyArray<string>,
): IdentityLeak[] {
  const needles = [...new Set(identityValues)].filter((v) => v.length > 0);
  const leaks: IdentityLeak[] = [];
  walkStrings(payload, '$', (path, str) => {
    for (const needle of needles) {
      if (str.includes(needle)) leaks.push({ path, value: needle });
    }
  });
  return leaks;
}

/**
 * Assert that no identity value appears anywhere in an LLM-bound payload.
 * Throws with the offending path + value when confidentiality is breached —
 * the failure names exactly what leaked and where.
 */
export function assertNoIdentityOnWire(
  payload: unknown,
  identityValues: ReadonlyArray<string>,
): void {
  const leaks = findIdentityLeaks(payload, identityValues);
  if (leaks.length > 0) {
    const detail = leaks.map((l) => `  "${l.value}" at ${l.path}`).join('\n');
    throw new Error(
      '[privacy-shield-v4] on-the-wire confidentiality breach — ' +
        `${String(leaks.length)} identity value(s) reached the LLM:\n${detail}`,
    );
  }
}
