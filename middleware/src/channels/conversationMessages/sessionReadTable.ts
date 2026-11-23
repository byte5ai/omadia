// #2076 / #2089 (spec 2043 §5.3) — the session-state table of a linked
// session conversation, as far as reading goes. Delivery, reading and
// sending follow the same table; sending is enforced by the execution
// authorization, reading here.
//
//   scheduled   messages addressed to the facilitator   -> 'addressed'
//   live        every human message                     -> 'all'
//   confirming  every human message                     -> 'all'
//   closed      nothing (the reservation is released)   -> 'none'
//   cancelled   nothing (the reservation is released)   -> 'none'

import type { ConversationMessageMode, SessionConversationState } from '@omadia/plugin-api';

/** What a session conversation is read for in its state, released or not. */
export interface SessionRead {
  readonly state: SessionConversationState;
  readonly released: boolean;
}

const RANK: Readonly<Record<ConversationMessageMode, number>> = { none: 0, addressed: 1, all: 2 };

/** The most a process reads of a session conversation in this state. */
export function sessionReadMode(session: SessionRead): ConversationMessageMode {
  if (session.released) return 'none';
  switch (session.state) {
    case 'scheduled':
      return 'addressed';
    case 'live':
    case 'confirming':
      return 'all';
    default:
      return 'none';
  }
}

/** Does the session's state allow reading in `mode`? */
export function sessionAllows(session: SessionRead, mode: ConversationMessageMode): boolean {
  return RANK[mode] <= RANK[sessionReadMode(session)];
}
