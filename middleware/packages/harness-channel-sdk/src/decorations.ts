/**
 * The decoration registry (spec 2042 §5.14, ADR-0021, #2086).
 *
 * A *decoration* is anything a channel adds above or below an agent's answer
 * that is not the answer itself: a status line, a chip, a footer, a reaction,
 * a button or a card. The chat is the primary UI and has to read like a
 * colleague's message, so every decoration is declared here once, with a
 * written justification and the channels that render it:
 *
 *  - `legal`: a legal requirement (the EU AI Act Art. 50 disclosure), or
 *  - `next_action`: a concrete, likely next action the user would otherwise
 *    have to type (confirm a decision, pick from options the agent proposed,
 *    answer a poll).
 *
 * A decoration that fits neither is not declared and therefore not rendered.
 * Channel plugins pass what they are about to attach through
 * {@link admitDecorations}; an undeclared id, or a channel the declaration
 * does not list, is refused (the element is dropped, the refusal is reported).
 * `decorations.test.ts` fails when a decoration id is used in the SDK without
 * an entry, so a new one cannot appear unnoticed.
 *
 * Everything else lives in the structured answer (`SemanticAnswer.details`)
 * and in on-demand details (spec §5.14 table), or in the agent's own words.
 */

/** What kind of element the decoration is. */
export type DecorationKind =
  | 'status_line'
  | 'chip'
  | 'footer'
  | 'reaction'
  | 'button'
  | 'card'
  | 'details';

/** Why the decoration may exist. */
export type DecorationJustification =
  | {
      readonly kind: 'legal';
      /** The legal basis, citable. */
      readonly basis: string;
    }
  | {
      readonly kind: 'next_action';
      /** The concrete, likely next action and what typing it would cost. */
      readonly action: string;
    };

export interface DecorationDeclaration {
  /** Stable id channels use when they attach the decoration. */
  readonly id: string;
  readonly kind: DecorationKind;
  /** One sentence: what the element shows or does. */
  readonly purpose: string;
  readonly justification: DecorationJustification;
  /**
   * Channel types (`ChannelPlugin.type`, e.g. `teams`, `slack`, `web`) that
   * render the decoration. `'*'` means every channel. Channels not listed
   * render nothing for it; the content has a plain-text path (channel parity).
   */
  readonly channels: readonly string[] | '*';
  /**
   * The operator setting that governs the decoration, when there is one
   * (for example the AI disclosure frequency, #2087). Documentation only.
   */
  readonly operatorSetting?: string;
}

const DECLARATIONS: readonly DecorationDeclaration[] = [
  {
    id: 'ai_disclosure_line',
    kind: 'status_line',
    purpose: 'The text line that tells people the answer comes from an AI system.',
    justification: { kind: 'legal', basis: 'EU AI Act Art. 50 (transparency towards people interacting with an AI system)' },
    channels: '*',
    operatorSetting: 'ai_disclosure_frequency',
  },
  {
    id: 'ai_disclosure_chip',
    kind: 'chip',
    purpose: "The channel's own discreet AI marker (Teams card chip, activity-level AI label).",
    justification: { kind: 'legal', basis: 'EU AI Act Art. 50 (transparency towards people interacting with an AI system)' },
    channels: ['teams'],
    operatorSetting: 'ai_disclosure_frequency',
  },
  {
    id: 'decision_card',
    kind: 'card',
    purpose: 'Buttons for a choice, slot or topic the agent asks the user to pick (OutgoingInteractive).',
    justification: {
      kind: 'next_action',
      action: 'Pick one of the 2-4 options the agent just asked about; a tap replaces typing the option.',
    },
    channels: ['teams', 'web'],
  },
  {
    id: 'facilitation_poll',
    kind: 'card',
    purpose: 'A poll or vote card a facilitator posts into the conversation.',
    justification: {
      kind: 'next_action',
      action: 'Cast a vote on the option the facilitation asks about; a tap replaces typing the answer.',
    },
    channels: ['teams'],
  },
  {
    id: 'follow_up_options',
    kind: 'button',
    purpose: 'Buttons for next steps the agent itself proposed as concrete options.',
    justification: {
      kind: 'next_action',
      action: 'Choose one of the next steps the agent offered; shown only when the agent proposed options it expects the user to pick.',
    },
    channels: ['teams', 'web'],
  },
  {
    id: 'consent_card',
    kind: 'card',
    purpose: 'The sign-in / consent card for an external integration the turn needs.',
    justification: {
      kind: 'next_action',
      action: 'Grant the missing scopes in one click instead of leaving the chat for an admin page.',
    },
    channels: ['teams', 'web'],
  },
  {
    id: 'mcp_input_form',
    kind: 'card',
    purpose: 'The input form a connected tool server asks the user to fill.',
    justification: {
      kind: 'next_action',
      action: 'Fill the fields the tool is blocked on; the plain-text prompt stays available.',
    },
    channels: ['teams', 'web'],
  },
  {
    id: 'routine_list',
    kind: 'card',
    purpose: 'Pause / resume actions on the routines an agent just listed.',
    justification: {
      kind: 'next_action',
      action: 'Pause or resume a routine the user just asked to see; a tap replaces typing the command.',
    },
    channels: ['teams', 'web'],
  },
  {
    id: 'answer_details',
    kind: 'details',
    purpose:
      'A collapsed details element with the speaker, verification, system-data provenance, consulted agents, mode and privacy receipt.',
    justification: {
      kind: 'next_action',
      action: 'Open the transparency details on demand; asking "how do you know?" in words stays possible everywhere.',
    },
    channels: ['teams', 'web'],
  },
];

/** The registry, frozen. Order is the order of the table in the spec. */
export const DECORATION_REGISTRY: readonly DecorationDeclaration[] = Object.freeze(
  DECLARATIONS.map((d) => Object.freeze({ ...d })),
);

/**
 * Elements that existed before the registry and are deliberately NOT declared
 * (spec §5.14 table): they have no legal basis and no next action to save, so
 * their purpose moved into structured fields and details. Kept as data so a
 * channel test can assert none of them is rendered any more.
 */
export const REMOVED_DECORATIONS = Object.freeze([
  'verifier_badge',
  'system_data_chip',
  'consulted_footer',
  'direct_answer_chip',
  'verbosity_buttons',
  'direct_line_buttons',
  'receipt_reaction',
  'disclaimer_line',
] as const);

export type RemovedDecorationId = (typeof REMOVED_DECORATIONS)[number];

export type DecorationId = string;

const BY_ID: ReadonlyMap<string, DecorationDeclaration> = new Map(
  DECORATION_REGISTRY.map((d) => [d.id, d]),
);

export function getDecoration(id: string): DecorationDeclaration | undefined {
  return BY_ID.get(id);
}

/** True when `id` is declared and `channel` renders it. */
export function isDecorationAllowed(id: string, channel: string): boolean {
  const declaration = BY_ID.get(id);
  if (!declaration) return false;
  return declaration.channels === '*' || declaration.channels.includes(channel);
}

/** The declarations a channel may render. */
export function decorationsFor(channel: string): readonly DecorationDeclaration[] {
  return DECORATION_REGISTRY.filter((d) => d.channels === '*' || d.channels.includes(channel));
}

export type DecorationRefusalReason = 'undeclared' | 'removed' | 'channel_not_declared';

export interface DecorationRefusal {
  readonly id: string;
  readonly reason: DecorationRefusalReason;
}

export interface AdmittedDecorations<T extends { readonly id: string }> {
  /** The decorations that may reach the user. */
  readonly admitted: readonly T[];
  /** The ones the SDK refused; report these, never render them. */
  readonly refused: readonly DecorationRefusal[];
}

/**
 * The channel SDK's gate: keep only decorations that are declared and that the
 * channel is declared to render. Fail-closed, an unknown id is dropped.
 * `onRefused` lets the channel log or count refusals.
 */
export function admitDecorations<T extends { readonly id: string }>(
  channel: string,
  decorations: readonly T[],
  onRefused?: (refusal: DecorationRefusal) => void,
): AdmittedDecorations<T> {
  const admitted: T[] = [];
  const refused: DecorationRefusal[] = [];
  for (const decoration of decorations) {
    const declaration = BY_ID.get(decoration.id);
    let reason: DecorationRefusalReason | undefined;
    if (!declaration) {
      reason = (REMOVED_DECORATIONS as readonly string[]).includes(decoration.id)
        ? 'removed'
        : 'undeclared';
    } else if (declaration.channels !== '*' && !declaration.channels.includes(channel)) {
      reason = 'channel_not_declared';
    }
    if (reason) {
      const refusal: DecorationRefusal = { id: decoration.id, reason };
      refused.push(refusal);
      onRefused?.(refusal);
      continue;
    }
    admitted.push(decoration);
  }
  return { admitted, refused };
}
