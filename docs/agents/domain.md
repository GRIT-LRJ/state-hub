# Domain Docs

This repository uses a multi-context domain-documentation layout.

## Before exploring

Read `CONTEXT-MAP.md` when it exists, followed by the `CONTEXT.md` files relevant to the work. Also read applicable system-wide and context-specific ADRs.

Missing context files are expected during early development. Proceed silently; domain-modeling creates them when terminology or decisions are resolved.

## Context boundaries

The current architectural contexts are:

- Desktop shell and UI
- Core Node sidecar and local service
- Domain state model
- Wire protocol
- Public SDK
- Plugin kit
- Event-emission CLI

Context documents live alongside their corresponding application or package. System-wide ADRs live under `docs/adr/`; context-specific ADRs live under that context's `docs/adr/`.

## Vocabulary

Use terms defined by the relevant `CONTEXT.md`. Avoid introducing synonyms for established domain concepts. Record genuine vocabulary gaps for domain modeling.

## ADR conflicts

Surface any conflict with an existing ADR explicitly instead of silently overriding the decision.
