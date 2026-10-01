/**
 * Mock `PrivacyReceipt` fixtures (Privacy Shield v4 shape) for UI
 * development and tests.
 *
 * The Web and Teams renderers implement their collapsible privacy
 * disclosure against these realistic data shapes. Once the backend is
 * live the renderers swap the fixture import for the real
 * receipt-from-message-metadata path — the type stays identical.
 */

import type { PrivacyReceipt } from './privacyReceipt.js';

/** Quiet turn: no tool was called, so nothing was interned. */
export const RECEIPT_FIXTURE_QUIET: PrivacyReceipt = {
  datasetsInterned: 0,
  fieldsMasked: 0,
  fieldsCleartext: 0,
  verbsExecuted: [],
  pseudonymProjectionUsed: false,
};

/** Typical data turn: an HR tool result was interned, masked columns
 *  (names) kept off the wire, and the LLM composed a sort + top_n. */
export const RECEIPT_FIXTURE_RANKED: PrivacyReceipt = {
  datasetsInterned: 1,
  fieldsMasked: 1,
  fieldsCleartext: 3,
  verbsExecuted: ['sort', 'top_n'],
  pseudonymProjectionUsed: false,
};

/** Individual-prose turn: the gated pseudonym projection was released. */
export const RECEIPT_FIXTURE_PSEUDONYM: PrivacyReceipt = {
  datasetsInterned: 2,
  fieldsMasked: 2,
  fieldsCleartext: 5,
  verbsExecuted: ['filter', 'select'],
  pseudonymProjectionUsed: true,
};

/** Failing-tool turn: nothing was interned, but three tool errors were
 *  handled at the dispatch seams — a thrown exception withheld, a returned
 *  `Error:` text redacted, and an MCP connect prompt passed through. */
export const RECEIPT_FIXTURE_TOOL_ERRORS: PrivacyReceipt = {
  datasetsInterned: 0,
  fieldsMasked: 0,
  fieldsCleartext: 0,
  verbsExecuted: [],
  pseudonymProjectionUsed: false,
  toolErrors: [
    { toolName: 'odoo_search_partner', carrier: 'thrown', outcome: 'withheld', bytes: 212 },
    {
      toolName: 'crm_lookup_customer',
      carrier: 'returned',
      outcome: 'redacted',
      bytes: 96,
      redactedSpans: [{ type: 'email', detector: 'c0-regex' }],
    },
    { toolName: 'mcp__Strava__list_activities', carrier: 'mcp_auth_prompt', outcome: 'passed', bytes: 301 },
  ],
};

/** Convenience array for tests / Storybook iteration. */
export const ALL_PRIVACY_RECEIPT_FIXTURES: readonly PrivacyReceipt[] = [
  RECEIPT_FIXTURE_QUIET,
  RECEIPT_FIXTURE_RANKED,
  RECEIPT_FIXTURE_PSEUDONYM,
  RECEIPT_FIXTURE_TOOL_ERRORS,
];
