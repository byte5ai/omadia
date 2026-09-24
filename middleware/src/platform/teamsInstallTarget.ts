/**
 * What an agent's Teams app can be installed INTO — the one place that reads
 * an operator's pasted string and decides what it addresses.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * An operator pasted `abc8af8ec7fc471785d3b83c4d84b667` into a field labelled
 * "Team-ID". The chain answered `400 teamId needs to be a valid GUID`; after
 * {@link normalizeTeamsTeamId} hyphenated it, Graph answered `404 No team
 * found with Group Id`. All 30 teams of the tenant and their channels were
 * then searched by hand and the id was NEITHER — it was, with high
 * probability, the stem of a group-chat id.
 *
 * The operator had wanted the right thing from the beginning. The chain
 * simply had no word for it: `team_id` was the only target the whole stack
 * could express, so a group chat could not be asked for, could not be
 * validated, and could only fail five steps late with a message about GUIDs.
 *
 * This module gives the stack that word. `teamsTeamId.ts` next door still owns
 * the narrow question "how do I spell a team id so Graph accepts it"; this one
 * owns the wider question "what KIND of thing is this, and can we install into
 * it at all".
 *
 * THE SHAPES, AND WHY THE LAST TWO ARE NOT INSTALL TARGETS
 * -------------------------------------------------------
 *   `<guid>`                  team          → POST /teams/{id}/installedApps
 *   `19:…@thread.v2`          group chat    → POST /chats/{id}/installedApps
 *   `19:…@thread.skype`       group chat    → POST /chats/{id}/installedApps
 *   `19:…@unq.gbl.spaces`     1:1 chat      → POST /chats/{id}/installedApps
 *   `19:…@thread.tacv2`       CHANNEL       → refused, with the fix named
 *   32 bare hex               ambiguous     → see the concession below
 *
 * A channel is refused rather than silently redirected to its parent team.
 * Installing into the team would succeed and the app would appear in EVERY
 * channel of it — a wider blast radius than the operator asked for, produced
 * by a guess. So it is named as the mistake it is and the team id is pointed
 * at instead.
 *
 * `@thread.skype` IS THE OLD SPELLING OF A GROUP CHAT
 * --------------------------------------------------
 * Teams threads minted before the `v2` split all end `@thread.skype`; the
 * split later gave channels `@thread.tacv2` and group chats `@thread.v2`, and
 * older conversations kept the original suffix. The tenant chat listing
 * (`GET /me/chats`, behind the target picker) returns them with
 * `chatType: 'group'` and a member roster — Graph itself calling them chats —
 * and this module used to answer `'unrecognised'` for exactly those ids. The
 * picker offered a chat the field then refused.
 *
 * A legacy CHANNEL id wears the same suffix, and no part of the string
 * separates the two. This reads it as a chat, because the two mistakes do not
 * cost the same: a channel id sent to `/chats/{id}` buys one refused Graph
 * call, while refusing the suffix blocks a chat the operator picked from a
 * list we produced. The `@thread.tacv2` channel refusal above is unaffected —
 * that shape is unambiguous, which is why it can still be refused on sight.
 *
 * THE ONE CONCESSION: BARE 32-HEX
 * -------------------------------
 * A bare 32-hex string is genuinely ambiguous — it is both the unhyphenated
 * form of a team's group id AND the stem of `19:<32hex>@thread.v2`. The field
 * test above is exactly that collision.
 *
 * {@link classifyTeamsInstallTarget} therefore refuses to pick: it answers
 * `'ambiguous'` and hands back BOTH readings.
 *
 * {@link resolveTeamsInstallTarget} — the decision the route and the runner
 * need — resolves it to a TEAM, and says so by setting `ambiguous: true`.
 * That is not a shrug. `normalizeTeamsTeamId` was written because Teams itself
 * prints a team's group id unhyphenated in the "get link to team" deep link,
 * and refusing that form here would re-break the paste it exists to accept.
 * The missing information is CONTEXT — the deep link has it, a bare string
 * does not — and context lives with the human. So the ambiguity is surfaced in
 * the UI, before the operator submits, where they can still supply it; the API
 * keeps behaving the way the shipped fix made it behave.
 */

import { normalizeTeamsTeamId } from './teamsTeamId.js';

/** A target an app can actually be installed into. */
export type TeamsTargetKind = 'team' | 'group-chat' | 'one-on-one-chat';

/** Every verdict {@link classifyTeamsInstallTarget} can reach. */
export type TeamsTargetClassificationKind =
  | TeamsTargetKind
  | 'channel'
  | 'ambiguous'
  | 'unrecognised';

interface ClassificationBase {
  /** The input, trimmed and canonicalised for its kind. */
  readonly id: string;
}

export type TeamsTargetClassification =
  | (ClassificationBase & { readonly kind: TeamsTargetKind })
  | (ClassificationBase & { readonly kind: 'channel' })
  | (ClassificationBase & {
      readonly kind: 'ambiguous';
      /** The input read as a team group id (hyphenated). */
      readonly asTeamId: string;
      /** The input read as the stem of a group-chat thread id. */
      readonly asGroupChatId: string;
    })
  | (ClassificationBase & { readonly kind: 'unrecognised' });

/**
 * Conversation-id suffixes, as Teams spells them. Matched case-insensitively
 * because the casing varies between the client, the Graph payloads and the
 * places an operator copies from, and none of that variation is meaningful.
 *
 * `thread.tacv2` MUST be tested before `thread.v2` would ever be considered —
 * they are distinct suffixes, not a prefix pair, but keeping the channel test
 * first makes the precedence impossible to get wrong by accident later.
 */
const CHANNEL_SUFFIX = /@thread\.tacv2$/i;
const GROUP_CHAT_SUFFIX = /@thread\.v2$/i;
/** The pre-`v2` spelling of {@link GROUP_CHAT_SUFFIX} — see the header. */
const LEGACY_GROUP_CHAT_SUFFIX = /@thread\.skype$/i;
const ONE_ON_ONE_SUFFIX = /@unq\.gbl\.spaces$/i;

/** Every conversation id Teams hands out starts with the `19:` prefix. */
const CONVERSATION_PREFIX = /^19:.+/;

/** A hyphenated GUID in the canonical 8-4-4-4-12 form. */
const DASHED_GUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** An unhyphenated GUID — 32 hex digits and nothing else. */
const BARE_GUID = /^[0-9a-fA-F]{32}$/;

/**
 * One valid example per installable kind. Rendered in the operator UI so the
 * field shows what a good answer LOOKS like instead of only saying that the
 * last one was wrong — the cheapest fix for a field nobody can guess the
 * format of. Exported from here so the examples cannot drift away from the
 * patterns that accept them; the suite asserts each one classifies back.
 */
export const TEAMS_TARGET_EXAMPLES = {
  team: '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c',
  groupChat: '19:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@thread.v2',
  /** The same thing, spelled the way Teams spelled it before the v2 split —
   *  listed because tenants still hold plenty of them, not as an alternative
   *  an operator would ever choose. */
  legacyGroupChat: '19:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@thread.skype',
  oneOnOneChat: '19:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d_00000000-0000-0000-0000-000000000000@unq.gbl.spaces',
} as const;

/**
 * Read a pasted string and say what it addresses — WITHOUT guessing.
 *
 * Never throws and never rejects: an unusable input comes back as
 * `'unrecognised'`, which callers turn into their own actionable message.
 */
export function classifyTeamsInstallTarget(value: string): TeamsTargetClassification {
  const id = value.trim();
  if (id === '') return { kind: 'unrecognised', id };

  if (CONVERSATION_PREFIX.test(id)) {
    if (CHANNEL_SUFFIX.test(id)) return { kind: 'channel', id };
    if (GROUP_CHAT_SUFFIX.test(id)) return { kind: 'group-chat', id };
    if (LEGACY_GROUP_CHAT_SUFFIX.test(id)) return { kind: 'group-chat', id };
    if (ONE_ON_ONE_SUFFIX.test(id)) return { kind: 'one-on-one-chat', id };
    // A `19:` id with a suffix we do not know is NOT quietly treated as a
    // chat: Teams has more conversation kinds than this module handles, and
    // installing into the wrong one is a real action with a real audience.
    return { kind: 'unrecognised', id };
  }

  // Lowercased so the same team never appears under two spellings in the
  // binding table — the primary key is the id, and `A1B2…` and `a1b2…` would
  // otherwise be two rows for one team.
  if (DASHED_GUID.test(id)) return { kind: 'team', id: id.toLowerCase() };

  if (BARE_GUID.test(id)) {
    return {
      kind: 'ambiguous',
      id,
      asTeamId: normalizeTeamsTeamId(id),
      asGroupChatId: `19:${id.toLowerCase()}@thread.v2`,
    };
  }

  return { kind: 'unrecognised', id };
}

/** Why {@link resolveTeamsInstallTarget} refused. */
export type TeamsTargetRejection = 'channel' | 'ambiguous' | 'unrecognised';

/**
 * A target the TENANT DIRECTORY named, rather than a string a human typed.
 *
 * WHY THIS TYPE EXISTS — AND WHY IT IS NOT AN OPTIMISATION.
 * {@link classifyTeamsInstallTarget} exists to read strings whose provenance
 * is unknown, which is why it has an `'ambiguous'` verdict at all: guessing
 * about a hand-typed id is the failure this module was written after.
 *
 * An id that came out of `listTeams` / `listChats` is not that kind of string.
 * Graph produced it AND said what it was — a team, a group chat, a 1:1 chat.
 * Running it back through a suffix table throws that answer away and re-derives
 * a worse one, and the `@thread.skype` regression is what that costs: the
 * picker offered a chat Graph had just classified, and the pattern list, which
 * had never heard of the suffix, called it unusable. Every id shape Microsoft
 * adds next breaks us the same way, at the exact moment the operator did
 * everything right.
 *
 * SELF-INVALIDATING BY CONSTRUCTION. The known kind is bound to the exact id
 * it was known for. {@link resolveTeamsInstallTarget} honours it only while
 * `id` still equals the value being resolved, so editing the field puts the
 * kind back up for classification without anyone having to remember to clear
 * it. A stale claim cannot outlive the string it was a claim about.
 */
export interface KnownTeamsInstallTarget {
  /** The id the directory reported — the claim is void for any other value. */
  readonly id: string;
  readonly kind: TeamsTargetKind;
}

export type ResolvedTeamsInstallTarget =
  | {
      readonly ok: true;
      readonly kind: TeamsTargetKind;
      /** The id in the form the Graph call for {@link kind} expects. */
      readonly id: string;
    }
  | { readonly ok: false; readonly reason: 'channel' | 'unrecognised' }
  | {
      readonly ok: false;
      readonly reason: 'ambiguous';
      /** The input read as a team group id — one of the two ways out. */
      readonly asTeamId: string;
      /** The input read as a group-chat id — the other. */
      readonly asGroupChatId: string;
    };

/**
 * The decision the route and the job runner need: install into WHAT, or refuse
 * with a reason a human can act on.
 *
 * AMBIGUITY IS REFUSED, NOT RESOLVED. A bare 32-hex string is both the
 * unhyphenated form of a team's group id and the stem of
 * `19:<32hex>@thread.v2`, and picking one silently is precisely what produced
 * the field-test failure: the chain hyphenated a chat stem into a team GUID
 * and spent five provisioning steps before Graph said `404 No team found with
 * Group Id`. Guessing is cheap for us and expensive for the operator.
 *
 * The connector agrees: `installToChat` rejects a bare stem and requires the
 * full `19:<hex>@thread.v2` form, so a middleware that guessed "chat" would
 * only move the refusal one hop later.
 *
 * So the refusal carries BOTH readings, and the caller asks the one party who
 * actually knows which was meant.
 *
 * `known` SHORT-CIRCUITS THE GUESSING, AND ONLY THE GUESSING. When the caller
 * can say where the id came from — {@link KnownTeamsInstallTarget}, i.e. the
 * tenant directory — that answer is better than anything a suffix table can
 * derive, and it is used. Two limits keep it honest:
 *
 *   1. The claim is bound to its id (see the type). Any other value ignores it.
 *   2. A `'channel'` classification still wins. That is the one shape whose
 *      misreading has a WIDER audience than the operator asked for, and the
 *      directory never lists channels — so a claim over a `@thread.tacv2` id
 *      cannot have come from a listing and is not treated as though it had.
 *
 * Everything else the claim may override, because the only thing `kind`
 * decides downstream is `/teams/{id}` versus `/chats/{id}` — two tenant-scoped
 * endpoints Graph re-authorises on its own. A wrong kind buys a refused call,
 * never a wider install.
 */
export function resolveTeamsInstallTarget(
  value: string,
  known?: KnownTeamsInstallTarget,
): ResolvedTeamsInstallTarget {
  const classified = classifyTeamsInstallTarget(value);

  if (known !== undefined && known.id === value.trim() && classified.kind !== 'channel') {
    return { ok: true, kind: known.kind, id: known.id };
  }

  switch (classified.kind) {
    case 'team':
    case 'group-chat':
    case 'one-on-one-chat':
      return { ok: true, kind: classified.kind, id: classified.id };
    case 'ambiguous':
      return {
        ok: false,
        reason: 'ambiguous',
        asTeamId: classified.asTeamId,
        asGroupChatId: classified.asGroupChatId,
      };
    case 'channel':
      return { ok: false, reason: 'channel' };
    default:
      return { ok: false, reason: 'unrecognised' };
  }
}

/**
 * Does this kind install through `POST /chats/{id}/installedApps` rather than
 * `POST /teams/{id}/installedApps`? The single predicate the runner branches
 * on, so "which Graph endpoint" is decided once rather than at each call site.
 */
export function isChatTarget(kind: TeamsTargetKind): boolean {
  return kind === 'group-chat' || kind === 'one-on-one-chat';
}
