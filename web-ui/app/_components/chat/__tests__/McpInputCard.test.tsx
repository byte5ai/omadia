import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PendingMcpInput } from '../../../_lib/chatSessions';
import { renderWithIntl } from '../../../_lib/test-utils';
import {
  MCP_INPUT_REPLY_PREFIX,
  McpInputCard,
  formatMcpInputReply,
} from '../McpInputCard';

const REQUEST: PendingMcpInput = {
  correlationId: 'corr-abc',
  serverName: 'Kunden-CRM',
  serverId: 'srv-1',
  toolName: 'create_ticket',
  prompt: 'Bitte Kundennummer und PIN angeben.',
  fields: [
    { name: 'customerNumber', label: 'Kundennummer', required: true },
    { name: 'pin', label: 'PIN', secret: true },
    { name: 'note', label: 'Notiz', description: 'Optional' },
  ],
};

describe('#544 W2-1 McpInputCard', () => {
  it('MUTATION CHECK: names the asking server', () => {
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled={false} onSubmit={() => {}} />,
    );
    // The security control: a hostile MCP server must not be able to render a
    // credential prompt that reads as omadia's own UI. Removing `serverName`
    // from the heading turns this red.
    expect(
      screen.getByText(/“Kunden-CRM” needs additional details for “create_ticket”/),
    ).toBeInTheDocument();
  });

  it('warns that the values leave for an external server', () => {
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled={false} onSubmit={() => {}} />,
    );
    // Two independent mentions: the heading and the explicit warning line.
    expect(screen.getAllByText(/Kunden-CRM/).length).toBeGreaterThan(1);
  });

  it("renders the server's prompt as quoted, attributed text", () => {
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled={false} onSubmit={() => {}} />,
    );
    const quote = screen.getByText('Bitte Kundennummer und PIN angeben.');
    expect(quote.tagName.toLowerCase()).toBe('blockquote');
  });

  it('renders one labelled input per field and masks secrets', () => {
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled={false} onSubmit={() => {}} />,
    );
    expect(screen.getByLabelText(/Kundennummer/)).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText(/PIN/)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/Notiz/)).toBeInTheDocument();
  });

  it('MUTATION CHECK: submit stays disabled until every required field is filled', async () => {
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled={false} onSubmit={() => {}} />,
    );
    const submit = screen.getByRole('button');
    expect(submit).toBeDisabled();
    // Filling an OPTIONAL field must not unlock it — a required-field check that
    // merely counted non-empty inputs would pass without this step.
    await userEvent.type(screen.getByLabelText(/Notiz/), 'egal');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Kundennummer/), 'K-1234');
    expect(submit).toBeEnabled();
  });

  it('MUTATION CHECK: submits the envelope with the correlation id and only filled fields', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled={false} onSubmit={onSubmit} />,
    );
    await userEvent.type(screen.getByLabelText(/Kundennummer/), 'K-1234');
    await userEvent.type(screen.getByLabelText(/PIN/), '9876');
    await userEvent.click(screen.getByRole('button'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const message = onSubmit.mock.calls[0]![0] as string;
    // Asserting the PARSED payload, not that a callback fired: the orchestrator
    // resolves this exact shape, so a malformed envelope would be a silent
    // no-op in production.
    expect(message.startsWith(MCP_INPUT_REPLY_PREFIX)).toBe(true);
    const parsed = JSON.parse(message.slice(MCP_INPUT_REPLY_PREFIX.length)) as {
      correlationId: string;
      inputResponses: Record<string, string>;
    };
    expect(parsed.correlationId).toBe('corr-abc');
    // The untouched optional field is ABSENT, not an empty string, so the server
    // can tell "skipped" from "explicitly empty".
    expect(parsed.inputResponses).toEqual({ customerNumber: 'K-1234', pin: '9876' });
  });

  it('MUTATION CHECK: cannot be submitted twice', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled={false} onSubmit={onSubmit} />,
    );
    await userEvent.type(screen.getByLabelText(/Kundennummer/), 'K-1');
    const submit = screen.getByRole('button');
    await userEvent.click(submit);
    await userEvent.click(submit);
    // The correlation id is single-use server-side, so a second submit could
    // only ever fail. Dropping the `submitted` latch turns this into 2.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
  });

  it('is inert while a turn is in flight', async () => {
    const onSubmit = vi.fn();
    renderWithIntl(
      <McpInputCard request={REQUEST} disabled onSubmit={onSubmit} />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByLabelText(/Kundennummer/)).toBeDisabled();
  });

  it('renders without a server prompt', () => {
    const { prompt: _drop, ...noPrompt } = REQUEST;
    renderWithIntl(
      <McpInputCard request={noPrompt} disabled={false} onSubmit={() => {}} />,
    );
    // Attribution survives even when the server sent no prose at all.
    expect(screen.getAllByText(/Kunden-CRM/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('blockquote')).not.toBeInTheDocument();
  });

  it('formatMcpInputReply is a stable, parseable envelope', () => {
    const wire = formatMcpInputReply('c1', { a: 'b' });
    expect(wire).toBe(`${MCP_INPUT_REPLY_PREFIX} {"correlationId":"c1","inputResponses":{"a":"b"}}`);
  });
});
