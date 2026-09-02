# One import-provenance writer with a derived query index

## Context

An imported Chat keeps its complete Import provenance as the canonical
`report.json` Conversation-scoped data entry. Duplicate classification also
needs to query source SHA-256 and advisory integrity across Chats. SQL cannot
index into the JSON report, so those values are persisted as flat keys in the
import namespace as a derived query index.

Previously the SillyTavern adapter wrote the flat keys while the Import
Projection wrote `report.json` and warnings. That split allowed the two
representations to drift and required readers to reconstruct the same source
identity in multiple places.

## Decision

The Import Projection is the single author of Import provenance. It receives
one report value and writes the canonical JSON report, warnings, and every
flat query-index key derived from that report: source SHA-256, filename,
advisory integrity when present, importer version, and message/variant
counts. The adapter owns decoding and the source-identity codec, but writes
only the canonical source archive before projection.

The flat keys are a query index, not a second source of truth. Future readers
must not repair a perceived mismatch by deleting either copy; the canonical
report remains the record and the flat keys remain the SQL-queryable index.

## Alternatives considered

Scanning every Chat and parsing every `report.json` value for each duplicate
lookup was rejected as unbounded. The derived flat index keeps duplicate
classification queryable without making lookup cost grow with all persisted
provenance payloads.

