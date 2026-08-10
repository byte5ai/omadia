'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '../ui/Button';
import type { PendingMcpInput } from '../../_lib/chatSessions';

/**
 * Issue #544 (W2-1) — mid-call input form for an MCP tool that answered
 * `resultType: "input_required"`.
 *
 * Sibling of `ChoiceCard`, deliberately not a variant of it: a choice card is
 * 2-4 mutually exclusive buttons the MODEL chose, this is N free-text fields a
 * THIRD-PARTY SERVER demanded. Submitting fires a fresh user turn carrying the
 * reply envelope, which the orchestrator resolves and replays.
 *
 * ## Server attribution is a security control, not a label
 *
 * An MCP server can now make omadia render arbitrary prose and collect arbitrary
 * free text mid-conversation. Without naming the asker, a hostile server could
 * phish credentials behind omadia's own chrome. So this card:
 *
 *   - names the server in the heading, prominently, always;
 *   - renders the server's `prompt` inside a visually distinct quote block, so
 *     untrusted prose cannot read as omadia speaking;
 *   - carries an explicit warning that the values go to that external server;
 *   - uses a neutral/warning treatment rather than the accent colour the rest of
 *     omadia's own UI uses for its own questions.
 *
 * `secret: true` masks the input, but the hint says plainly that the value still
 * reaches the server — claiming otherwise would be worse than not masking.
 */

/**
 * Prefix of the synthetic user message the answer rides back on. MUST stay
 * byte-identical to `MCP_INPUT_REPLY_PREFIX` in
 * `middleware/packages/harness-orchestrator/src/mcp/pendingMcpInput.ts`.
 * Duplicated rather than imported: web-ui does not depend on the middleware
 * packages, and `middleware/test/mcpInputReplyContract.test.ts` pins the pair.
 */
export const MCP_INPUT_REPLY_PREFIX = '__mcp_input_reply__';

/** Build the envelope the next turn carries. */
export function formatMcpInputReply(
  correlationId: string,
  inputResponses: Record<string, string>,
): string {
  return `${MCP_INPUT_REPLY_PREFIX} ${JSON.stringify({
    correlationId,
    inputResponses,
  })}`;
}

export function McpInputCard({
  request,
  disabled,
  onSubmit,
}: {
  request: PendingMcpInput;
  disabled: boolean;
  /** Submits the envelope as a fresh user turn. */
  onSubmit: (message: string) => void;
}): React.ReactElement {
  const t = useTranslations('chat');
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const missingRequired = request.fields.some(
    (f) => f.required === true && (values[f.name] ?? '').trim().length === 0,
  );
  const locked = disabled || submitted;

  const submit = (): void => {
    if (locked || missingRequired) return;
    // Only fields the user actually filled in travel; an untouched optional
    // field is absent rather than an empty string, so the server can tell
    // "skipped" from "explicitly empty".
    const payload: Record<string, string> = {};
    for (const field of request.fields) {
      const value = values[field.name];
      if (value !== undefined && value.length > 0) payload[field.name] = value;
    }
    setSubmitted(true);
    onSubmit(formatMcpInputReply(request.correlationId, payload));
  };

  return (
    <form
      className="mt-3 rounded border border-[color:var(--warn-edge,var(--edge))] bg-[color:var(--bg-subtle)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold tracking-wide uppercase text-[color:var(--fg-muted)]">
        <span aria-hidden="true">🔗</span>
        <span>{t('mcpInput.kicker')}</span>
      </div>
      {/* Attribution — the security-relevant line. Never conditional. */}
      <div className="mb-2 text-sm text-[color:var(--fg-strong)]">
        {t('mcpInput.heading', {
          server: request.serverName,
          tool: request.toolName,
        })}
      </div>
      {request.prompt !== undefined && request.prompt.length > 0 && (
        // Quoted + attributed: untrusted server prose must not read as omadia's
        // own copy.
        <blockquote className="mb-2 border-l-2 border-[color:var(--edge)] pl-2 text-xs text-[color:var(--fg-muted)]">
          {request.prompt}
        </blockquote>
      )}
      <div className="flex flex-col gap-2">
        {request.fields.map((field) => {
          const id = `mcp-input-${request.correlationId}-${field.name}`;
          return (
            <div key={field.name} className="flex flex-col gap-1">
              <label
                htmlFor={id}
                className="text-xs font-medium text-[color:var(--fg-default)]"
              >
                {field.label ?? field.name}
                {field.required === true && (
                  <span
                    className="ml-1 text-[color:var(--fg-muted)]"
                    aria-hidden="true"
                  >
                    *
                  </span>
                )}
              </label>
              {field.description !== undefined && (
                <span className="text-[11px] text-[color:var(--fg-muted)]">
                  {field.description}
                </span>
              )}
              <input
                id={id}
                type={field.secret === true ? 'password' : 'text'}
                autoComplete="off"
                required={field.required === true}
                disabled={locked}
                value={values[field.name] ?? ''}
                onChange={(e) => {
                  setValues((prev) => ({ ...prev, [field.name]: e.target.value }));
                }}
                className="rounded border border-[color:var(--edge)] bg-[color:var(--bg-default)] px-2 py-1 text-sm text-[color:var(--fg-strong)]"
              />
              {field.secret === true && (
                // Honest, not reassuring: masking is a display choice only.
                <span className="text-[11px] text-[color:var(--fg-muted)]">
                  {t('mcpInput.secretHint')}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-[color:var(--fg-muted)]">
        {t('mcpInput.warning', { server: request.serverName })}
      </p>
      <div className="mt-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={locked || missingRequired}
        >
          {t('mcpInput.submit')}
        </Button>
      </div>
    </form>
  );
}
