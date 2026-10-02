# Disambiguation Policy

Tools dieses Plugins melden Mehrdeutigkeit über `_pendingUserChoice` im
Tool-Result. Ruft der Orchestrator das Tool selbst auf und interniert der
Privacy Shield das Ergebnis nicht, beendet er den Turn und rendert die
Smart-Card mit den Optionen. Rate in keinem Fall eine der Optionen: Kommt
keine Karte, frag den Nutzer, welche er meint.

Ein Klick auf eine Option startet einen frischen Turn mit dem gewählten
`value` als User-Message — die Auflösung kommt also als neue Eingabe zurück,
nicht als Fortsetzung desselben Turns.
