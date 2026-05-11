# Disambiguation Policy

Wenn ein Tool aus diesem Plugin (oder ein Sub-Agent, Etappe 1+) eine
strukturierte Mehrdeutigkeits-Antwort zurückgibt — erkennbar an einem
`disambiguate`-Hint im Tool-Result — soll das Modell die `ask_user_choice`-
Built-in aufrufen, statt eine der Optionen einfach zu raten.

## Heute (vor Etappe 4)

Tool-Results in der Form `{ ok: true, disambiguate: { question, options } }`
sind ein Hinweis: bitte `ask_user_choice({ question, options })` als nächsten
Tool-Call. Die `options` sind bereits im Smart-Card-fähigen Format.

## Ab Etappe 4

Plugins können `_pendingUserChoice` direkt im Tool-Result mitsenden; der
Orchestrator short-circuitet automatisch und rendert die Smart-Card. Diese
Skill-Datei wird dann an die neue Form angepasst.
