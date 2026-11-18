# 0011 — The root README is a landing page; detail lives in `docs/`

## Status

Accepted

- **Date:** 2026-10-09
- **Deciders:** Product owner (omadia), docs maintainers
- **Supersedes:** the section order agreed in issue #400 (quickstart above the
  pitch video)

## Context and Problem Statement

By October 2026 the root `README.md` had grown to 612 lines and 5,300 words.
Its opening paragraph ran 38 lines, and single table cells held up to 308
words. Most of that text listed the limits of the Privacy Shield and the
answer verifier.

The growth had a structural cause. PR #1269 added
`middleware/test/docsClaimsGuard.test.ts`, which ties public security claims to
the code. Its positive checks read the README itself, so every later change to
a default or a limit had to add a sentence there: #1265, #1277, #1281, #1282,
#1284 and #1367 each did. The statements were accurate. In that place they
buried the product.

The README is the first page a developer or decision-maker sees on GitHub.
The question: **what belongs in the README, and where do defaults, limits and
guides go so that they stay accurate and tested?**

## Decision Drivers

- The README has to explain and sell omadia to someone who arrives cold, and
  hand them a working install.
- Every security statement stays true and stays tied to the code by a test.
- The shape must hold over time, so a later change does not regrow the walls.
- omadia's copy voice: calm, declarative, short sentences, no em dash, no
  middle dot, no negation-reveal hook.

## Sources

Benchmark READMEs, fetched on 2026-10-09 through the GitHub API
(`GET /repos/{owner}/{repo}/readme`, default branch): n8n-io/n8n,
mastra-ai/mastra, twentyhq/twenty, langgenius/dify, PostHog/posthog,
supabase/supabase, open-webui/open-webui, langfuse/langfuse, calcom/cal.com,
activepieces/activepieces. They were picked as widely starred open-source
projects in omadia's space (agents, AI apps, self-hosted business software).

Earlier omadia README work this decision builds on: #211 and #212
(conversion-focused hero, capability list), #369 and #373 to #375
(differentiators, wordmark banner, inline pitch video, copy cleanup), #377
(multiplayer in the opening sentence), #400 (quickstart order), #408 (table
label layout).

Facts used in the README copy: the plugin catalog of the omadia hub
(`https://hub.omadia.ai/registry/index.json`, 30 plugins on 2026-10-09),
the pilot page `https://omadia.ai/contact`, and the existing docs.

## Method

For each README, code blocks and HTML comments were removed first. Then:

- **Lines, words:** of the raw file and of the text outside code blocks.
- **Longest paragraph:** longest block between blank lines that is prose, so
  not a heading, list, table, HTML block or badge line. Link targets do not
  count as words.
- **Longest table cell:** in words.
- **Hedges per 100 words:** occurrences of `only`, `unless`, `apart from`,
  `except`, `not`, `never`, `without`, `best-effort`, `whatever the settings`,
  `off by default`, `default off`, `cannot`, `no` in the first 400 prose words.
- **"You" per 100 words:** `you` and `your` in the same 400 words.
- **Section order and wording:** read by hand: opening paragraph, the first
  feature bullets, and the sequence of headings.

## Findings

### Size and form

| README | Lines | Words | Longest paragraph | Longest table cell | Hedges / 100 words | "You" / 100 words |
|---|---|---|---|---|---|---|
| n8n | 73 | 479 | 128 | none | 0.5 | 1.5 |
| mastra | 107 | 685 | 57 | none | 0.0 | 3.2 |
| Twenty | 172 | 745 | 51 | none | 0.2 | 1.5 |
| Dify | 178 | 945 | 62 | none | 0.0 | 3.2 |
| PostHog | 178 | 1,260 | 81 | 2 | 0.5 | 4.8 |
| Supabase | 288 | 1,002 | 196¹ | none | 0.5 | 2.5 |
| Open WebUI | 263 | 2,050 | 72 | none | 0.0 | 1.0 |
| Langfuse | 392 | 3,138 | 55 | 22 | 0.5 | 3.2 |
| cal.com² | 837 | 4,197 | 251 | 31 | 2.5 | 2.2 |
| Activepieces | 488 | 4,291 | 55 | none | 0.5 | 2.2 |
| **omadia before** | **612** | **5,300** | **822** | **308** | **3.5** | **2.0** |

¹ Mostly the translations list. ² The README of a community fork that doubles
as its developer guide; an outlier, not a model.

The typical benchmark has 100 to 300 lines, paragraphs of 50 to 80 words,
almost no table cells over 20 words, an average sentence of 15 to 20 words,
and close to zero hedges in its first 400 words.

### Order of sections

All benchmarks follow one sequence: identity, outcome, visual proof,
capabilities, call to action, depth, community.

- **Identity in one sentence.** "Supabase is the Postgres development
  platform." "PostHog is your product's context layer." "Twenty is the CRM you
  build, ship, and version like the rest of your stack." omadia's own sentence
  ("a self-hostable, multiplayer agentic OS that makes AI dependable enough
  for real work") already met this standard.
- **Visual proof right after the opening.** n8n, Supabase, PostHog, Langfuse
  and Twenty place a screenshot, GIF or video directly below the first
  paragraph.
- **Capabilities, then the install.** n8n, mastra, Twenty, PostHog and
  Langfuse list capabilities before the quickstart; Dify puts the quickstart
  first.
- **Depth on demand.** Documentation index, community channels, license, each
  short.

omadia before: Prerequisites and a production-secrets warning came first, and
the opening sentence was followed by 33 lines of exceptions.

### Wording

- **Capabilities lead with the outcome and an active verb.** n8n: "Connect to
  OpenAI, Anthropic, Google, or open-source models and switch providers
  without changing your architecture." mastra: "Connect to 40+ providers
  through one standard interface." omadia before: "Optional and off by
  default. Once switched on, it checks …"
- **Concrete numbers as proof.** "1500+ integrations", "40+ providers",
  "self-hosted in minutes", "in under a minute".
- **Second person and short sentences.** "You" or "your" appears 1 to 5 times
  per 100 words.
- **No fine print on the landing page.** Limits and defaults sit in the linked
  docs. The pitch stays honest because each claim is true without fine print.

## Considered Options

- **A — Keep the limits in the README** and only tighten the wording.
- **B — Move every security statement out** and leave the README without trust
  claims.
- **C — Landing page plus a dedicated trust page.** The README carries short,
  true claims and links `docs/trust-and-privacy.md`, which holds the defaults
  and limits verbatim. The guard test reads that page.

## Decision Outcome

Chosen option: **C**, because it is the only option that serves both the
reader and the guard. Option A keeps the walls: every limit sentence must stay
somewhere, and the README is the wrong place for it. Option B hides omadia's
strongest differentiators, the Privacy Shield and the answer verifier.

The rules that follow from it are written down in
[`docs/readme-guidelines.md`](../readme-guidelines.md):

1. The README follows the benchmark order: identity, visual proof,
   capabilities, pitch video, quickstart, how it works, docs index, status,
   community, license.
2. Each capability is one bold label linked to its doc, then one or two
   sentences that open with what the reader gets, as an active verb.
3. A default is written as an action ("Switch it on, and omadia checks …"),
   not as a qualifier ("Opt-in.").
4. Numbers only where they are true and sourced (hub catalog, container count).
5. Defaults and limits go to `docs/trust-and-privacy.md`; install and
   troubleshooting to `docs/getting-started.md`; cloud targets and production
   secrets to `docs/deployment.md`.
6. No em dash, no middle dot, no negation-reveal hook.

### Consequences

- 🟢 **Good:** The README reads as a pitch again: 163 lines instead of 612,
  the longest paragraph 70 words instead of 822.
- 🟢 **Good:** No security statement was lost. The trust page carries the
  former README text verbatim, and `docsClaimsGuard.test.ts` checks it there.
  Its retired-overclaim scan still covers the README.
- 🟢 **Good:** `middleware/test/readmeShape.test.ts` keeps the shape: at most
  220 lines, prose paragraphs of at most 75 words, sentences of at most 40
  words, table cells of at most 30 words, no fine-print markers, no em dash
  or middle dot.
- 🔴 **Bad:** A reader who wants the limits needs one click more. The README
  links the trust page next to the capabilities for that reason.
- ⚪ **Neutral:** A change to a default or a limit now updates
  `docs/trust-and-privacy.md`. The README changes only when the one-sentence
  claim itself changes.
- ⚪ **Neutral:** Active verbs and outcome-first wording are a review rule. No
  test can judge them.

## More Information

- Rules: [`docs/readme-guidelines.md`](../readme-guidelines.md)
- Trust page: [`docs/trust-and-privacy.md`](../trust-and-privacy.md)
- Guards: `middleware/test/docsClaimsGuard.test.ts`,
  `middleware/test/readmeShape.test.ts`
- Implementation: PR #1368
