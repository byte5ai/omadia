import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { SkillEditor } from '../SkillEditor';
import type { SkillNode } from '../../../_lib/agentBuilder';

/**
 * OM-26 — the raw provider payload must not reach the screen.
 *
 * What the customer saw:
 *   Tiefen-Scan-Hinweis: llm completion failed: 401 {"type":"error","error":
 *   {"type":"authentication_error","message":"invalid x-api-key"},
 *   "request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}
 *
 * Unusable (it never says "your key is wrong, fix it here") and it exposed a
 * provider-internal request id. The middleware now stores a code; this pins the
 * UI half: the code maps to actionable German copy with a link to the page that
 * fixes it, and the raw JSON is nowhere in the DOM.
 */

vi.mock('../../../_lib/agentBuilder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/agentBuilder')>();
  return {
    ...actual,
    acknowledgeSkillVerdict: vi.fn(),
    exportSkill: vi.fn(),
    forkSkill: vi.fn(),
    getSkill: vi.fn(),
    patchSkill: vi.fn(),
    triggerSkillVerdictLlmScan: vi.fn(),
  };
});

vi.mock('../SkillCapabilityBindings', () => ({
  SkillCapabilityBindings: (): React.ReactElement => <div />,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => <a href={href}>{children}</a>,
}));

/** The exact payload from the bug report. */
const RAW_401 =
  'llm completion failed: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}';

function skill(rationale: string): SkillNode {
  return {
    id: 's1',
    slug: 'demo',
    name: 'Demo',
    description: null,
    body: 'body',
    source: 'db',
    frontmatter: {},
    sourcePath: null,
    verdict: {
      severity: 'scan_failed',
      riskCodes: [],
      llm: { severity: 'scan_failed', rationale, computedAt: '2026-08-03T10:00:00Z' },
    },
  } as unknown as SkillNode;
}

describe('<SkillEditor /> — OM-26 deep-scan failure copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the `auth` code to actionable German copy plus a provider link', () => {
    renderWithIntl(<SkillEditor skill={skill('scan_failed:auth')} onSaved={() => {}} />, {
      locale: 'de',
    });

    expect(
      screen.getByText(/Der hinterlegte API-Schlüssel ist ungültig/),
    ).toBeTruthy();

    const link = screen.getByRole('link', { name: /LLM-Zugang prüfen/ });
    expect(link.getAttribute('href')).toBe('/admin/providers');
  });

  it('the raw provider JSON is NOT in the DOM', () => {
    const { container } = renderWithIntl(
      <SkillEditor skill={skill('scan_failed:auth')} onSaved={() => {}} />,
      { locale: 'de' },
    );

    const html = container.innerHTML;
    // THE regression guard: each of these is a way the raw payload used to leak.
    expect(html).not.toContain('request_id');
    expect(html).not.toContain('req_011CdcPnpMTB8iyAmMBnbem8');
    expect(html).not.toContain('x-api-key');
    expect(html).not.toContain('authentication_error');
    expect(html).not.toContain('llm completion failed');
  });

  it('a genuine free-text rationale still renders as before', () => {
    renderWithIntl(
      <SkillEditor
        skill={skill('The skill instructs the model to ignore prior rules.')}
        onSaved={() => {}}
      />,
      { locale: 'de' },
    );

    expect(
      screen.getByText(/ignore prior rules/),
    ).toBeTruthy();
  });

  it('a LEGACY row holding the raw payload is redacted on read', () => {
    // Rows persisted BEFORE the server-side fix still carry the raw text, and
    // nothing can un-persist them. The server fix alone therefore does not
    // protect an existing install — the read path has to redact too.
    const { container } = renderWithIntl(
      <SkillEditor skill={skill(RAW_401)} onSaved={() => {}} />,
      { locale: 'de' },
    );

    const html = container.innerHTML;
    expect(html).not.toContain('req_011CdcPnpMTB8iyAmMBnbem8');
    expect(html).not.toContain('"request_id"');
    expect(html).toContain('[redacted]');
  });
});
