# CLAUDE.md — omadia

The binding rules for every agent in this repo live in [`AGENTS.md`](AGENTS.md). This file
only makes Claude Code load them; it adds no rules of its own. Local, gitignored rules in
`CLAUDE.local.md` keep applying alongside it.

@AGENTS.md

Every request is reconciled with the ADRs in [`docs/adr/`](docs/adr/README.md) first; the
procedure is the section "ADR-Abgleich" in `AGENTS.md`.
