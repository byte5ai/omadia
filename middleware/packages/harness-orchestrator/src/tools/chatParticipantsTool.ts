import type { ChatParticipant, ChatPeerAgentsProvider } from '../chatParticipants.js';
import { turnContext } from '../turnContext.js';

export const CHAT_PARTICIPANTS_TOOL_NAME = 'get_chat_participants';

export const chatParticipantsToolSpec = {
  name: CHAT_PARTICIPANTS_TOOL_NAME,
  description:
    'Liefert die Teilnehmer des aktuellen Teams-Chats für @-Mentions.\n' +
    '\n' +
    '**PFLICHT-SYNTAX nach dem Call:** Schreib im Antworttext den Namen EXAKT so: `<at>Max Mustermann</at>`. Der Middleware-Renderer baut daraus die Teams-Mention-Entity und zeigt die blaue @-Pille. Ohne diese Tags erscheint nur Plain-Text — die Person wird NICHT benachrichtigt.\n' +
    '\n' +
    '**Byte-für-byte-Regel:** `Max Mustermann` MUSS 1:1 dem `displayName`-Feld aus der Tool-Response entsprechen. Inklusive Firmensuffix, Sonderzeichen, Groß-/Kleinschreibung. Keine Nicknames, keine Kürzungen. Wenn der `displayName` "Jane Doe - ACME" lautet, schreib `<at>Jane Doe - ACME</at>` — nicht `<at>Jane Doe</at>`.\n' +
    '\n' +
    'Wann nutzen:\n' +
    '- Wenn du jemanden direkt ansprechen willst (Handoff, Rückfrage, Zuständigkeitsverweis).\n' +
    '- Maximal 1× pro Turn.\n' +
    '\n' +
    'Wann NICHT nutzen:\n' +
    '- 1:1-Chats (Bot + ein User) — keine Mentions, der User liest ohnehin.\n' +
    '- Rein informative Antworten ohne direkten Personen-Bezug.\n' +
    '\n' +
    'Response:\n' +
    '- `participants[]` mit `displayName`, `channelUserId`, `email`, `aadObjectId`, `kind` (`human` | `agent`).\n' +
    '- Einträge mit `kind: "agent"` sind andere omadia-Agenten mit eigenem Bot in diesem Chat, die für Agent-zu-Agent-Gespräche freigeschaltet sind; ihr `agentSlug` ist der Name für `discussion_start`. Sie werden NICHT per @-Mention angesprochen.\n' +
    '- `usage_example` — eine Copy-Paste-Zeile mit echtem `displayName` aus diesem Chat, die zeigt wie die Mention im Antworttext aussehen muss.\n' +
    '\n' +
    'Bei leerem `participants[]`: einfach ohne Mention antworten, nicht blockieren.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
};

/**
 * Tool handler: reads the roster via the TurnContext-provided accessor.
 * Returns an error string when invoked outside a Teams turn (no provider
 * wired) — the model can recover by simply not using a mention.
 */
export class ChatParticipantsTool {
  /**
   * #1018 — `peerAgents` resolves the peer AGENTS the calling agent may see
   * here (kernel service `chatPeerAgents@1`, resolved per call by the plugin).
   * Absent or failing → humans only, exactly the pre-#1018 roster: a peer
   * lookup must never cost a human mention.
   */
  constructor(private readonly deps: { peerAgents?: ChatPeerAgentsProvider } = {}) {}

  private async peers(): Promise<ChatParticipant[]> {
    if (!this.deps.peerAgents) return [];
    try {
      return await this.deps.peerAgents();
    } catch {
      return [];
    }
  }

  async handle(): Promise<string> {
    const ctx = turnContext.current();
    const provider = ctx?.chatParticipants;
    if (!provider) {
      return 'Error: chat-participants provider not available in this turn (probably not a Teams turn).';
    }
    try {
      const humans = await provider();
      const peers = await this.peers();
      // Peers merge in AFTER the platform roster and never shadow a human
      // entry; a roster that (unusually) already lists a bot keeps its own row.
      const seen = new Set(humans.map((m) => m.channelUserId));
      const members: ChatParticipant[] = [
        ...humans,
        ...peers.filter((p) => !seen.has(p.channelUserId)),
      ];
      if (members.length === 0) {
        return JSON.stringify({
          participants: [],
          note: 'Roster leer — entweder keine Teilnehmer sichtbar oder fehlende Berechtigung. Formuliere ohne @-Mention.',
        });
      }
      // Pick a human participant for the example so it's obvious how the
      // mention should look. Bots usually have `aadObjectId: null`; a human
      // roster entry has one. Fall back to the first member if all look bot-y.
      const example =
        members.find((m) => m.kind !== 'agent' && m.aadObjectId !== null) ??
        members.find((m) => m.kind !== 'agent') ??
        members[0];
      const exampleName = example?.displayName ?? 'Display Name';
      return JSON.stringify({
        participants: members.map((m) => ({
          channelUserId: m.channelUserId,
          displayName: m.displayName,
          email: m.email,
          aadObjectId: m.aadObjectId,
          kind: m.kind ?? 'human',
          ...(m.kind === 'agent' && m.agentSlug ? { agentSlug: m.agentSlug } : {}),
        })),
        usage_example: `<at>${exampleName}</at>`,
        rendering_rule:
          'Schreib den Namen im Antworttext EXAKT in dieser Form, byteweise identisch zum `displayName`. Ohne die <at>…</at>-Tags wird KEINE Mention gerendert und die Person NICHT benachrichtigt.',
      });
    } catch (err) {
      return `Error: roster fetch failed — ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
