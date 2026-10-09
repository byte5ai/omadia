# README guidelines

The root [`README.md`](../README.md) is omadia's landing page on GitHub. It
sells the product to a developer or decision-maker who arrives cold, and hands
them a working install. Everything else lives in `docs/`.
`middleware/test/readmeShape.test.ts` enforces the measurable rules below.

## Why

The reasoning, the sources, the measuring method and the full benchmark
findings are recorded in
[ADR-0011](adr/0011-readme-as-landing-page.md). In short: ten widely starred
open-source READMEs in omadia's space run 100 to 300 lines, keep paragraphs
under about 80 words and put no fine print on the landing page. omadia's
README had 612 lines, an 822-word paragraph and 3.5 hedges per 100 words.

## Dramaturgy

Every benchmark tells the same story in the same order. omadia's README follows
it:

1. **Identity.** Wordmark, claim, a few badges, a nav line. Then one bold
   sentence that names the category and the promise ("Supabase is the Postgres
   development platform", "omadia is a self-hostable, multiplayer agentic OS
   that makes AI dependable enough for real work").
2. **Outcome.** Two or three sentences on who it is for and what they get.
3. **Visual proof.** A screenshot, GIF or video right after the pitch paragraph.
4. **Capabilities.** A scannable list or table: a bold label, then one sentence
   that leads with the outcome. Defaults and limits sit in the linked doc.
5. **Call to action.** A quickstart of one to three commands, with links to the
   full install, deployment and troubleshooting docs.
6. **Depth on demand.** How it works, building on it, a documentation index.
7. **Community and trust.** Status, contributing, security, license, two or
   three lines each.

## Wording

- Lead with what the reader gets, as an active verb addressed to them: "Follow a
  run step by step", "Connect Microsoft 365 …", "Describe an agent in plain
  words, and the Builder …". Avoid opening with a technical subject
  ("`create_xlsx` writes …", "An orchestrator routes …") or a bare noun list.
- Encode a default as an action, not a qualifier: "Switch it on, and omadia
  checks …" rather than "Optional and off by default. Once switched on, it
  checks …" or a trailing "Opt-in.".
- One fact per sentence, 40 words at most. Second person ("your data", "your
  infrastructure").
- Concrete numbers where they are true ("three containers, one command").
- Calm, declarative voice. No superlatives, no em dash, no middle dot, no
  negation-reveal hook ("It's not X, it's Y").
- Every claim stays true without its fine print. When a claim needs a limit to
  be honest, shorten the claim until it does not, and put the limit on the
  linked page. `middleware/test/docsClaimsGuard.test.ts` lists the retired
  overclaims, and it scans the README too.

## Where detail goes

| Content | Document |
|---|---|
| Defaults, scope and limits of the Privacy Shield, verifier, receipts, plugins | [`trust-and-privacy.md`](trust-and-privacy.md) |
| Prerequisites, install variants, first run, optional features, local troubleshooting | [`getting-started.md`](getting-started.md) |
| Cloud targets, production secrets, deployment troubleshooting | [`deployment.md`](deployment.md) |
| Enforcing code paths behind each security claim | [`security-architecture.md`](security-architecture.md) |
| Plugin development | [`creating-plugins.md`](creating-plugins.md) |
| Upgrade steps | [`upgrading.md`](upgrading.md) |
| Operator UI visual language | [`design.md`](design.md) |

A change that adds a default, a limit or a caveat to a capability updates the
linked document, and the README only when the one-sentence claim itself
changes.

## Measurable rules

`readmeShape.test.ts` fails when the README has more than 220 lines, a prose
paragraph over 75 words, a sentence over 40 words, a table cell over 30 words,
a fine-print marker (`unless`, `apart from`, `except`, `best-effort`,
`whatever the settings`, `only when/if/while/once`), or an em dash or middle
dot. Active verbs and outcome-first phrasing are a review rule; no test can
judge them.
