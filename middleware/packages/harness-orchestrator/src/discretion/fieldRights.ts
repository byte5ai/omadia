/**
 * Spec 2042 §5.11 "mask at entry" and §6 criteria 3c / 18: field rights per
 * audience member.
 *
 * The privacy shield masks classified fields before the model sees them and
 * restores them for the person who asked. In a room with several readers that
 * restoration reaches everyone present, so it may only happen when EVERY
 * member holds the right to the field's classification. The right is an
 * ordinary audience-floor capability (`privacy:field:<class>`): allowances
 * intersect across the room, a prohibition by anyone binds it. The member
 * baseline grants `privacy:field:personal` to every resolved person, so an
 * operator withdraws it with a denial for a person or role (or runs the strict
 * reading `AUDIENCE_BASELINE_GRANTS=none`, where only explicit grants count).
 *
 * Where a room lacks the right:
 *  - no operator bypass applies: the model gets the masked digest (entry);
 *  - prompt surrogates are not restored in the answer;
 *  - values a `v4_render_answer` materialized from masked columns are
 *    replaced by the mask placeholder;
 *  - an answer whose label set carries the classification is refused at the
 *    `people` egress (flow rule).
 *
 * Every unclear case fails closed: a closed floor or a floor that throws
 * grants no class. Only a turn without an audience provider (the floor
 * switched off by the operator, `AUDIENCE_FLOOR_ENABLED=false`) is not
 * enforced, the same "not enforced ≠ closed" rule the other floor guards
 * follow.
 */

import { floorPermits, type AudienceFloor, type Capability } from '@omadia/channel-sdk';

import type { AudienceFloorProvider } from '../audienceFloorGuard.js';
import { turnContext } from '../turnContext.js';
import { seededDiscretionFor, type SeededTurnDiscretion } from './seededTurn.js';

/** The classification the shield masks today: personal data. */
export const PERSONAL_FIELD_CLASS = 'personal';

/** Every classification the kernel knows a right for. */
export const KNOWN_FIELD_CLASSES: readonly string[] = Object.freeze([PERSONAL_FIELD_CLASS]);

/** The audience-floor capability for knowing fields of classification `cls`. */
export function fieldCapability(cls: string): Capability {
  return `privacy:field:${cls}`;
}

/**
 * Which classifications every reader of a room may know:
 * - `any`: not enforced (no audience floor on this turn);
 * - `only`: exactly these classes (possibly none).
 */
export type FieldClassAllowance =
  | { readonly kind: 'any' }
  | { readonly kind: 'only'; readonly classes: ReadonlySet<string> };

export const ANY_FIELD_CLASS: FieldClassAllowance = Object.freeze({ kind: 'any' });
export const NO_FIELD_CLASS: FieldClassAllowance = Object.freeze({
  kind: 'only',
  classes: new Set<string>(),
});

/** May a reader under `allowance` know fields of class `cls`? */
export function allowsFieldClass(allowance: FieldClassAllowance | undefined, cls: string): boolean {
  if (!allowance) return false;
  return allowance.kind === 'any' || allowance.classes.has(cls);
}

function allowanceFromFloor(floor: AudienceFloor): FieldClassAllowance {
  return {
    kind: 'only',
    classes: new Set(KNOWN_FIELD_CLASSES.filter((cls) => floorPermits(floor, fieldCapability(cls)))),
  };
}

/**
 * The classes every member of the room behind `provider` may know. No
 * provider: `any`. A provider that throws: none (fail closed).
 */
export async function fieldClassesOf(
  provider: AudienceFloorProvider | undefined,
): Promise<FieldClassAllowance> {
  if (!provider) return ANY_FIELD_CLASS;
  try {
    return allowanceFromFloor(await provider());
  } catch {
    return NO_FIELD_CLASS;
  }
}

/** The allowance a list of classes stands for (stored with a trigger). */
export function fieldClassesFromList(classes: readonly string[] | undefined): FieldClassAllowance {
  return { kind: 'only', classes: new Set(classes ?? []) };
}

/** An allowance as the list stored with a trigger: `any` = every known class. */
export function fieldClassList(allowance: FieldClassAllowance): string[] {
  return allowance.kind === 'any'
    ? [...KNOWN_FIELD_CLASSES]
    : KNOWN_FIELD_CLASSES.filter((cls) => allowance.classes.has(cls));
}

/**
 * The field rights of a turn: its audience floor when it has one, else the
 * rights stored with the trigger whose firing it is (a firing has no room of
 * its own, it posts into the creating conversation), else not enforced.
 */
export function fieldClassesForTurn(
  floor: AudienceFloorProvider | undefined,
  seed: SeededTurnDiscretion | undefined,
): Promise<FieldClassAllowance> {
  if (!floor && seed) return Promise.resolve(fieldClassesFromList(seed.fieldClasses));
  return fieldClassesOf(floor);
}

/** {@link fieldClassesForTurn} for the active turn. */
export function currentFieldClasses(): Promise<FieldClassAllowance> {
  const ctx = turnContext.current();
  const seed = ctx?.agentSlug !== undefined ? seededDiscretionFor(ctx.agentSlug) : undefined;
  return fieldClassesForTurn(ctx?.audienceFloor, seed);
}

/**
 * True when someone in the active turn's room may not know personal fields:
 * nothing masked may then be restored, rendered or bypassed for this room.
 * Re-evaluated per call (a mid-turn joiner narrows it before the next call).
 */
export async function personalFieldsWithheld(): Promise<boolean> {
  return !allowsFieldClass(await currentFieldClasses(), PERSONAL_FIELD_CLASS);
}
