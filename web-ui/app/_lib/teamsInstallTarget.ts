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
} as const;
