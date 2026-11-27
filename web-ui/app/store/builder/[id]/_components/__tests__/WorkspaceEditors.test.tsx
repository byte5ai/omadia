import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSpecSkeleton } from '../../../../../_lib/builderTypes';
import { renderWithIntl } from '../../../../../_lib/test-utils';
import { SetupFieldsEditor } from '../SetupFieldsEditor';
import { SpecEditor } from '../SpecEditor';
import { normalizeTemplateId } from '../pluginKind';

const { getDraft, patchSpec } = vi.hoisted(() => ({
  getDraft: vi.fn(),
  patchSpec: vi.fn(),
}));

vi.mock('../../../../../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../_lib/api')>()),
  getBuilderDraft: getDraft,
  patchBuilderSpec: patchSpec,
}));

const spec: AgentSpecSkeleton = {
  id: '@test/plugin',
  name: 'Plugin',
  version: '0.1.0',
  description: '',
  category: 'other',
  domain: 'test',
  depends_on: [],
  tools: [],
  setup_fields: [],
  playbook: { when_to_use: '', not_for: [], example_prompts: [] },
  network: { outbound: [] },
  slots: {},
};

describe('Builder workspace editor saves', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('uses the same canonical template for older local-tool drafts', () => {
    expect(normalizeTemplateId('pure-llm')).toBe('tool');
    expect(normalizeTemplateId('agent-pure-llm')).toBe('tool');
  });

  it('debounces the latest textarea text and saves a pasted value on blur', async () => {
    vi.useFakeTimers();
    patchSpec.mockResolvedValue({ draft: { spec } });
    renderWithIntl(<SpecEditor draftId="d1" spec={spec} />);

    const description = screen.getByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Local wors' } });
    fireEvent.change(description, { target: { value: 'Local words' } });
    expect(patchSpec).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(patchSpec).toHaveBeenCalledExactlyOnceWith('d1', [
      { op: 'replace', path: '/description', value: 'Local words' },
    ]);

    const playbook = screen.getByLabelText('when_to_use');
    fireEvent.change(playbook, { target: { value: 'Check tone and wording' } });
    fireEvent.blur(playbook);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(patchSpec).toHaveBeenCalledTimes(2);
    expect(patchSpec).toHaveBeenLastCalledWith('d1', [
      { op: 'replace', path: '/playbook/when_to_use', value: 'Check tone and wording' },
    ]);
  });

  it('buffers a setup label and preserves the other language in the saved spec', async () => {
    const fields = [{ key: 'region', label_localized: { en: 'Region', de: 'Gebiet' } }];
    const changed = [{ key: 'region', label_localized: { en: 'Service region', de: 'Gebiet' } }];
    getDraft.mockResolvedValue({ draft: { updatedAt: 1, spec: { ...spec, setup_fields: fields } } });
    patchSpec.mockResolvedValue({ draft: { updatedAt: 2, spec: { ...spec, setup_fields: changed } } });
    renderWithIntl(<SetupFieldsEditor draftId="d1" specUpdatedAt={1} fields={fields} oauthProviders={[]} />);

    const label = screen.getByLabelText('Label');
    fireEvent.focus(label);
    fireEvent.change(label, { target: { value: 'Service re' } });
    fireEvent.change(label, { target: { value: 'Service region' } });
    expect(label).toHaveValue('Service region');
    expect(patchSpec).not.toHaveBeenCalled();
    fireEvent.blur(label);
    await waitFor(() => expect(patchSpec).toHaveBeenCalledExactlyOnceWith('d1', [
      { op: 'replace', path: '/setup_fields', value: changed },
    ], fields));
    expect(label).toHaveValue('Service region');
  });

  it('keeps the label input and its unsaved text when a field rename finishes', async () => {
    const fields = [{ key: 'region', label: 'Region' }];
    const renamed = [{ key: 'service_region', label: 'Region' }];
    getDraft.mockResolvedValue({ draft: { updatedAt: 1, spec: { ...spec, setup_fields: fields } } });
    let completeRename!: () => void;
    patchSpec.mockImplementation(() => new Promise((resolve) => {
      completeRename = () => resolve({
        draft: { updatedAt: 2, spec: { ...spec, setup_fields: renamed } },
      });
    }));
    const { rerender } = renderWithIntl(
      <SetupFieldsEditor draftId="d1" specUpdatedAt={1} fields={fields} oauthProviders={[]} />,
    );

    const key = screen.getByLabelText('Field key');
    fireEvent.change(key, { target: { value: 'service_region' } });
    fireEvent.blur(key);
    await waitFor(() => expect(patchSpec).toHaveBeenCalledTimes(1));

    const label = screen.getByLabelText('Label');
    fireEvent.focus(label);
    fireEvent.change(label, { target: { value: 'Service region' } });
    rerender(<SetupFieldsEditor draftId="d1" specUpdatedAt={2} fields={renamed} oauthProviders={[]} />);
    expect(screen.getByLabelText('Label')).toBe(label);
    await act(async () => completeRename());
    expect(screen.getByLabelText('Label')).toBe(label);
    expect(label).toHaveValue('Service region');
  });

  it('uses the first queued label edit as the basis for the second edit', async () => {
    const fields = [{ key: 'region', label_localized: { en: 'Region', de: 'Gebiet' } }];
    const first = [{ key: 'region', label_localized: { en: 'First', de: 'Gebiet' } }];
    const second = [{ key: 'region', label_localized: { en: 'Second', de: 'Gebiet' } }];
    getDraft
      .mockResolvedValueOnce({ draft: { updatedAt: 1, spec: { ...spec, setup_fields: fields } } })
      .mockResolvedValueOnce({ draft: { updatedAt: 2, spec: { ...spec, setup_fields: first } } });
    let completeFirst!: () => void;
    patchSpec
      .mockImplementationOnce(() => new Promise((resolve) => {
        completeFirst = () => resolve({ draft: { updatedAt: 2, spec: { ...spec, setup_fields: first } } });
      }))
      .mockResolvedValueOnce({ draft: { updatedAt: 3, spec: { ...spec, setup_fields: second } } });
    renderWithIntl(<SetupFieldsEditor draftId="d1" specUpdatedAt={1} fields={fields} oauthProviders={[]} />);

    const label = screen.getByLabelText('Label');
    fireEvent.change(label, { target: { value: 'First' } });
    fireEvent.blur(label);
    await waitFor(() => expect(patchSpec).toHaveBeenCalledTimes(1));
    fireEvent.change(label, { target: { value: 'Second' } });
    fireEvent.blur(label);
    await act(async () => completeFirst());

    expect(patchSpec).toHaveBeenLastCalledWith('d1', [
      { op: 'replace', path: '/setup_fields', value: second },
    ], first);
    expect(label).toHaveValue('Second');
  });

  it('reports a concurrent change to the same label instead of overwriting it', async () => {
    const fields = [{ key: 'region', label: 'Region' }];
    getDraft.mockResolvedValue({
      draft: { updatedAt: 2, spec: { ...spec, setup_fields: [{ key: 'region', label: 'Remote edit' }] } },
    });
    renderWithIntl(<SetupFieldsEditor draftId="d1" specUpdatedAt={1} fields={fields} oauthProviders={[]} />);

    const label = screen.getByLabelText('Label');
    fireEvent.change(label, { target: { value: 'Local edit' } });
    fireEvent.blur(label);
    expect(await screen.findByText('The setup fields changed. Check the latest values and try again.')).toBeVisible();
    expect(patchSpec).not.toHaveBeenCalled();
  });
});
