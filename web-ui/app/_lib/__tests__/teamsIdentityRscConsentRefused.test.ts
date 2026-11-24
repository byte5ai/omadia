import { describe, expect, it } from 'vitest';

import { parseTeamsIdentityLastErrorDetail } from '../agents';
import {
  teamsIdentityErrorMessages,
  teamsIdentityErrorTechnicalDetail,
} from '../teamsIdentity';
import de from '../../../messages/de.json';
import en from '../../../messages/en.json';

/**
 * #2043 rollout (D7): the team's resource-specific consent check refused the
 * install. The panel said "a reason omadia cannot classify" and showed no
 * detail. It has its own code now, names what Microsoft reported and keeps
 * the whole answer as the technical detail.
 */
const RAW =
  "rsc_consent_refused: Teams refused to grant this app's resource-specific permissions in the target team … Reported by Microsoft: graph teams.installedApps.add 400 … isUserAuthorizedToGrantResourceSpecificPermissions, Response Status Code: BadRequest";

describe('teams identity: rsc_consent_refused', () => {
  it('is decoded with the identifiers Microsoft named, and nothing that is not an identifier', () => {
    const detail = parseTeamsIdentityLastErrorDetail(
      {
        code: 'rsc_consent_refused',
        graphCode: 'BadRequest',
        innerCode: 'InvalidRequest',
        backendRequest: 'IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest',
        raw: RAW,
      },
      RAW,
    );
    expect(detail?.code).toBe('rsc_consent_refused');
    expect(detail?.backendRequest).toBe('IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest');
    const hostile = parseTeamsIdentityLastErrorDetail(
      { code: 'rsc_consent_refused', graphCode: '<b>x</b> with spaces', raw: RAW },
      RAW,
    );
    expect(hostile?.graphCode).toBeUndefined();
  });

  it('says what happened, what Microsoft named and what to do; the raw answer is the technical detail', () => {
    const detail = parseTeamsIdentityLastErrorDetail(
      { code: 'rsc_consent_refused', graphCode: 'BadRequest', innerCode: 'InvalidRequest', raw: RAW },
      RAW,
    );
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(teamsIdentityErrorMessages(detail)).toEqual([
      { key: 'errors.rsc_consent_refused.what' },
      { key: 'errors.rsc_consent_refused.reported', values: { codes: 'BadRequest, InvalidRequest' } },
      { key: 'errors.rsc_consent_refused.next' },
    ]);
    expect(teamsIdentityErrorTechnicalDetail(detail)).toEqual({
      key: 'errors.technicalDetail',
      values: { raw: RAW },
    });
    const bare = parseTeamsIdentityLastErrorDetail({ code: 'rsc_consent_refused', raw: RAW }, RAW);
    expect(bare && teamsIdentityErrorMessages(bare).map((m) => m.key)).toEqual([
      'errors.rsc_consent_refused.what',
      'errors.rsc_consent_refused.next',
    ]);
  });

  it('has copy in both locales that calls it permanent, not a replication delay', () => {
    for (const catalog of [en, de]) {
      const copy = catalog.operatorAgents.teamsIdentity.errors.rsc_consent_refused;
      expect(Object.keys(copy).sort()).toEqual(['next', 'reported', 'what']);
      expect(copy.reported).toContain('{codes}');
    }
    expect(en.operatorAgents.teamsIdentity.errors.rsc_consent_refused.what).toMatch(/permanent refusal, not a replication delay/);
    expect(de.operatorAgents.teamsIdentity.errors.rsc_consent_refused.what).toMatch(/dauerhafte Ablehnung und keine Replikationsverzögerung/);
  });
});
