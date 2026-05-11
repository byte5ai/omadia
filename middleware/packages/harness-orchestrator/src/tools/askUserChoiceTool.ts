import { z } from 'zod';

export const ASK_USER_CHOICE_TOOL_NAME = 'ask_user_choice';

const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const LABEL_MAX = 40;
const VALUE_MAX = 200;
const QUESTION_MAX = 500;
const RATIONALE_MAX = 280;

const AskUserChoiceOptionSchema = z.object({
  label: z.string().min(1).max(LABEL_MAX),
  value: z.string().min(1).max(VALUE_MAX).optional(),
});

const AskUserChoiceInputSchema = z
  .object({
    question: z.string().min(3).max(QUESTION_MAX),
    options: z.array(AskUserChoiceOptionSchema).min(MIN_OPTIONS).max(MAX_OPTIONS),
    rationale: z.string().max(RATIONALE_MAX).optional(),
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

export type AskUserChoiceInput = z.infer<typeof AskUserChoiceInputSchema>;

export interface PendingUserChoice {
  question: string;
  rationale?: string;
  options: Array<{ label: string; value: string }>;
}

export const askUserChoiceToolSpec = {
  name: ASK_USER_CHOICE_TOOL_NAME,
  description:
    'Stellt dem User eine Rückfrage mit 2–4 vordefinierten Antwort-Buttons (Smart Card). Der aktuelle Turn endet sofort nach dem Call; ein Klick erzeugt einen neuen User-Turn mit dem Label als Eingabe.\n' +
    '\n' +
    '**Wann nutzen:**\n' +
    '- User-Eingabe ist genuin mehrdeutig UND es gibt eine endliche Menge plausibler Interpretationen (z.B. zwei Module tracken Umsatz → Sales vs. POS vs. Beides).\n' +
    '- Du müsstest sonst raten und riskierst eine falsche Fachagent-Delegation.\n' +
    '\n' +
    '**Wann NICHT nutzen:**\n' +
    '- Du kannst die Intention vernünftig aus Kontext erschließen → direkt antworten oder delegieren.\n' +
    '- Offene Fragen ohne klare Option-Menge ("was meinst du mit X?") → stelle sie als Freitext, nicht als Button-Card.\n' +
    '- Trivial-Bestätigungen ("soll ich…?") — führe die Aktion aus, der User kann widersprechen.\n' +
    '- Follow-ups, bei denen der verbatim-Kontext bereits eindeutig ist.\n' +
    '\n' +
    '**Regeln:**\n' +
    '- Genau 2–4 Optionen. Labels max 40 Zeichen, einzigartig, kurze Verben/Substantive ("Sales", "POS", "Beide").\n' +
    '- `value` ist optional; wird geklickt, wird `value ?? label` als neuer User-Input in die Konversation injiziert.\n' +
    '- `rationale` (optional, max 280 Zeichen): eine Zeile, warum du fragst. Wird unter der Frage angezeigt.\n' +
    '- Maximal **1×** pro Turn — der Turn endet nach dem Call.\n' +
    '- Ruf das Tool NICHT zusätzlich zu `render_diagram` oder Fachagent-Delegation auf — die Card verdrängt sonst andere Outputs.',
  input_schema: {
    type: 'object' as const,
    properties: {
      question: {
        type: 'string',
        description: 'Die Rückfrage (Markdown erlaubt). 3–500 Zeichen.',
      },
      rationale: {
        type: 'string',
        description:
          'Optional. Ein Satz zur Begründung, warum du fragst (max 280 Zeichen).',
      },
      options: {
        type: 'array',
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description:
          'Zwischen 2 und 4 Optionen. Labels müssen einzigartig sein.',
        items: {
          type: 'object',
          required: ['label'],
          properties: {
            label: {
              type: 'string',
              description: 'Button-Text. Max 40 Zeichen.',
            },
            value: {
              type: 'string',
              description:
                'Optional. Der Wert, der bei Klick als neuer User-Input injiziert wird. Default: label.',
            },
          },
        },
      },
    },
    required: ['question', 'options'],
  },
};

/**
 * Orchestrator-side handler for `ask_user_choice`. Stores the validated
 * request on an instance field; the Orchestrator drains it after the current
 * tool batch finishes and terminates the turn early without issuing a new
 * Anthropic request. Mirrors the `DiagramTool.takeLastRender()` drain pattern.
 *
 * The tool's string return is fed back to the model only for the current
 * batch iteration's sake — since the orchestrator short-circuits afterwards,
 * the model never sees it in a follow-up iteration. Still useful for the
 * session log + dev-UI trace.
 */
export class AskUserChoiceTool {
  private pending: PendingUserChoice | undefined;

  async handle(input: unknown): Promise<string> {
    // First-call-wins guard. With parallel tool dispatch in the orchestrator,
    // a second `ask_user_choice` call inside the same iteration would race
    // the first and could overwrite the pending payload non-deterministically.
    // Spec is "max 1× per turn" anyway; the second call gets a no-op signal
    // so the model sees the rejection in the message log without disturbing
    // the choice card already queued by the first call.
    if (this.pending !== undefined) {
      return JSON.stringify({
        status: 'choice_card_already_scheduled',
        note:
          'ask_user_choice wurde in diesem Turn bereits aufgerufen — nur der erste Call zählt. Lass weitere Aufrufe weg.',
      });
    }
    const parsed = AskUserChoiceInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid ask_user_choice input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }
    const { question, options, rationale } = parsed.data;
    this.pending = {
      question,
      ...(rationale ? { rationale } : {}),
      options: options.map((o) => ({
        label: o.label,
        value: (o.value ?? o.label).slice(0, VALUE_MAX),
      })),
    };
    return JSON.stringify({
      status: 'choice_card_scheduled',
      optionCount: this.pending.options.length,
      note:
        'Die Rückfrage wird als Smart Card an den User gerendert. Der Turn endet hier; du bekommst die Auswahl im nächsten Turn als User-Nachricht.',
    });
  }

  /**
   * Returns and clears the pending user-choice, if any. Idempotent: a second
   * call in the same turn (or one without a prior `handle()`) returns undefined.
   */
  takePending(): PendingUserChoice | undefined {
    const p = this.pending;
    this.pending = undefined;
    return p;
  }

  hasPending(): boolean {
    return this.pending !== undefined;
  }
}
