import { z } from 'zod';

export const SUGGEST_FOLLOW_UPS_TOOL_NAME = 'suggest_follow_ups';

const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const LABEL_MAX = 40;
const PROMPT_MAX = 500;

const FollowUpOptionSchema = z.object({
  label: z.string().min(1).max(LABEL_MAX),
  prompt: z.string().min(3).max(PROMPT_MAX),
});

const SuggestFollowUpsInputSchema = z
  .object({
    options: z.array(FollowUpOptionSchema).min(MIN_OPTIONS).max(MAX_OPTIONS),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.options.forEach((opt, idx) => {
      const key = opt.label.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', idx, 'label'],
          message: `duplicate label \`${opt.label}\``,
        });
      }
      seen.add(key);
    });
  });

export type SuggestFollowUpsInput = z.infer<typeof SuggestFollowUpsInputSchema>;

export interface FollowUpOption {
  /** Short button label (≤40 chars). */
  label: string;
  /** Full user-message submitted on click; must stand alone so the LLM
   *  doesn't need conversational context to answer it. */
  prompt: string;
}

export const suggestFollowUpsToolSpec = {
  name: SUGGEST_FOLLOW_UPS_TOOL_NAME,
  description:
    'Hängt 2–4 1-Klick-Refinement-Buttons unter die Antwort. Nutze das bei Top-N / Ranking / Trend / Aggregat-Fragen wo der User wahrscheinlich eine Variante des gleichen Reports sehen will (anderer Zeitraum, andere Basis, Brutto/Netto). **Nicht-blockierend** — du antwortest normal weiter; die Buttons erscheinen zusätzlich unter der Antwort.\n' +
    '\n' +
    '**Wann nutzen:**\n' +
    '- Top-N-Auswertungen (Top 5 Kunden, Top 10 Lieferanten) → Varianten: andere Basis (Umsatz/DB/Anzahl), anderer Zeitraum.\n' +
    '- Zeitraum-Aggregate (Umsatz Q1, offene Posten per Monatsende) → Varianten: Vorjahr, Rolling-12M, enger/weiter gefasster Scope.\n' +
    '- Strategische Fragen mit mehreren plausiblen Blickwinkeln.\n' +
    '\n' +
    '**Wann NICHT nutzen:**\n' +
    '- Trivial-Antworten (Ja/Nein, kurze Fakten, 1-Klick-Lookups).\n' +
    '- Wenn du gleichzeitig `ask_user_choice` aufrufst — Choice-Card hat Vorrang.\n' +
    '- Reine Informations-Antworten ohne naheliegende Varianten.\n' +
    '- Mehr als 1× pro Turn.\n' +
    '\n' +
    '**Regeln:**\n' +
    '- 2–4 Optionen, Labels ≤40 Zeichen, einzigartig.\n' +
    '- Jedes `prompt` ist eine **vollständige, eigenständige User-Frage** — nicht "Q1 only", sondern "Top 5 Kunden nach Umsatz in Q1 2026". Bei Klick wird dieser Text 1:1 als neue User-Nachricht gesendet.\n' +
    '- Die Varianten sollen **tatsächlich andere Daten liefern** — keine reinen Umformulierungen.\n' +
    '- Dieser Tool-Call beendet den Turn NICHT. Schreib deine normale Antwort zu Ende.',
  input_schema: {
    type: 'object' as const,
    properties: {
      options: {
        type: 'array',
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description:
          '2–4 Follow-Up-Vorschläge. Jede Option bekommt einen Button unter der Antwort.',
        items: {
          type: 'object',
          required: ['label', 'prompt'],
          properties: {
            label: {
              type: 'string',
              description: 'Button-Text (max 40 Zeichen, kurz + aussagekräftig).',
            },
            prompt: {
              type: 'string',
              description:
                'Vollständige User-Frage, die bei Klick als neue Nachricht gesendet wird. Muss ohne Chat-Kontext verständlich sein.',
            },
          },
        },
      },
    },
    required: ['options'],
  },
};

/**
 * Orchestrator-side handler for `suggest_follow_ups`. Unlike
 * `AskUserChoiceTool`, this is **non-blocking** — the turn runs to
 * completion, and the stored suggestions are drained as a sidecar on the
 * final `done` event. The LLM invokes it alongside (not instead of) its
 * natural answer.
 *
 * Last-call-wins semantics if invoked multiple times, to keep the final
 * button set consistent with whichever call the LLM "settled on".
 */
export class SuggestFollowUpsTool {
  private pending: FollowUpOption[] | undefined;

  async handle(input: unknown): Promise<string> {
    const parsed = SuggestFollowUpsInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid suggest_follow_ups input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    this.pending = parsed.data.options.map((o) => ({
      label: o.label,
      prompt: o.prompt,
    }));
    return JSON.stringify({
      status: 'follow_ups_scheduled',
      optionCount: this.pending.length,
      note:
        'Buttons werden unter deine Antwort gehängt. Schreib deine normale Antwort zu Ende.',
    });
  }

  /**
   * Return and clear the pending follow-ups. Idempotent: a second call in
   * the same turn (or a turn without any prior `handle()`) returns undefined.
   */
  takePending(): FollowUpOption[] | undefined {
    const p = this.pending;
    this.pending = undefined;
    return p;
  }
}
