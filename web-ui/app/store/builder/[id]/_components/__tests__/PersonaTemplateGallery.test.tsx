import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import * as api from '../../../../../_lib/api';
import { PersonaTemplateGallery } from '../PersonaTemplateGallery';

/**
 * Issue #53 — PersonaTemplateGallery vitest cases.
 *
 * Coverage:
 *   - 6 archetype cards + Custom card render
 *   - Selecting a card enables Anwenden; Anwenden calls setPersonaConfig
 *     with template id + axes merged with the existing operator overrides
 *   - "Skill-Felder ebenfalls vorbefüllen" triggers a second
 *     patchBuilderSpec call after persona persists
 *   - Schließen / Abbrechen close the modal
 *   - API error renders inline alert
 */

describe('<PersonaTemplateGallery />', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setPersonaConfigSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let patchBuilderSpecSpy: any;
  type GalleryProps = ComponentProps<typeof PersonaTemplateGallery>;
  // vitest 4 narrowed `Mock` so a bare `vi.fn()` no longer matches a concrete
  // `() => void` prop — type the mocks against the component's prop signatures.
  let onClose: Mock<NonNullable<GalleryProps['onClose']>>;
  let onApplied: Mock<NonNullable<GalleryProps['onApplied']>>;

  beforeEach(() => {
    setPersonaConfigSpy = vi
      .spyOn(api, 'setPersonaConfig')
      .mockResolvedValue({} as Awaited<ReturnType<typeof api.setPersonaConfig>>);
    patchBuilderSpecSpy = vi
      .spyOn(api, 'patchBuilderSpec')
      .mockResolvedValue({} as Awaited<ReturnType<typeof api.patchBuilderSpec>>);
    onClose = vi.fn<NonNullable<GalleryProps['onClose']>>();
    onApplied = vi.fn<NonNullable<GalleryProps['onApplied']>>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders 6 archetype cards + Custom card', () => {
    render(
      <PersonaTemplateGallery
        draftId="draft-1"
        persona={undefined}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('gallery-card-customer-service')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-card-sales-dev')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-card-content-marketing')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-card-research-analyst')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-card-software-engineer')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-card-team-lead')).toBeInTheDocument();
    expect(screen.getByTestId('gallery-card-custom')).toBeInTheDocument();
  });

  it('Anwenden is disabled until a template is selected', () => {
    render(
      <PersonaTemplateGallery
        draftId="draft-1"
        persona={undefined}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('gallery-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('gallery-card-customer-service'));
    expect(screen.getByTestId('gallery-apply')).not.toBeDisabled();
  });

  it('Anwenden persists the template + merged axes via setPersonaConfig', async () => {
    render(
      <PersonaTemplateGallery
        draftId="draft-7"
        persona={{
          axes: { directness: 90 },
          custom_notes: 'auf Deutsch',
        }}
        onClose={onClose}
        onApplied={onApplied}
      />,
    );
    fireEvent.click(screen.getByTestId('gallery-card-customer-service'));
    fireEvent.click(screen.getByTestId('gallery-apply'));

    await waitFor(() => expect(setPersonaConfigSpy).toHaveBeenCalledTimes(1));
    const [draftId, payload] = setPersonaConfigSpy.mock.calls[0]!;
    expect(draftId).toBe('draft-7');
    expect(payload.template).toBe('customer-service');
    expect(payload.custom_notes).toBe('auf Deutsch');
    // operator override directness=90 wins over template's 30
    expect(payload.axes.directness).toBe(90);
    // template's other axes are present
    expect(payload.axes.warmth).toBe(85);
    expect(payload.axes.formality).toBe(75);

    expect(patchBuilderSpecSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ template: 'customer-service' }));
  });

  it('Skill prefill triggers a second patchBuilderSpec call AFTER persona persists', async () => {
    render(
      <PersonaTemplateGallery
        draftId="draft-1"
        persona={undefined}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('gallery-card-software-engineer'));
    fireEvent.click(screen.getByTestId('gallery-prefill-skill'));
    fireEvent.click(screen.getByTestId('gallery-apply'));

    await waitFor(() => expect(patchBuilderSpecSpy).toHaveBeenCalledTimes(1));
    expect(setPersonaConfigSpy).toHaveBeenCalledTimes(1);
    const [, patches] = patchBuilderSpecSpy.mock.calls[0]!;
    expect(patches).toEqual([
      { op: 'add', path: '/skill/role', value: 'Software Engineer' },
      {
        op: 'add',
        path: '/skill/tonality',
        value: 'Pragmatisch, direkt, qualitätsbewusst',
      },
    ]);
  });

  it('Schließen and Abbrechen invoke onClose', () => {
    render(
      <PersonaTemplateGallery
        draftId="draft-1"
        persona={undefined}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('gallery-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('gallery-cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders an inline alert on API failure', async () => {
    setPersonaConfigSpy.mockRejectedValueOnce(new Error('boom'));
    render(
      <PersonaTemplateGallery
        draftId="draft-1"
        persona={undefined}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('gallery-card-team-lead'));
    fireEvent.click(screen.getByTestId('gallery-apply'));
    await waitFor(() => {
      expect(screen.getByTestId('gallery-error')).toHaveTextContent('boom');
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
