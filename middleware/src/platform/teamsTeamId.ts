/**
 * Teams team (group) ids, in the shape Microsoft Graph insists on
 * (byte5ai/omadia#860).
 *
 * Teams shows a team's group id WITHOUT dashes in several places an operator
 * naturally copies from — the "get link to team" deep link
 * (`groupId=abc8af8ec7fc471785d3b83c4d84b667`), parts of the admin centre, and
 * the Graph responses that echo a deep link back. Graph's own
 * `/teams/{id}/installedApps` endpoint then rejects exactly that string with
 * `BadRequest: teamId needs to be a valid GUID.` — a 400 that arrives at the
 * LAST step of provisioning, after the Entra app, the Azure bot and the
 * catalog upload have all succeeded.
 *
 * So the operator pastes something Teams itself gave them, and the chain dies
 * at step five with a message about GUID validity. Normalising it here costs
 * one regex and removes a class of failure nobody can be expected to diagnose.
 *
 * DELIBERATELY NARROW. Only the unhyphenated 32-hex form is rewritten;
 * everything else is passed through untouched, including strings that are not
 * group ids at all. A team can also be addressed by identifiers this module
 * has no business reshaping (`19:...@thread.tacv2` and friends), and a
 * validator that guessed at those would reject working input to fix a typo it
 * was never asked about. Trimming is the only other liberty taken, because a
 * trailing space from a copy-paste is never meaningful.
 */

/** An unhyphenated GUID: exactly 32 hex digits and nothing else. */
const BARE_GUID = /^[0-9a-fA-F]{32}$/;

/** Where the four dashes go in the canonical 8-4-4-4-12 form. */
const GUID_SEGMENTS = [8, 12, 16, 20] as const;

/**
 * Return `value` in the form Graph accepts.
 *
 * A 32-hex string becomes its dashed, lowercase GUID form. Anything else —
 * an already-dashed GUID, a thread id, a value this module does not recognise
 * — is returned trimmed and otherwise unchanged.
 */
export function normalizeTeamsTeamId(value: string): string {
  const trimmed = value.trim();
  if (!BARE_GUID.test(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  let out = '';
  let cut = 0;
  for (const at of GUID_SEGMENTS) {
    out += `${lower.slice(cut, at)}-`;
    cut = at;
  }
  return out + lower.slice(cut);
}
