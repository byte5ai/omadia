// Question cards (#2089, epic #2043): a structured question an agent posts
// into a conversation, answered with typed values instead of a chat ballot.
//
// One shape for the three parties: the engine plugin sends a `QuestionCard`
// through 'conversationSend' / 'targetedSend', the channel plugin renders it
// with whatever its platform offers (Teams: an Adaptive Card) and emits each
// submission as a `card_answer` message event with `CardAnswerValue`s, and
// the kernel validates the card on the way out and the answer on the way in.
// `@omadia/channel-sdk` re-exports these types; they are defined once, here.
//
// A poll (`SendPoll`) keeps working unchanged. A card is the richer form for
// a channel that DECLARES it (`CardSupport`); a card sent to a channel that
// does not, or with a question kind it does not list, is refused with
// 'channel_error' and nothing is posted, so the sender falls back to a chat
// ballot.

export const CARD_QUESTION_KINDS = [
  'single_choice',
  'multiple_choice',
  'ranking',
  'consent',
  'assignment',
  'text',
  'number',
  'date',
] as const;
export type CardQuestionKind = (typeof CARD_QUESTION_KINDS)[number];

/**
 * Ids of cards, questions and options: 1..64 characters of `A-Z a-z 0-9 _ -`.
 * Deliberately narrow: a channel builds its input ids from them
 * (`<questionId>.rank1`) and gets several chosen options back as one
 * comma-separated string, so neither `.` nor `,` may occur in an id.
 */
export const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface CardOption {
  /** See {@link CARD_ID_PATTERN}; unique within its question. */
  id: string;
  label: string;
}

interface CardQuestionBase {
  /** See {@link CARD_ID_PATTERN}; unique within the card. */
  id: string;
  label: string;
  help?: string;
  /** Default `true`. */
  required?: boolean;
}

export type CardQuestion = CardQuestionBase &
  (
    | { kind: 'single_choice'; options: readonly CardOption[] }
    | { kind: 'multiple_choice'; options: readonly CardOption[]; min?: number; max?: number }
    | {
        kind: 'ranking';
        options: readonly CardOption[];
        /** Rank only the top n; absent = every option. */
        ranks?: number;
        /** One label per rank ("1st place (3 points)"). */
        rankLabels?: readonly string[];
      }
    | { kind: 'consent'; agreeLabel?: string; objectLabel?: string; reasonRequiredOnObject?: boolean }
    | {
        kind: 'assignment';
        /** The members of the conversation the card is in, or a fixed list
         *  whose option ids are channel user ids. */
        candidates: 'conversation_members' | readonly CardOption[];
        allowVolunteer?: boolean;
      }
    | { kind: 'text'; multiline?: boolean; maxLength?: number; mode?: 'replace' | 'append' }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'date' }
  );

export interface QuestionCard {
  /** See {@link CARD_ID_PATTERN}; comes back as `cardAnswer.cardId`. */
  cardId: string;
  /** What is being answered. An answer to another version never counts; the
   *  receiver of the answer checks that, not the channel. */
  proposalId?: string;
  proposalVersion?: number;
  title: string;
  intro?: string;
  /** At least one, at most what the channel declares (`CardSupport.maxQuestions`). */
  questions: readonly CardQuestion[];
  /** ISO 8601. Shown on the card; the channel refuses later submissions. */
  closesAt?: string;
  /** Whether a person may change the answer until the close. Default `true`. */
  changeable?: boolean;
  /** BCP 47, for the channel's own labels ("Send answer", "Change"). */
  locale?: string;
}

/** What a channel declares about question cards. */
export interface CardSupport {
  kinds: readonly CardQuestionKind[];
  maxQuestions: number;
  /** The channel can update a posted card (`updateCard`). */
  update: boolean;
  /** 1.88.0 — the channel shows no native cards: the kernel posts a card as
   *  numbered text and a typed reply comes back as its answer (#2086). A
   *  sender that explains how to answer says "reply in the chat", not "use
   *  the card". Absent on older kernels: read it as `false`. */
  asText?: boolean;
}

/** One answered question of a submission. */
export type CardAnswerValue = { questionId: string } & (
  | { kind: 'single_choice'; optionId: string }
  | { kind: 'multiple_choice'; optionIds: readonly string[] }
  /** Option ids, best first. */
  | { kind: 'ranking'; ranking: readonly string[] }
  | { kind: 'consent'; decision: 'agree' | 'object'; reason?: string }
  | { kind: 'assignment'; assignee: 'self' | { kind: string; id: string; displayName?: string } }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number }
  /** ISO 8601 date (`YYYY-MM-DD`). */
  | { kind: 'date'; value: string }
);

/** What a posted card becomes. */
export type CardUpdate =
  /** The step is over: the card shows the result and no inputs. The sender
   *  supplies the result text; a channel never computes one. */
  | { state: 'closed'; title: string; resultLines: readonly string[]; closedAt: string }
  /** A corrected card, same `cardId`, still open. */
  | { state: 'open'; card: QuestionCard };

export type CardUpdateOutcome =
  | { outcome: 'updated' }
  | { outcome: 'unreachable'; code: string; message: string };
