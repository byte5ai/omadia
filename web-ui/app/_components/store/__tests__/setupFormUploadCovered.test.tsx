import { describe, expect, it } from 'vitest';

import { uploadCoveredKeys } from '../setupForm';
import type { InstallSetupField } from '../../../_lib/storeTypes';

/**
 * #603 (OM-17) — found on the v0.115.2 fresh-install smoke: with the key file
 * attached, the install form still would not submit. The browser's NATIVE
 * `required` check on the two fields the upload supplies refused the submit
 * silently (an unlocalizable native tooltip). These pins keep the covered-key
 * derivation honest; `FieldRow` drops native `required` for exactly this set.
 */
describe('uploadCoveredKeys', () => {
  const fields = [
    {
      key: 'sa_key_file',
      type: 'json_file',
      label: { en: 'Key file' },
      required: false,
      extracts: { sa_email: '$.client_email', sa_private_key: '$.private_key' },
    },
    { key: 'sa_email', type: 'string', label: { en: 'Email' }, required: true },
    { key: 'sa_private_key', type: 'secret', label: { en: 'Key' }, required: true },
    { key: 'subject', type: 'string', label: { en: 'User' }, required: true },
  ] as unknown as InstallSetupField[];

  it('names exactly the extracts targets', () => {
    const covered = uploadCoveredKeys(fields);
    expect([...covered].sort()).toEqual(['sa_email', 'sa_private_key']);
  });

  it('leaves fields no upload supplies untouched', () => {
    expect(uploadCoveredKeys(fields).has('subject')).toBe(false);
  });

  it('is empty when no json_file field exists', () => {
    expect(uploadCoveredKeys(fields.slice(1)).size).toBe(0);
  });
});
