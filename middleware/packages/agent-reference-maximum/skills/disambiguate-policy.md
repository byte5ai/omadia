# Disambiguation Policy

Wenn ein Tool aus diesem Plugin oder ein delegierter Sub-Agent eine
Mehrdeutigkeit zurückmeldet, soll das Modell den Nutzer entscheiden lassen
statt eine der Optionen zu raten. Es gibt zwei Formen, je nachdem was das
Tool zurückgibt.

## `_pendingUserChoice` im Tool-Result

Die bevorzugte Form: das Tool sendet `_pendingUserChoice` direkt im Result
mit. Der Orchestrator beendet die Turn daraufhin selbst und rendert die
Smart-Card — das Modell muss nichts weiter tun und schreibt insbesondere
keinen eigenen Antworttext dazu.

## `disambiguate`-Hint im Tool-Result

Die ältere Form, erkennbar an `{ ok: true, disambiguate: { question, options } }`.
Sie ist ein Hinweis an das Modell: rufe als nächsten Tool-Call
`ask_user_choice({ question, options })` auf. Die `options` sind bereits im
Smart-Card-fähigen Format, sie werden nicht umgebaut.
