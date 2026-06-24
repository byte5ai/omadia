# Root Cause Analyses

This directory records root cause analyses (RCAs) for operational incidents in
**omadia**: production outages, release quirks, and data issues worth learning
from.

An RCA captures what broke, why, and what stops it from happening again. It is
the operational counterpart to an [ADR](../adr/). An ADR explains a design
decision; an RCA explains an incident.

## Why we keep RCAs

- Turn a one-time firefight into durable knowledge.
- Give new operators the "why" behind a guard or an alert.
- Signal that incidents are handled in the open.

## Writing a new RCA

1. Copy [`0000-template.md`](0000-template.md) to the next free number:
   `NNNN-short-kebab-title.md`.
2. Fill in Summary, Impact, Root cause, Timeline, Fix, and Prevention.
3. Keep it blameless: focus on systems and causes, not individuals.
4. Add a row to the index below.

## Index

| #    | Title       | Date       |
| ---- | ----------- | ---------- |
| _none yet_ |       |            |
