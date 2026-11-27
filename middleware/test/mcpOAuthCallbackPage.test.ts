import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  mcpOAuthCallbackLocale,
  mcpOAuthCallbackPage,
} from '../src/routes/mcpOAuthCallbackPage.js';

/** #1959 — the MCP OAuth callback page follows the browser's language. */
describe('MCP OAuth callback page (#1959)', () => {
  const req = (header: string | undefined) => ({
    acceptsLanguages: (...langs: string[]): string | false => {
      if (header === undefined) return langs[0] ?? false;
      const wanted = header.split(',').map((part) => part.split(';')[0]!.trim().slice(0, 2));
      return wanted.find((w) => langs.includes(w)) ?? false;
    },
  });

  it('picks German for a German browser and English otherwise', () => {
    assert.equal(mcpOAuthCallbackLocale(req('de-DE,de;q=0.9')), 'de');
    assert.equal(mcpOAuthCallbackLocale(req('en-US')), 'en');
    assert.equal(mcpOAuthCallbackLocale(req('fr-FR')), 'en');
    assert.equal(mcpOAuthCallbackLocale(req(undefined)), 'en');
  });

  it('renders the success page in German with du', () => {
    const html = mcpOAuthCallbackPage('de', true, 'connected');
    assert.match(html, /<html lang="de">/);
    assert.match(html, /Verbunden/);
    assert.match(html, /für dich autorisiert/);
    assert.match(html, /Du kannst diesen Tab schließen/);
    assert.doesNotMatch(html, /You can close/);
  });

  it('escapes an untrusted detail and keeps the localized message', () => {
    const html = mcpOAuthCallbackPage('en', false, 'providerError', '<script>alert(1)</script>');
    assert.match(html, /The provider returned an error:/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});
