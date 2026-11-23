# omadia UI glossary — which terms stay English in German

The product vocabulary itself is defined in [`docs/terminology.md`](../../docs/terminology.md)
and is binding for every UI text. This file adds the translation layer on top:
which of those terms and which technical nouns stay English in German, and which
German word the UI uses for each defined term.

Issue #601 (findings OM-28/OM-29). The customer's complaint was not "translate
everything". It was sharper than that:

> onboarding addresses "Vertrieb & CRM", "HR & Recruiting", "Finanzen &
> Buchhaltung" — while the detail pages speak to developers.

So the real ask is **a layer between the end user and the systems developer**.
Some English words are that layer working correctly; others are it failing. This
file draws the line once, so translation can be parallelised across namespaces
without the terminology drifting apart.

It is enforced, not advisory: a key whose German value equals the English one
fails `scripts/i18n-validate.mjs` unless it is listed in
`scripts/i18n-identical-allowlist.json` with a reason. `glossary` is one of those reasons and
points here.

## The rule

**Translate the sentence. Keep the noun that names a thing in omadia.**

A German business user reading "Der Agent hat den Turn abgebrochen"
understands the sentence and learns two product nouns. The same user reading
"The agent aborted the turn" learns nothing and feels addressed as a
developer. Inventing "Der Agent hat die Runde abgebrochen" is worse than
either: it is not the word in the docs, not the word in the API, and not the
word another operator will say out loud.

So: **grammar, verbs, and connective prose go to German. Product nouns stay.**

## Terms kept English

| Term | Why |
|---|---|
| **Turn** | One request/response cycle. "Runde"/"Zug" both mean something else in German business software. Appears in traces the operator correlates against logs. |
| **Run** | A single execution of a routine or job. Same reason as Turn — it is a log/trace identifier before it is a word. |
| **Tool** | Already the standard German loanword in this domain, and the API field is `tools`. |
| **Skill** | Standard loanword, and an omadia object type with its own admin surface. |
| **Guard** | A named object in the conductor spec, not a description. |
| **Sycophancy** | A persona metric with a defined scale. No German term exists that a user would recognise; translating it would invent one. |
| **Privacy Shield** | Product name. |
| **Trace**, **Token**, **Cache**, **Stream** | Established German loanwords in this field; the German text uses them as German words. |

## Product terms from `docs/terminology.md`

These are the defined terms. The UI uses exactly these words, in this form, in
every locale. Where the German column differs from English, German texts use the
German word, never the English one.

| English | German | Note |
|---|---|---|
| agent | Agent (plural: Agenten) | A virtual colleague. Never "bot", never "assistant". |
| archetype | Archetyp | Job profile of an agent, fixed at creation. Never "agent type". |
| standard agent | Standard-Agent | An agent of the built-in archetype `standard`. |
| facilitator | Facilitator | An agent of the archetype `facilitator`. |
| default agent | Standard-Ansprechpartner | Answers what nobody addressed. Formerly "fallback agent" / "standard orchestrator". |
| operator | Administrator | The person who runs the instance. |
| user | Nutzer | A human working with agents. |
| capability | Fähigkeit | What an agent is given: system access, a tool, a skill. |
| capability plugin | Fähigkeits-Plugin | Formerly "agent plugin" (kind `agent` is retired). |
| archetype plugin | Archetyp-Plugin | Delivers an archetype, e.g. the facilitator. |
| channel plugin | Kanal-Plugin | Delivers a channel. |
| model plugin | Modell-Plugin | Delivers a model. |
| channel | Kanal | Teams, Slack, Telegram, web chat. |
| model | Modell | The AI an agent thinks with. |
| system module | Systemmodul | Infrastructure of omadia itself (Conductor, memory, omadia Proof). |
| management layer | Verwaltungsebene | The deterministic layer below the agents: routing, permissions, discretion, audit. Never answers. Formerly "orchestrator" in the product sense. |
| agent runtime | Agentenlaufzeit | The code that runs one agent's turns. |
| availability | Verfügbarkeit | Which users may use an agent, in which channels. |
| reach | Reichweite | Every connected system an agent can read or write. |
| grant | Freigabe | Gives one agent one capability. |
| identity / personality / instructions | Identität / Persönlichkeit / Anweisungen | Parts of an agent. |
| working mode | Arbeitsmodus | Formerly "persona skill". |
| internal helper | interner Helfer | Formerly "sub-agent" (towards users). |
| consultation | Rückfrage | One agent asking another. |
| conversation | Gespräch | 1:1 chat, group chat, channel thread, meeting chat. |
| selection | Auswahl | A user's stored choice of an agent for one conversation. |
| binding | Zuordnung | A configured link from a conversation to one agent. |
| trigger | Auslöser | Hook, wakeup or timer. |
| Agent Builder, Plugin Builder | Agent Builder, Plugin Builder | Product names, stay English. |

**"Orchestrator" is retired.** It is a code name of the agent runtime package and
appears in identifiers only. In texts, say **agent** when the thing a person talks
to is meant, and **management layer** (German: Verwaltungsebene) when the
deterministic layer below the agents is meant. `app/_lib/noOrchestratorTerm.test.ts`
fails on any message or readable source string that still says it.

## Terms that must be German

Everything that is a **state, an action, or a description** — because that is the
prose the user reads, not a name they need to recognise elsewhere:

| English | German |
|---|---|
| optional / required | optional / erforderlich |
| ready | bereit |
| idle | inaktiv |
| reconnecting | verbindet neu |
| stuck | hängt |
| unset | nicht gesetzt |
| strict | strikt |
| input / output | Eingabe / Ausgabe |
| preview | Vorschau |
| template | Vorlage |
| title / subtitle | Titel / Untertitel |
| sessions | Sitzungen |
| cached | zwischengespeichert |
| core / extended | Kern / Erweitert |
| custom notes | Eigene Notizen |
| score multiplier | Score-Multiplikator |
| excerpts | Auszüge |

Job phases (`analyze`, `plan`, `clarify`, `implement`, …) are **descriptions of
what is happening**, not identifiers the user correlates elsewhere, so they are
German: Analyse, Planung, Klärung, Umsetzung. `Bootstrap`, `Gate`, `Review` and
`PR` stay as loanwords but take German noun capitalisation — which is what makes
them German rather than untranslated.

## What is never translated

Placeholders, code, and diagnostics. A form hint showing `github_pat_…` or
`acme` teaches a **format**; localising it teaches a wrong value. An install
command is copied and executed verbatim. A raw API field name echoed for support
(`skippedInvolved`) has to match the logs or it stops being useful for the one
job it has. These carry the `placeholder` / `code` / `diagnostic` reason codes in
`scripts/i18n-identical-allowlist.json` rather than `glossary`.

## Adding a term

Extend the table here **and** add the key to `scripts/i18n-identical-allowlist.json` with
reason `glossary`. Two edits on purpose: the allowlist is what CI reads, this
file is what the next person reads to understand why.
