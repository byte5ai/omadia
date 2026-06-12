import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ExportDraftButton } from '../ExportDraftButton';

function snapshot(id = 'snap-1') {
  return {
    snapshot_id: id,
    bundle_hash: 'deadbeef',
    bundle_size_bytes: 1234,
    created_at: '2026-06-10T00:00:00.000Z',
    was_existing: true,
  };
}

describe('<ExportDraftButton />', () => {
  it('opens a two-option menu (Plugin + Bundle) on click', () => {
    renderWithIntl(<ExportDraftButton draftId="my-agent" capture={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Export/i }));
    expect(screen.getByRole('menuitem', { name: /Plugin ZIP/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Bundle ZIP/i })).toBeInTheDocument();
  });

  it('captures a snapshot and downloads the plugin ZIP (no ?format)', async () => {
    const capture = vi.fn().mockResolvedValue(snapshot('snap-xyz'));
    const onDownload = vi.fn();
    renderWithIntl(
      <ExportDraftButton draftId="my-agent" capture={capture} onDownload={onDownload} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Export/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Plugin ZIP/i }));

    await waitFor(() => expect(capture).toHaveBeenCalledWith('my-agent'));
    expect(onDownload).toHaveBeenCalledWith(
      '/bot-api/v1/profiles/my-agent/snapshots/snap-xyz/download',
    );
  });

  it('appends ?format=bundle for the bundle export', async () => {
    const capture = vi.fn().mockResolvedValue(snapshot('snap-b'));
    const onDownload = vi.fn();
    renderWithIntl(
      <ExportDraftButton draftId="my-agent" capture={capture} onDownload={onDownload} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Export/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Bundle ZIP/i }));

    await waitFor(() =>
      expect(onDownload).toHaveBeenCalledWith(
        '/bot-api/v1/profiles/my-agent/snapshots/snap-b/download?format=bundle',
      ),
    );
  });

  it('surfaces a failure message when capture rejects', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('boom'));
    const onDownload = vi.fn();
    renderWithIntl(
      <ExportDraftButton draftId="my-agent" capture={capture} onDownload={onDownload} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Export/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Plugin ZIP/i }));

    expect(await screen.findByText(/Export failed: boom/i)).toBeInTheDocument();
    expect(onDownload).not.toHaveBeenCalled();
  });
});
