import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { getPersonaTemplate } from '../../../_lib/personaTemplates';
import { renderWithIntl } from '../../../_lib/test-utils';
import { PersonaTemplateGallery } from '../PersonaTemplateGallery';

const render = (ui: ReactElement) => renderWithIntl(ui, { locale: 'de' });

/**
 * #53, moved for #2049 — the persona archetype gallery is a controlled
 * component shared by every place that edits an agent's persona:
 *   - the archetype cards + Custom card render;
 *   - Apply hands the merged persona (template + axes, custom_notes kept,
 *     operator overrides on top) to `onApply`, then closes;
 *   - Close / Cancel close; a rejected `onApply` shows inline, stays open.
 */

describe('<PersonaTemplateGallery />', () => {
  type GalleryProps = ComponentProps<typeof PersonaTemplateGallery>;
  let onClose: Mock<GalleryProps['onClose']>;
  let onApply: Mock<GalleryProps['onApply']>;

  beforeEach(() => {
    onClose = vi.fn<GalleryProps['onClose']>();
    onApply = vi.fn<GalleryProps['onApply']>();
  });

  it('renders the archetype cards + Custom card', () => {
    render(<PersonaTemplateGallery persona={undefined} onApply={onApply} onClose={onClose} />);
    for (const id of [
      'customer-service',
      'sales-dev',
      'content-marketing',
      'research-analyst',
      'software-engineer',
      'team-lead',
      'custom',
    ]) {
      expect(screen.getByTestId(`gallery-card-${id}`)).toBeInTheDocument();
    }
  });

  it('Apply is disabled until a template is selected', () => {
    render(<PersonaTemplateGallery persona={undefined} onApply={onApply} onClose={onClose} />);
    expect(screen.getByTestId('gallery-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('gallery-card-customer-service'));
    expect(screen.getByTestId('gallery-apply')).not.toBeDisabled();
  });

  it('Apply hands the template + merged axes to onApply, then closes', async () => {
    render(
      <PersonaTemplateGallery
        persona={{ axes: { directness: 90 }, custom_notes: 'auf Deutsch' }}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('gallery-card-customer-service'));
    fireEvent.click(screen.getByTestId('gallery-apply'));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const payload = onApply.mock.calls[0]![0];
    expect(payload.template).toBe('customer-service');
    expect(payload.custom_notes).toBe('auf Deutsch');
    // operator override directness=90 wins over the template's 30
    expect(payload.axes?.directness).toBe(90);
    expect(payload.axes?.warmth).toBe(85);
    expect(payload.axes?.formality).toBe(75);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('switching from one template to another sends the new template axes (#1791)', async () => {
    const salesDev = getPersonaTemplate('sales-dev')!;
    const engineer = getPersonaTemplate('software-engineer')!;
    render(
      <PersonaTemplateGallery
        persona={{ template: salesDev.id, axes: { ...salesDev.axes } }}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId(`gallery-card-${engineer.id}`));
    fireEvent.click(screen.getByTestId('gallery-apply'));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const payload = onApply.mock.calls[0]![0];
    expect(payload.template).toBe(engineer.id);
    expect(payload.axes).toEqual(engineer.axes);
  });

  it('Close and Cancel invoke onClose', () => {
    render(<PersonaTemplateGallery persona={undefined} onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('gallery-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('gallery-cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('renders an inline alert when onApply rejects and stays open', async () => {
    onApply.mockRejectedValueOnce(new Error('boom'));
    render(<PersonaTemplateGallery persona={undefined} onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('gallery-card-team-lead'));
    fireEvent.click(screen.getByTestId('gallery-apply'));
    await waitFor(() => {
      expect(screen.getByTestId('gallery-error')).toHaveTextContent('boom');
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
