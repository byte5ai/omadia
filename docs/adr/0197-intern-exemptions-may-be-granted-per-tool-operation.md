# 0197 — Intern exemptions may be granted per tool operation

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner (byte5), wave 5 cluster W05-06 (#1866, #1967); decided per the
  recheck recommendation, reversible
- **Supersedes:** —; refines [ADR-0094](0094-privacy-shield-data-plane-boundary.md), which
  names the fixed whole-tool allowlist as a known cost

## Context and Problem Statement

Under the Privacy Shield every tool result is interned to a digest unless the tool is on
`INTERN_EXEMPT_TOOLS` (`harness-orchestrator/src/privacyInternPolicy.ts`). The list is
keyed on the tool name only. `query_dataset` has three operations behind one name:
`list_datasets` and `get_schema` return metadata of the user's own uploads (dataset name,
file name, column names and types, row count), `query_rows` returns cells. Interning the
whole tool ran the dataset list through the shape classifier, which masks a whole text
column as soon as one value is not token-shaped. A single name like `Kunden März` or
`orders` masked every dataset name, the model could not find a dataset by name and
answered from the wrong one (#1866). The agent's own file producers (`render_diagram`,
`create_xlsx`, `create_docx`) were interned the same way, so a diagram came back as an
"original data" table with the signed URL (#1967).

Can an exemption cover only some operations of a tool, and may self-produced file
metadata pass in clear?

## Decision Drivers

- Row data must stay behind the boundary; nothing in a row read may reach the model in
  clear because the same tool also has a metadata operation.
- The model must find the user's dataset by the name the user gave it.
- The allowlist must stay narrow and auditable in one file, with a test that pins it.
- A third party on the public MCP endpoint must never get what the shield passes in clear
  ([ADR-0142](0142-public-mcp-endpoint-fails-closed-on-privacy.md)).

## Considered Options

- **A — Per-operation exemptions in the intern policy**, keyed on the tool name plus the
  input field that names the operation.
- **B — Loosen `isTokenShaped`** in the shape classifier so names pass as `id`.
- **C — Split `query_dataset`** into separate tools per operation.

## Decision Outcome

Chosen option: **A**.

- `INTERN_EXEMPT_OPERATIONS` maps a tool to `{ field, operations }`.
  `isInternExemptCall(toolName, input)` is true for a whole-tool exemption or when
  `input[field]` is one of the listed operations. A missing, non-string or unknown
  operation is not exempt (fail closed). Every dispatch seam that has the call's input
  asks `isInternExemptCall`: the orchestrator's dispatch, `LocalSubAgent` and
  `ToolDispatchService`.
- The first entry is `query_dataset` with `list_datasets` and `get_schema`. `query_rows`
  stays interned. `get_schema` now returns column names and types only; the stored
  `sample` (a cell value, admin preview only) is dropped from the tool result.
- `render_diagram`, `create_xlsx` and `create_docx` join `INTERN_EXEMPT_TOOLS`: their
  results are the produced file's metadata and link, never a cell value. Unlike the other
  exempt tools they still run on the user's restored values (#1544), because their output
  goes to the user; `runsOnModelInput()` tells the two kinds apart. What they echo is
  masked again (`remaskEchoedValues`).
- The public MCP endpoint never serves an intern-exempt tool or a tool with exempt
  operations (`isPubliclyServableTool`). That now includes the file producers: their
  result is no longer interned, so the endpoint's masking check would refuse every call.

### Consequences

- 🟢 **Good:** a question that names a dataset reaches that dataset, whatever characters
  its name has.
- 🟢 **Good:** a diagram reply is the image plus a sentence; no signed URL table.
- 🟢 **Good:** the exemption stays one auditable file; the classifier keeps no
  special cases.
- 🔴 **Bad:** a dataset or file name the user typed reaches the model in clear even if it
  contains a personal name. Accepted: it is metadata the user chose for their own upload,
  comparable to `read_attachment`; a value the user masked in the prompt is masked again.
- 🔴 **Bad:** column names reach the model in clear through `get_schema` and
  `list_datasets`. A CSV without a header row turns its first data row (names, e-mail
  addresses) into column names. Accepted like dataset names: column names are structure
  the uploader chose; the import receipt shows them, so a wrong header is visible.
- 🔴 **Bad:** `render_diagram`, `create_xlsx` and `create_docx` are no longer offered on
  the public MCP endpoint. Serving them again needs a public-gate path for metadata-only
  exempt results (follow-up).
- ⚪ **Neutral:** `query_dataset` is no longer servable on the public MCP endpoint (it
  needs a resolved user identity, which a public caller does not have).

## Pros and Cons of the Options

### A — Per-operation exemptions

- 🟢 Narrowest possible exemption; row reads unchanged.
- 🔴 The policy reads the tool input, so an operation name becomes part of the contract.

### B — Loosen the classifier

- 🟢 No policy change.
- 🔴 Would pass real name-shaped values of every data-source tool in clear; the classifier
  has no control-flow exemption by design (ADR-0094).

### C — Split the tool

- 🟢 Whole-tool exemptions would suffice.
- 🔴 Changes the model-facing tool contract and the system prompt for one privacy rule.

## More Information

- `middleware/packages/harness-orchestrator/src/privacyInternPolicy.ts`
- `middleware/test/privacyInternPolicy.test.ts`,
  `middleware/test/orchestrator/internExemptionsDispatch1866.test.ts`
- `docs/trust-and-privacy.md` (Privacy Shield section)
- Issues #1866, #1967; related [ADR-0098](0098-uploaded-dataset-cells-encrypted-with-link-keys.md),
  [ADR-0137](0137-generated-files-are-content-addressed-behind-signed-urls.md)
