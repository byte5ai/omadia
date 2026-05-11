# `/memories/_rules/` — gepflegte Regeln aus dem Repo

Dateien hier werden beim Start aus `middleware/seed/memory/_rules/` in den
Memory-Store kopiert. Verhalten hängt von `MEMORY_SEED_MODE` ab:

- `missing` (Default): nur kopieren, wenn das Ziel noch nicht existiert.
- `overwrite`: immer mit der Repo-Version überschreiben — für harte Regeln,
  die nicht durch Claude oder manuelle API-Calls verändert werden sollen.
- `skip`: kein Seeding.

Der Assistent wird im System-Prompt instruiert, Dateien unter `_rules/` nicht
eigenständig zu überschreiben — nur ergänzen, wenn der Nutzer das ausdrücklich
bestätigt.
