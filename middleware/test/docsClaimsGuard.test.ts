/**
 * The root README, the architecture overview, the security architecture,
 * CITATION.cff and the implementation notes of ADR-0001 and ADR-0005 state
 * security properties in public. This guard ties the load-bearing ones to the
 * code that enforces them: a changed default or a retired overclaim that comes
 * back fails here.
 *
 * Kept narrow on purpose. Retired claims are matched as exact phrases, and the
 * positive checks look for the named control (a config key, a default, a
 * catalog field, an exemption list, a cache bound, a failure counter, the
 * verifier's trigger router) plus the one word that states its limit, not for
 * the wording around it.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INTERN_EXEMPT_TOOLS,
  internFailedNotice,
} from '@omadia/orchestrator/dist/privacyInternPolicy.js';
import {
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  ToolIdempotencyStore,
} from '@omadia/orchestrator/dist/toolIdempotency.js';
import { ReadAttachmentTool } from '@omadia/orchestrator/dist/tools/readAttachmentTool.js';
import { verdictReleasesAnswer } from '@omadia/orchestrator/dist/verifierDelivery.js';
import { bundleProvenance, DEFAULT_SECURITY_POSTURE_POLICY } from '@omadia/channel-sdk';
import { isWriteCapableTool, PRIVACY_MODE_DEFAULT } from '@omadia/plugin-api';
import {
  createPrivacyGuardService,
  MASK_USER_PROMPT_CONFIG_KEY,
} from '@omadia/plugin-privacy-guard/dist/service.js';
import { shouldTriggerVerifier, VerifierPipeline } from '@omadia/verifier';
import type { VerifierPipelineOptions } from '@omadia/verifier';
import { parse as parseYaml } from 'yaml';

import { ConfigSchema } from '../src/config.js';
import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';
import { turnReceiptCounters } from '../src/receipts/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walks up from the test file to the checkout root, so the guard reads the
 *  same files whether it runs from `test/` or from a compiled copy. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'README.md')) && existsSync(path.join(dir, 'CITATION.cff'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no checkout root (README.md + CITATION.cff) above ${start}`);
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(HERE);

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
}

/** Undoes Markdown line wrapping and `&nbsp;` so a phrase matches across a wrap
 *  or inside a table cell. */
function flatten(markdown: string): string {
  return markdown.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

/** Sentences (and table cells) of `markdown` that contain `token`. */
function sentencesMentioning(markdown: string, token: string): string[] {
  return flatten(markdown)
    .split(/(?<=[.!?])\s+|\s\|\s/)
    .filter((sentence) => sentence.includes(token));
}

const PUBLIC_CLAIM_FILES = [
  'README.md',
  'docs/architecture.md',
  'docs/security-architecture.md',
  'CITATION.cff',
  'docs/adr/0001-plugin-distribution-via-signed-zip.md',
  'docs/adr/0005-two-phase-confirmation-for-writes.md',
] as const;

/** Sentences these files used to carry that the code does not back. */
const RETIRED_CLAIMS = [
  // The subscription CLI runs without the shield, and prompt masking is opt-in.
  'never leaves in clear text',
  'without running through the model',
  // Intern-exempt tools reach the model in clear: the digest covers the
  // results of data-source tools only.
  'the LLM sees only an identity-free digest',
  'exposes only an identity-free digest',
  'raw tool results stay on your server',
  // A result whose interning fails is withheld at every seam, not sent raw.
  'the raw result for every tool except',
  'goes out raw unless it came from',
  // Receipts exist only for turns in which the shield acted, and appending one
  // is best-effort; the run trace is best-effort telemetry and has no replay.
  'every action carries a receipt',
  'a receipt for every action',
  'every turn in which the shield acted',
  'every turn in which the privacy shield acted',
  'receipts for the turns in which',
  'carries a full per-run trace',
  'is your audit receipt',
  'an auditable trace for every action',
  // Plugin packages are pinned by SHA-256; nothing checks a publisher signature.
  'signed plugin distribution',
  'verifiable signed packages',
  'installed as signed ZIPs',
  'from signed plugins',
  'ship as signed ZIPs',
  'plugins are verifiable packages',
  // Unbundled dependencies resolve from the image, and the manifest permissions
  // gate the context accessors only: a plugin is trusted in-process code.
  'with their dependencies inside',
  'with their dependencies baked in',
  'self-contained ZIP files',
  'The runtime enforces the declaration',
  // Preview and confirm live in the connector plugins that implement them.
  'write actions are proposed and confirmed',
  // The idempotency key deduplicates within one process and a cache window.
  'at most once per key',
  // omadia evaluates no spreadsheet formula.
  'calculated by that engine rather than produced by the model',
  // The verifier checks only answers its trigger patterns match, and `enforce`
  // delivers the others unchecked: figures in other formats are not checked.
  'checks answers that contain figures',
  'checks answers that carry figures',
  'holds no claim to check',
  'holds nothing to check',
  // An aggregate keyword with a number of three or more digits triggers in any
  // format (`Total: $500`), so "other formats" alone do not keep an answer out.
  'whose figures all come in other formats',
  'matches none of them.',
  // The org clamp covers the result the model gets, not the MCP-to-knowledge-
  // graph ingestion, which stores a bypassed server's raw result regardless.
  'switches all three off.',
  'to `guarded` org-wide.',
  // The card exemption runs before the privacy gate, so an input-card turn
  // releases a rendered answer unchecked.
  'so `enforce` withholds it.',
  'delivers no rendered answer',
  // A re-entry replays the recorded calls; only a sub-agent that interned
  // data behind the shield runs again, its own calls replayed.
  'run no tool again',
  'runs no tool again',
  'runs a tool again',
  'never re-runs a tool',
  // 1,000 records is an eviction target: a call still running inside its
  // 15-minute window is never evicted, so the store can briefly hold more.
  'at most 1,000 records',
  // Past that window a running call's record expires or is evicted like any
  // other, and a retry under the same key runs the write again.
  'a call still running is never evicted',
  // Prompt masking reaches only the turn's own model requests (§6f).
  'context are masked only while',
  // Tool errors are redacted or withheld only for tools that are not
  // bypassed: the seams return a bypassed result before they look for an
  // `Error:` text (§6c residuals, §6f).
  'tool errors, whatever the settings',
  'digest and redacts tool errors',
  'There it interns tool results and redacts tool errors',
  // The memory jobs mask the stored text they send to their model whatever
  // `mask_user_prompt` says (§6f, "Memory jobs"); only turn scoring and
  // embeddings still send stored text as it is.
  'turn scoring and the other memory jobs',
  'other memory jobs send stored memories',
] as const;

/** Retired sentences in operator- and API-caller-facing files outside the
 *  public claim files, each kept to one line of its file. */
const RETIRED_OPERATOR_CLAIMS: ReadonlyArray<readonly [file: string, phrase: string]> = [
  // The prompt mask covers the turn's own model requests, not every copy.
  ['middleware/packages/harness-plugin-privacy-guard/manifest.yaml', 'every LLM-bound copy of the turn'],
  // The shield keeps the raw results of data-source tools from the model; the
  // user's own messages are masked only with `mask_user_prompt` on.
  ['middleware/packages/harness-plugin-privacy-guard/manifest.yaml', 'Keeps personal data away from the language model'],
  // Only a failed C0 pass blocks a request: a failed C1 detector falls back to
  // C0 for the rest of the turn, and restoring the real values is best-effort.
  [
    'middleware/packages/harness-plugin-privacy-guard/manifest.yaml',
    'if masking cannot be guaranteed, the turn is blocked rather than sent unmasked',
  ],
  ['middleware/packages/harness-plugin-privacy-guard/manifest.yaml', 'in the final answer and in everything persisted'],
  ['middleware/.env.example', 'clamps all of them back to `guarded`, whatever'],
  ['middleware/.env.example', 'runs a tool again'],
  // A failed call leaves no record and the store evicts its oldest records, so
  // a retry inside the window can run a write again.
  ['middleware/src/mcp/README.md', 'will not execute the tool twice'],
];

describe('public security claims match the enforced behaviour', () => {
  it('retired overclaims are gone from the README, the architecture docs, CITATION.cff, the ADR notes, the operator setup texts and the MCP endpoint guide', () => {
    const hits: string[] = [];
    for (const file of PUBLIC_CLAIM_FILES) {
      const text = flatten(read(file)).toLowerCase();
      for (const phrase of RETIRED_CLAIMS) {
        if (text.includes(phrase.toLowerCase())) hits.push(`${file}: "${phrase}"`);
      }
    }
    for (const [file, phrase] of RETIRED_OPERATOR_CLAIMS) {
      if (flatten(read(file)).toLowerCase().includes(phrase.toLowerCase())) {
        hits.push(`${file}: "${phrase}"`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('the README names the Privacy Shield defaults the code ships, and its limits', () => {
    const readme = read('README.md');

    assert.equal(PRIVACY_MODE_DEFAULT, 'guarded');
    assert.ok(
      /`guarded` (?:by default|is the default)/.test(flatten(readme)),
      'README must name `guarded` as the default privacy mode',
    );

    // Prompt masking is a privacy-guard setting that ships switched off.
    assert.equal(MASK_USER_PROMPT_CONFIG_KEY, 'mask_user_prompt');
    const maskSentences = sentencesMentioning(readme, '`mask_user_prompt`');
    assert.equal(maskDefault(), 'off');
    assert.ok(
      maskSentences.some((sentence) => /\boff\b/i.test(sentence)),
      `README must say that \`mask_user_prompt\` is off by default; mentions: ${JSON.stringify(maskSentences)}`,
    );

    // The subscription-CLI provider installs no shield (security-architecture §3a).
    const cliSentences = sentencesMentioning(readme, '`claude-cli`');
    assert.ok(
      cliSentences.some((sentence) => /shield/i.test(sentence)),
      `README must say that the \`claude-cli\` provider runs without the shield; mentions: ${JSON.stringify(cliSentences)}`,
    );
  });

  it('the docs say that replayed user messages reach the model as typed by default, replayed answers masked', async () => {
    // With the shipped default the guard reports prompt masking `disabled`, and
    // the orchestrator hands the user's own words to the model unchanged
    // (`maskPromptForWire`), the user messages a channel replays in
    // `priorTurns` included. A replayed ANSWER goes through
    // `maskReplayedAnswer` whatever the flag says: an answer the shield
    // rendered carries real values the model never saw.
    const service = createPrivacyGuardService({
      readConfig: (key) => (key === MASK_USER_PROMPT_CONFIG_KEY ? maskDefault() : undefined),
    });
    const turn = { sessionId: 'docs-claims-session', turnId: 'docs-claims-turn' };
    const text = 'Earlier answer: Jane Doe, jane.doe@mail.example, owes 1.234,56 EUR.';
    const asPrompt = await service.maskUserPrompt?.({ ...turn, text });
    assert.equal(asPrompt?.outcome, 'disabled');
    const asAnswer = await service.maskReplayedAnswer?.({ ...turn, text });
    assert.equal(asAnswer?.outcome, 'masked');
    assert.equal(
      asAnswer?.outcome === 'masked' && asAnswer.maskedText.includes('jane.doe@mail.example'),
      false,
      'a replayed answer must reach the model without the e-mail address',
    );

    const readme = read('README.md');
    const historySentences = sentencesMentioning(readme, '`priorTurns`');
    assert.ok(
      historySentences.some(
        (sentence) => /\bas typed\b/i.test(sentence) && /\buser messages\b/i.test(sentence),
      ),
      `README must say that the user messages a channel replays (\`priorTurns\`) reach the model as typed; mentions: ${JSON.stringify(historySentences)}`,
    );
    const answerSentences = sentencesMentioning(readme, 'answers a channel replays');
    assert.ok(
      answerSentences.some(
        (sentence) => /\bmasked\b/i.test(sentence) && /\bwhatever the settings\b|\bon or off\b/i.test(sentence),
      ),
      `README must say that the answers a channel replays are masked whatever the settings; mentions: ${JSON.stringify(answerSentences)}`,
    );
    const security = read('docs/security-architecture.md');
    const replaySentences = sentencesMentioning(security, '`maskReplayedAnswer`');
    assert.ok(
      replaySentences.some(
        (sentence) => sentence.includes('`priorTurns`') && sentence.includes('`mask_user_prompt`'),
      ),
      `docs/security-architecture.md must say that replayed answers go through \`maskReplayedAnswer\` independent of \`mask_user_prompt\`; mentions: ${JSON.stringify(replaySentences)}`,
    );
  });

  it('the docs name the inbound screener and turn scoring as masked, and what the screener gets', () => {
    // The shipping posture screens every turn that carries an upload.
    assert.equal(DEFAULT_SECURITY_POSTURE_POLICY.posture, 'auto');
    // What the screener is handed: the message, each replayed USER message
    // and each upload's name and type — never a replayed answer.
    const pairs = bundleProvenance({
      userMessage: 'Bitte prüfe die Rechnung.',
      priorTurns: [{ userMessage: 'Hier die Rechnung.', assistantAnswer: 'REPLAYED ANSWER' }],
      attachments: [
        { kind: 'file', url: 'https://x/invoice.pdf', name: 'invoice.pdf', mediaType: 'application/pdf' },
      ],
    });
    assert.deepEqual(
      pairs.map((pair) => [pair.source.kind, pair.content]),
      [
        ['direct_human', 'Bitte prüfe die Rechnung.'],
        ['prior_turn', 'Hier die Rechnung.'],
        ['attachment', 'invoice.pdf (application/pdf)'],
      ],
    );

    const readme = read('README.md');
    const screenerSentences = sentencesMentioning(readme, 'inbound security screener');
    assert.ok(
      screenerSentences.some(
        (sentence) => sentence.includes('turn scoring') && sentence.includes("as the turn's model saw and wrote it"),
      ),
      `README must say that the screener and turn scoring get the turn's text as its model saw it; mentions: ${JSON.stringify(screenerSentences)}`,
    );
    assert.ok(
      screenerSentences.some((sentence) => sentence.includes('(`auto`)')),
      `README must name \`auto\` as the posture under which the screener runs; mentions: ${JSON.stringify(screenerSentences)}`,
    );
    const unmasked = sentencesMentioning(readme, 'as it is').filter(
      (sentence) => /screener|turn scoring/.test(sentence),
    );
    assert.deepEqual(unmasked, [], 'README must not list the screener or turn scoring among the calls sent as they are');

    const security = read('docs/security-architecture.md');
    const gateSentences = sentencesMentioning(security, '`screenInboundTurn`');
    assert.ok(
      gateSentences.some(
        (sentence) =>
          sentence.includes('`DEFAULT_SECURITY_POSTURE_POLICY`') &&
          sentence.includes('after the turn minted its privacy handle'),
      ),
      `§6f must say that the screener runs after the handle is minted, under the default posture; mentions: ${JSON.stringify(gateSentences)}`,
    );
    const bundleSentences = sentencesMentioning(security, '`bundleProvenance`');
    assert.ok(
      bundleSentences.some(
        (sentence) => sentence.includes('`priorTurns`') && sentence.includes('never a replayed answer'),
      ),
      `§6f must say what \`bundleProvenance\` carries; mentions: ${JSON.stringify(bundleSentences)}`,
    );
    assert.ok(
      sentencesMentioning(security, '`screeningBundleForWire`').some((sentence) =>
        sentence.includes('`maskPromptForWire`'),
      ),
      '§6f must say that the screening bundle is masked through `maskPromptForWire`',
    );
    assert.ok(
      sentencesMentioning(security, '`TurnIngest.maskedView`').some((sentence) =>
        sentence.includes('never the restored answer'),
      ),
      '§6f must say that the scorer gets the masked view, never the restored answer',
    );
  });

  it('the docs say which memory jobs mask their stored text, and that embeddings are still open', async () => {
    // A memory job outside a turn masks through `openStoredTextScope`, whatever
    // `mask_user_prompt` says (the jobs a turn awaits use `maskReplayedAnswer`,
    // pinned above).
    const service = createPrivacyGuardService({
      readConfig: (key) => (key === MASK_USER_PROMPT_CONFIG_KEY ? maskDefault() : undefined),
    });
    const scope = service.openStoredTextScope?.({ job: 'docs-claims' });
    const masked = await scope?.maskStoredText('Stored memory: jane.doe@mail.example owes 1.234,56 EUR.');
    assert.equal(masked?.outcome, 'masked');
    assert.equal(
      masked?.outcome === 'masked' && masked.maskedText.includes('jane.doe@mail.example'),
      false,
      'a memory job must reach its model without the e-mail address',
    );

    const readme = read('README.md');
    const jobSentences = sentencesMentioning(readme, 'memory jobs');
    assert.ok(
      jobSentences.some(
        (sentence) => /\bmasked\b/i.test(sentence) && /\bwhatever the settings\b|\bon or off\b/i.test(sentence),
      ),
      `README must say that the memory jobs' stored text is masked whatever the settings; mentions: ${JSON.stringify(jobSentences)}`,
    );
    assert.ok(
      sentencesMentioning(readme, 'embedd').some((sentence) => /\bas (?:it is|stored)\b/i.test(sentence)),
      'README must say that embeddings still carry stored text as it is',
    );

    const security = read('docs/security-architecture.md');
    for (const job of [
      'recallRelevanceJudge.ts',
      'sessionSummaryGenerator.ts',
      'topicClustering.ts',
      'inconsistencyDetector.ts',
      'topicDetector.ts',
    ]) {
      assert.ok(security.includes(`\`${job}\``), `docs/security-architecture.md must name the masked memory job \`${job}\``);
    }
    const scopeSentences = sentencesMentioning(security, '`openStoredTextScope`');
    assert.ok(
      scopeSentences.length > 0 && security.includes('**Memory jobs, independent of `mask_user_prompt`.**'),
      `docs/security-architecture.md must say that the memory jobs mask through \`openStoredTextScope\` independent of \`mask_user_prompt\`; mentions: ${JSON.stringify(scopeSentences)}`,
    );
    assert.ok(
      sentencesMentioning(security, 'embeddings included').some((sentence) => /\bopen\b/i.test(sentence)),
      'docs/security-architecture.md must say that masking embeddings is still open',
    );
  });

  it('the docs name the results that reach the model without a digest', async () => {
    const readme = read('README.md');

    // Intern-exempt tools hand their results to the model as returned. The
    // security architecture lists every one of them, the README names
    // `read_attachment`, the one that carries an uploaded file's text.
    const security = read('docs/security-architecture.md');
    const unlisted = [...INTERN_EXEMPT_TOOLS].filter((tool) => !security.includes(`\`${tool}\``));
    assert.deepEqual(unlisted, [], 'docs/security-architecture.md must list every intern-exempt tool');
    assert.ok(INTERN_EXEMPT_TOOLS.has('read_attachment'));
    const exemptSentences = sentencesMentioning(readme, '`read_attachment`');
    assert.ok(
      exemptSentences.some((sentence) => /\bin clear\b/i.test(sentence)),
      `README must say that \`read_attachment\` results reach the model in clear; mentions: ${JSON.stringify(exemptSentences)}`,
    );
    // ...apart from a table, which it refuses: an uploaded table's cells reach
    // the model only through `query_dataset`.
    const refusal = await new ReadAttachmentTool({
      readByStorageKey: async () => ({
        bytes: Buffer.from('name,email\nJane Doe,jane.doe@mail.example\n', 'utf8'),
        contentType: 'text/csv',
        fileName: 'contacts.csv',
      }),
      readByUrl: async () => undefined,
    }).handle({ storage_key: 'uploads/contacts.csv' });
    assert.match(refusal, /^Error: /);
    assert.ok(refusal.includes('query_dataset') && !refusal.includes('jane.doe@mail.example'));
    assert.ok(
      exemptSentences.some((sentence) => /\brefuses\b/i.test(sentence) && sentence.includes('`query_dataset`')),
      `README must say that \`read_attachment\` refuses tables and points to \`query_dataset\`; mentions: ${JSON.stringify(exemptSentences)}`,
    );
    const tableSentences = sentencesMentioning(security, '`query_dataset`');
    assert.ok(
      tableSentences.some((sentence) => /\brefuses\b/.test(sentence) && /\btable\b/i.test(sentence)),
      `docs/security-architecture.md must say that \`read_attachment\` refuses a table; mentions: ${JSON.stringify(tableSentences)}`,
    );

    // A result the shield cannot intern is withheld at every seam: the model
    // reads the kernel's notice instead of the raw result.
    const notice = internFailedNotice('crm_create_record');
    assert.match(notice, /^Error: /);
    assert.match(notice, /\bwithheld\b/);
    assert.ok(
      security.includes('`internFailedNotice`'),
      'docs/security-architecture.md must name the notice that replaces a result the shield could not intern',
    );
  });

  it('receipts are described as best-effort, as the store writes them', () => {
    // A failed insert is counted and rethrown; the orchestrator logs it and
    // completes the turn without a receipt.
    assert.equal(typeof turnReceiptCounters().persistFailures, 'number');
    assert.ok(
      read('docs/security-architecture.md').includes('`persistFailures`'),
      'docs/security-architecture.md must name the receipt failure counter',
    );
    const receiptSentences = sentencesMentioning(read('README.md'), '`/operator/receipts`');
    assert.ok(
      receiptSentences.some((sentence) => /best-effort/i.test(sentence)),
      `README must say that receipts are written best-effort; mentions: ${JSON.stringify(receiptSentences)}`,
    );
  });

  it('the answer verifier ships off, and in shadow mode once switched on', () => {
    assert.equal(ConfigSchema.shape.VERIFIER_ENABLED.parse(undefined), false);
    assert.equal(ConfigSchema.shape.VERIFIER_MODE.parse(undefined), 'shadow');

    const readme = read('README.md');
    const enabledSentences = sentencesMentioning(readme, '`verifier_enabled`');
    assert.ok(
      enabledSentences.some((sentence) => /\boff by default\b/i.test(sentence)),
      `README must call the verifier off by default where it names \`verifier_enabled\`; mentions: ${JSON.stringify(enabledSentences)}`,
    );
    const shadowSentences = sentencesMentioning(readme, '`shadow`');
    assert.ok(
      shadowSentences.some((sentence) => /\bdefault\b/i.test(sentence)),
      `README must name \`shadow\` as the verifier's default mode; mentions: ${JSON.stringify(shadowSentences)}`,
    );
  });

  it('the docs say that the verifier checks only what its trigger patterns match, and enforce delivers the rest unchecked', async () => {
    // A figure in a format the trigger router has no pattern for never reaches
    // the claim extractor: the pipeline reports `skipped` / `no_trigger`, and
    // `enforce` releases that verdict, so the answer goes out unchecked.
    for (const figure of ['USD 50,000', '$500', 'October 2, 2026', '3 unpaid invoices']) {
      assert.equal(shouldTriggerVerifier(figure).shouldVerify, false, figure);
    }
    const extracted: string[] = [];
    const extractor = {
      extract: async (request: { answer: string }) => {
        extracted.push(request.answer);
        return { claims: [], gaps: [] };
      },
    };
    const pipeline = new VerifierPipeline({
      extractor: extractor as unknown as VerifierPipelineOptions['extractor'],
      deterministic: {} as VerifierPipelineOptions['deterministic'],
      judge: {} as VerifierPipelineOptions['judge'],
      log: () => {},
    });
    const unmatched = await pipeline.verify({
      runId: 'docs-claims-run',
      userMessage: 'What does Example Corp still owe?',
      answer: 'Example Corp owes USD 50,000, due October 2, 2026.',
    });
    assert.ok(
      unmatched.status === 'skipped' && unmatched.reason === 'no_trigger',
      `expected skipped / no_trigger, got ${JSON.stringify(unmatched)}`,
    );
    assert.deepEqual(extracted, [], 'an answer no trigger pattern matches must not reach the extractor');
    assert.equal(verdictReleasesAnswer(unmatched), true);
    // A euro amount does reach the extractor.
    await pipeline.verify({
      runId: 'docs-claims-run',
      userMessage: 'Was ist noch offen?',
      answer: 'Offen sind 1.234,56 EUR.',
    });
    assert.equal(extracted.length, 1);

    const triggerSentences = sentencesMentioning(read('README.md'), 'trigger pattern');
    assert.ok(
      triggerSentences.some((sentence) => /\bunchecked\b/i.test(sentence)),
      `README must say that an answer no trigger pattern matches goes out unchecked; mentions: ${JSON.stringify(triggerSentences)}`,
    );
    const gateSentences = sentencesMentioning(read('docs/security-architecture.md'), '`no_trigger`');
    assert.ok(
      gateSentences.some((sentence) => /\bunchecked\b/i.test(sentence)),
      `docs/security-architecture.md must say that \`enforce\` delivers a \`no_trigger\` answer unchecked; mentions: ${JSON.stringify(gateSentences)}`,
    );
  });

  it('plugins are described as hash-pinned, matching a catalog that never reports a signature', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-claims-'));
    try {
      const manifestPath = path.join(dir, 'manifest.yaml');
      // A manifest cannot declare itself signed: the loader has no signature
      // check and reports every entry as unsigned.
      writeFileSync(
        manifestPath,
        [
          'schema_version: "1"',
          'identity:',
          '  id: "@test/claims-fixture"',
          '  name: "Claims Fixture"',
          '  version: "1.0.0"',
          '  kind: "tool"',
          '  domain: "test.claims"',
          '  description: "Synthetic fixture for the docs claims guard."',
          '  signed: true',
          '  signed_by: "publisher.example"',
          'compat:',
          '  core: ">=1.0 <2.0"',
          'lifecycle:',
          '  entry: "dist/plugin.js"',
          '',
        ].join('\n'),
        'utf-8',
      );
      const entry = await loadManifestFromPath(manifestPath, () => {});
      assert.ok(entry, 'fixture manifest must load');
      assert.equal(entry.plugin.signed, false);
      assert.equal(entry.plugin.signed_by, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    for (const file of ['README.md', 'docs/security-architecture.md'] as const) {
      assert.ok(
        /no publisher signature/i.test(flatten(read(file))),
        `${file} must say that plugin packages carry no publisher signature`,
      );
    }
  });

  it('write protection is described as the per-tool contract the core enforces', () => {
    // An unannotated tool counts as read-only, so it gets no idempotency
    // protection either: the core adds no write confirmation of its own.
    assert.equal(isWriteCapableTool(undefined), false);
    assert.equal(isWriteCapableTool([]), false);
    assert.ok(
      read('docs/security-architecture.md').includes('`writeCapabilities`'),
      'docs/security-architecture.md must name the `writeCapabilities` contract',
    );
  });

  it('the idempotency key is described as process-local deduplication within a cache window', async () => {
    // The window and the size bound the docs name.
    assert.equal(DEFAULT_IDEMPOTENCY_TTL_MS, 15 * 60 * 1000);
    assert.equal(DEFAULT_IDEMPOTENCY_MAX_ENTRIES, 1000);
    for (const file of [
      'docs/security-architecture.md',
      'docs/adr/0005-two-phase-confirmation-for-writes.md',
    ] as const) {
      const sentences = sentencesMentioning(read(file), 'process-local deduplication');
      assert.ok(
        sentences.some((sentence) => /15 minutes/.test(sentence) && /1,000 records/.test(sentence)),
        `${file} must name the idempotency window and size bound; mentions: ${JSON.stringify(sentences)}`,
      );
    }

    // A failed call is not cached, and the cache is one process's memory: a
    // second store, like a restarted or second instance, runs the write again.
    let runs = 0;
    const failing = async (): Promise<{ content: string; isError: boolean }> => {
      runs += 1;
      return { content: 'Error: synthetic failure', isError: true };
    };
    const store = new ToolIdempotencyStore();
    await store.run('key-1', 'crm_create_record', { name: 'Example' }, failing, 'principal-1');
    await store.run('key-1', 'crm_create_record', { name: 'Example' }, failing, 'principal-1');
    assert.equal(runs, 2, 'a failed call must not be cached');

    const succeeding = async (): Promise<{ content: string }> => {
      runs += 1;
      return { content: 'ok' };
    };
    await new ToolIdempotencyStore().run('key-2', 'crm_create_record', {}, succeeding, 'principal-1');
    await new ToolIdempotencyStore().run('key-2', 'crm_create_record', {}, succeeding, 'principal-1');
    assert.equal(runs, 4, 'a second store must not know the first store\'s record');
  });
});

/** The `mask_user_prompt` default the privacy guard's manifest ships. */
function maskDefault(): unknown {
  const manifest: unknown = parseYaml(
    read('middleware/packages/harness-plugin-privacy-guard/manifest.yaml'),
  );
  const fields = (manifest as { setup?: { fields?: Array<{ key?: unknown; default?: unknown }> } })
    .setup?.fields;
  return fields?.find((field) => field.key === MASK_USER_PROMPT_CONFIG_KEY)?.default;
}
