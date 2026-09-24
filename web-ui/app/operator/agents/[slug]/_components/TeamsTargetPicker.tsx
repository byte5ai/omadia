'use client';

import { useTranslations } from 'next-intl';

import {
  SearchableSelect,
  type SearchableOption,
} from '@/app/_components/ui/SearchableSelect';
import type {
  AgentTeamsTargetsDto,
  TeamsChatOptionDto,
  TeamsTargetListingDto,
  TeamsTeamOptionDto,
} from '@/app/_lib/agents';
import type { TeamsTargetKind } from '@/app/_lib/teamsInstallTarget';

/**
 * Pick an install target instead of typing one.
 *
 * WHY THIS EXISTS. The field underneath it is the one that produced migration
 * 0054's field test: an operator pasted a bare 32-hex id, which is a legal
 * reading of BOTH a team's group id and the stem of a chat id, and five
 * provisioning steps later Graph answered `404 No team found with Group Id`.
 * Since #950 nothing guesses any more — but the operator still had to produce
 * the string, and they had no better way to disambiguate it than the code did.
 *
 * A LIST DISSOLVES THE AMBIGUITY RATHER THAN REPORTING IT. Every id this
 * component can emit is either a hyphenated GUID or carries its `19:…@…`
 * suffix, so it classifies unambiguously the moment it lands in the field. The
 * input that broke the field test cannot be produced from here at all.
 *
 * IT WRITES INTO THE EXISTING FIELD, IT DOES NOT REPLACE IT. Selecting sets
 * the same `teamId` state the text input owns, so the free-text field stays
 * usable for the cases a list cannot cover.
 *
 * IT ALSO HANDS OVER THE KIND, AND THAT IS THE IMPORTANT PART. Every row here
 * came from Graph, which said what it was — `listTeams` returns teams,
 * `listChats` returns a `chatType` per chat. Emitting only the id threw that
 * away and left the field to re-derive the kind from the id's suffix, which is
 * how a legacy `19:…@thread.skype` group chat OFFERED BY THIS COMPONENT was
 * then rejected under it as "not a Teams install target". A pattern table can
 * only know the shapes it was written for; the listing knows the truth. So the
 * kind travels with the id, and the classification below stays what it was
 * built for — reading strings a human typed.
 *
 * EACH HALF IS SEARCHABLE, not a plain dropdown. The byte5 tenant alone
 * publishes thirty teams, and a chat with no topic renders as a `19:…` stem,
 * so an alphabetical list is a wall an operator scrolls rather than reads.
 * {@link SearchableSelect} carries the keyboard and screen-reader contract a
 * `<select>` used to provide for free; what is decided HERE is what the query
 * is allowed to match. It matches what a human SEES — a team's name, a chat's
 * topic — plus the member names that identify a topicless chat and the id
 * itself, so a pasted id lights up its own row instead of looking unknown.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DEGRADATION IS THE INTERESTING HALF
 * ─────────────────────────────────────────────────────────────────────────
 * Teams and chats are NOT symmetric and the component refuses to pretend they
 * are. `listTeams` is app-only and essentially always works. Chat enumeration
 * is delegated-only — Graph publishes no tenant-wide application route for
 * chats — and additionally needs `Chat.ReadBasic`, which a credential stored
 * before connector 0.8.0 does not carry and cannot obtain by refreshing.
 *
 * So each half renders from its own `available` flag, and an unavailable half
 * renders ONE SENTENCE saying why, never an empty dropdown. An empty
 * `<select>` is a claim about the tenant ("you have no chats"); it must not be
 * how "I could not look" looks. That distinction is the entire reason the DTO
 * is a union instead of an array.
 */

export interface TeamsTargetPickerProps {
  /** `null` while the directory is still loading, or when it failed to load
   *  at all — both render as "the field is all you have", quietly. */
  readonly targets: AgentTeamsTargetsDto | null;
  readonly loading: boolean;
  readonly disabled: boolean;
  /** The id currently in the text field, so a picked row can render as the
   *  selected one and a hand-typed id simply shows no selection. */
  readonly value: string;
  /** `kind` is the DIRECTORY's answer for this row, not a guess about it. */
  readonly onSelect: (id: string, kind: TeamsTargetKind) => void;
}

/** Label for one chat row: its topic, else its members, else its id. Never
 *  blank — a nameless chat is still a pickable one. */
function chatLabel(
  chat: TeamsChatOptionDto,
  fallbackMembers: (names: readonly string[]) => string,
): string {
  if (chat.topic !== null) return chat.topic;
  if (chat.memberNames !== undefined && chat.memberNames.length > 0) {
    return fallbackMembers(chat.memberNames);
  }
  return chat.id;
}

export function TeamsTargetPicker({
  targets,
  loading,
  disabled,
  value,
  onSelect,
}: TeamsTargetPickerProps): React.JSX.Element | null {
  const t = useTranslations('operatorAgents.teamsTargets');

  if (loading) {
    return (
      <p className="text-[11px] text-[color:var(--fg-muted)]">{t('loading')}</p>
    );
  }
  // No directory at all: say nothing and let the text field do its job. A
  // component that announced its own absence would be noise on every screen
  // whose connector predates the feature.
  if (targets === null) return null;

  const teams = targets.teams;
  const chats = targets.chats;

  return (
    <div className="flex flex-col gap-2">
      <TargetSelect
        label={t('teamsLabel')}
        emptyLabel={t('teamsEmpty')}
        placeholder={t('filter')}
        listing={teams}
        disabled={disabled}
        value={value}
        onSelect={onSelect}
        noMatchText={(query) => t('noMatch', { query })}
        matchCountText={(count) => t('matchCount', { count })}
        optionsOf={(items: readonly TeamsTeamOptionDto[]) =>
          items.map((team) => ({ id: team.id, label: team.displayName }))
        }
        kindOf={() => 'team'}
        // NO SCOPE ARGUMENT HERE, and that is the fix rather than an omission:
        // team enumeration is app-only, so the one sentence that names a scope
        // (`scope_missing`) can never be about `Chat.ReadBasic` on this half.
        // Passing it anyway printed the chat permission under the team list
        // and sent an operator to grant something unrelated. The teams copy
        // now names no scope at all, because the DTO does not carry which one
        // was missing and inventing a second guess would repeat the mistake.
        unavailableText={(reason) => t(`unavailable.teams.${reason}`)}
      />
      <TargetSelect
        label={t('chatsLabel')}
        emptyLabel={t('chatsEmpty')}
        placeholder={t('filter')}
        listing={chats}
        disabled={disabled}
        value={value}
        onSelect={onSelect}
        noMatchText={(query) => t('noMatch', { query })}
        matchCountText={(count) => t('matchCount', { count })}
        optionsOf={(items: readonly TeamsChatOptionDto[]) =>
          items.map((chat) => ({
            id: chat.id,
            label: `${chatLabel(chat, (names) => names.join(', '))} · ${t(
              `chatType.${chat.chatType}`,
            )}`,
            // Searchable but not repeated in the row: for a chat with no
            // topic the members ARE the name, and the label already falls
            // back to them — for one that HAS a topic they are still how an
            // operator looks for it.
            ...(chat.memberNames !== undefined && chat.memberNames.length > 0
              ? { keywords: chat.memberNames }
              : {}),
          }))
        }
        // Graph's own `chatType`, mapped to the kind the install endpoint
        // branches on. A meeting chat installs through /chats like a group
        // one, so only the 1:1 case is separated out.
        kindOf={(id) =>
          chats.available &&
          chats.items.find((chat) => chat.id === id)?.chatType === 'oneOnOne'
            ? 'one-on-one-chat'
            : 'group-chat'
        }
        unavailableText={(reason) =>
          t(`unavailable.chats.${reason}`, { scope: 'Chat.ReadBasic' })
        }
      />
    </div>
  );
}

interface TargetSelectProps<T> {
  readonly label: string;
  readonly emptyLabel: string;
  readonly placeholder: string;
  readonly listing: TeamsTargetListingDto<T>;
  readonly disabled: boolean;
  readonly value: string;
  readonly onSelect: (id: string, kind: TeamsTargetKind) => void;
  readonly optionsOf: (items: readonly T[]) => readonly SearchableOption[];
  /** The kind the listing reported for the row with this id. */
  readonly kindOf: (id: string) => TeamsTargetKind;
  readonly unavailableText: (reason: string) => string;
  readonly noMatchText: (query: string) => string;
  readonly matchCountText: (count: number) => string;
}

/**
 * One half of the picker.
 *
 * FOUR STATES, KEPT APART ON PURPOSE: a usable list, a tenant that genuinely
 * has none (`available` with no items — an explicit sentence, still no empty
 * dropdown), a listing that could not be produced (one sentence naming the
 * reason), and — inside {@link SearchableSelect} — a query that matched none
 * of a list that does exist. Collapsing any two of them is the bug this whole
 * shape exists to prevent: "I have nothing", "I could not look" and "nothing
 * you typed matches" are three different instructions to the operator.
 */
function TargetSelect<T>({
  label,
  emptyLabel,
  placeholder,
  listing,
  disabled,
  value,
  onSelect,
  optionsOf,
  kindOf,
  unavailableText,
  noMatchText,
  matchCountText,
}: TargetSelectProps<T>): React.JSX.Element {
  if (!listing.available) {
    return (
      <p
        role="note"
        className="text-[11px] text-[color:var(--fg-muted)]"
        data-testid={`target-unavailable-${label}`}
      >
        {unavailableText(listing.reason)}
      </p>
    );
  }
  const options = optionsOf(listing.items);
  if (options.length === 0) {
    return (
      <p className="text-[11px] text-[color:var(--fg-muted)]">{emptyLabel}</p>
    );
  }
  // `value` is passed through untouched, hand-typed ids included: the control
  // marks a matching row as selected and otherwise marks none. It must never
  // claim a choice the operator did not make.
  return (
    <SearchableSelect
      label={label}
      placeholder={placeholder}
      options={options}
      value={value}
      disabled={disabled}
      onSelect={(id) => onSelect(id, kindOf(id))}
      noMatchText={noMatchText}
      matchCountText={matchCountText}
    />
  );
}
