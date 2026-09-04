/**
 * What a Teams install target looks like — the browser-side half.
 *
 * MIRRORED, NOT IMPORTED. The authority is
 * `middleware/src/platform/teamsInstallTarget.ts`; the web-ui is a separate
 * npm project with no path into the middleware, exactly as the middleware
 * itself mirrors the connector contract rather than importing it. Keep the two
 * in step: the server re-decides every request, so a drift here can only ever
 * mislabel the field, never install into the wrong place.
 *
 * WHY THE BROWSER CLASSIFIES AT ALL. The operator who triggered this feature
 * pasted an id into a field labelled "Team-ID", got `400 teamId needs to be a
 * valid GUID`, and — after the id was hyphenated — `404 No team found with
 * Group Id` from the last step of a chain that had already created an Entra
 * app, an Azure bot and a catalog entry. Every one of those answers arrived
 * after the fact. Deciding the shape WHILE THEY TYPE turns all of it into a
 * label under the input, before anything is provisioned.
 */

/** A target an app can actually be installed into. */
export type TeamsTargetKind = 'team' | 'group-chat' | 'one-on-one-chat';

export type TeamsTargetClassification =
  | { readonly kind: TeamsTargetKind; readonly id: string }
  | { readonly kind: 'channel'; readonly id: string }
  | {
      readonly kind: 'ambiguous';
      readonly id: string;
      /** The input read as a team group id — one of the two ways out. */
      readonly asTeamId: string;
      /** The input read as a group-chat id — the other. */
      readonly asGroupChatId: string;
    }
  | { readonly kind: 'unrecognised'; readonly id: string }
  /** Nothing typed yet — not an error, just no verdict to show. */
  | { readonly kind: 'empty'; readonly id: '' };

const CHANNEL_SUFFIX = /@thread\.tacv2$/i;
const GROUP_CHAT_SUFFIX = /@thread\.v2$/i;
/** The pre-`v2` spelling of a group chat thread. Teams minted these before the
 *  split that gave channels `@thread.tacv2` and group chats `@thread.v2`, and
 *  the tenant chat listing still returns plenty of them. */
const LEGACY_GROUP_CHAT_SUFFIX = /@thread\.skype$/i;
const ONE_ON_ONE_SUFFIX = /@unq\.gbl\.spaces$/i;
const CONVERSATION_PREFIX = /^19:.+/;
const DASHED_GUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const BARE_GUID = /^[0-9a-fA-F]{32}$/;

/** Where the four dashes go in the canonical 8-4-4-4-12 GUID form. */
const GUID_SEGMENTS = [8, 12, 16, 20] as const;

function hyphenate(bare: string): string {
  const lower = bare.toLowerCase();
  let out = '';
  let cut = 0;
  for (const at of GUID_SEGMENTS) {
    out += `${lower.slice(cut, at)}-`;
    cut = at;
  }
  return out + lower.slice(cut);
}

/**
 * Read what the operator typed and say what it addresses — without guessing.
 *
 * Total and never throws: an unusable input is `'unrecognised'`, an empty one
 * is `'empty'`, and a 32-hex string is `'ambiguous'` WITH both readings
 * attached rather than silently resolved to either.
 */
export function classifyTeamsInstallTarget(value: string): TeamsTargetClassification {
  const id = value.trim();
  if (id === '') return { kind: 'empty', id: '' };

  if (CONVERSATION_PREFIX.test(id)) {
    if (CHANNEL_SUFFIX.test(id)) return { kind: 'channel', id };
    if (GROUP_CHAT_SUFFIX.test(id)) return { kind: 'group-chat', id };
    if (LEGACY_GROUP_CHAT_SUFFIX.test(id)) return { kind: 'group-chat', id };
    if (ONE_ON_ONE_SUFFIX.test(id)) return { kind: 'one-on-one-chat', id };
    // Teams has more conversation kinds than this handles, and installing
    // into the wrong one has a real audience — so an unknown suffix is
    // unrecognised, not "probably a chat".
    return { kind: 'unrecognised', id };
  }

  if (DASHED_GUID.test(id)) return { kind: 'team', id: id.toLowerCase() };

  if (BARE_GUID.test(id)) {
    return {
      kind: 'ambiguous',
      id,
      asTeamId: hyphenate(id),
      asGroupChatId: `19:${id.toLowerCase()}@thread.v2`,
    };
  }

  return { kind: 'unrecognised', id };
}

/**
 * A target the TENANT DIRECTORY named, rather than a string the operator typed.
 *
 * Mirrors `KnownTeamsInstallTarget` in the middleware, and exists for the same
 * reason: {@link classifyTeamsInstallTarget} reads strings of unknown
 * provenance, and an id that came out of the picker is not one of those. Graph
 * listed it AND said what it was. Feeding that id back through a suffix table
 * discards the better answer to re-derive a worse one — which is how a legacy
 * `19:…@thread.skype` group chat, offered by the picker itself, ended up
 * labelled "not a Teams install target" under the field.
 *
 * BOUND TO ITS ID ON PURPOSE. The claim names the exact string it was made
 * about, so editing the field invalidates it without any caller having to
 * remember to clear it. The UI can therefore never label a typed id with a
 * kind that belonged to a picked one.
 */
export interface KnownTeamsTarget {
  readonly id: string;
  readonly kind: TeamsTargetKind;
}

/**
 * The verdict to SHOW for what is currently in the field.
 *
 * Identical to {@link classifyTeamsInstallTarget} except when `known` still
 * describes this exact value — then the directory's answer stands, because it
 * came from Graph and the pattern table is only ever an approximation of it. A
 * `'channel'` reading is the one thing it cannot override: the directory never
 * lists channels, so such a claim cannot have come from one.
 */
export function classifyKnownTeamsTarget(
  value: string,
  known?: KnownTeamsTarget,
): TeamsTargetClassification {
  const classified = classifyTeamsInstallTarget(value);
  if (
    known !== undefined &&
    known.id === value.trim() &&
    classified.kind !== 'channel' &&
    classified.kind !== 'empty'
  ) {
    return { kind: known.kind, id: known.id };
  }
  return classified;
}

/** Can this input be submitted as-is? `false` for every verdict that needs the
 *  operator to change something first — which is what disables the button. */
export function isSubmittableTarget(
  classification: TeamsTargetClassification,
): boolean {
  return (
    classification.kind === 'team' ||
    classification.kind === 'group-chat' ||
    classification.kind === 'one-on-one-chat'
  );
}

/** One valid example per installable kind — shown in the field so an operator
 *  can see what a good answer looks like, not only that theirs was wrong. */
export const TEAMS_TARGET_EXAMPLES = {
  team: '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c',
  groupChat: '19:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@thread.v2',
  /** The same kind of thing, spelled the way Teams spelled it before the v2
   *  split. Shown because tenants still hold plenty of them — an operator who
   *  finds one in their own picker should recognise it in the help text. */
  legacyGroupChat: '19:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@thread.skype',
} as const;
