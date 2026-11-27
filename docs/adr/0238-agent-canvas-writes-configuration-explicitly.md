# 0238 — Agent Canvas deletes configuration with confirmation and grants individual MCP tools

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** W21 cluster lead
- **Related:** [ADR-0016](0016-least-privilege-and-the-agent-envelope.md), [ADR-0018](0018-consultation-instead-of-delegation.md), [ADR-0159](0159-web-ui-i18n-plain-json-catalogs-and-ratchets.md)

## Context and Problem Statement

Canvas edges represent persisted configuration. Deleting one can remove the helper and its tool grants. An edge to an MCP server also looked like a grant while having no corresponding authority at runtime.

## Decision Outcome

The canvas confirms which persisted items a deletion affects. It sends one request per affected edge, with a helper's removal covering its own grants, and reloads the server graph after the operation, including partial failure. Agents, shared skills, and MCP servers remain managed in their own surfaces. A working-mode edge detaches the skill from the named agent.

MCP grants identify an individual tool and server. Wiring a server node directly is rejected in the canvas and by the graph route. Operators grant a tool from the toolbox through the existing checks. Existing channel bindings remain visible on the graph.

## Considered Options

- Keep generic graph operations and let the runtime interpret them.
- Confirm destructive edits and require explicit tool-level authority. Chosen so the canvas and the saved configuration mean the same thing.

## More Information

Issues #1799, #1800, and #1802.
