import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { OneTimeSecret } from '../OneTimeSecret';

const SECRET = 'a'.repeat(64);

describe('<OneTimeSecret /> (#1339)', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('copies the secret to the clipboard and confirms', async () => {
    renderWithIntl(<OneTimeSecret secret={SECRET} heading="New secret" onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByText('Copy'));

    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SECRET);
  });

  it('tells the operator to copy by hand when the clipboard is unavailable', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    renderWithIntl(<OneTimeSecret secret={SECRET} heading="New secret" onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByText('Copy'));

    expect(await screen.findByText(/copy it manually/)).toBeTruthy();
    expect(screen.getByText(SECRET)).toBeTruthy();
  });

  it('dismisses only through the explicit "I\'ve copied it" button', () => {
    const onDismiss = vi.fn();
    renderWithIntl(<OneTimeSecret secret={SECRET} heading="New secret" onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText("I've copied it, dismiss"));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
