# Disambiguation Policy

Tools dieses Plugins melden Mehrdeutigkeit über `_pendingUserChoice` im
Tool-Result; der Orchestrator beendet den Turn dann selbst und rendert die
Smart-Card mit den Optionen. Rate in diesem Fall keine der Optionen.

Ein Klick auf eine Option startet einen frischen Turn mit dem gewählten
`value` als User-Message — die Auflösung kommt also als neue Eingabe zurück,
nicht als Fortsetzung desselben Turns.
