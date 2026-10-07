# 01: Publish immutable numbered Docker builds

**What to build:** Operators can pull a numbered official master build or its exact `latest` alias, identify the running build, and safely retry an interrupted publication. The accepted update-indicator specification and ADR 0049 govern this work. Source: https://github.com/TanJeeSchuan/DitzyTavern/issues/29.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Only successful master runs build, smoke-test, and publish Docker images. PRs neither build nor publish images; ordinary non-Docker checks remain. Remove version-tag-triggered Docker work and future SHA/version aliases.
- [x] Each publishing workflow run receives its numeric run number as release identity; reruns retain it and gaps are valid. Preserve workflow-number continuity and document the explicit transition required before replacing its allocator.
- [x] Official images expose matching distribution, positive build number, and full source revision in runtime metadata, multi-architecture index annotations, and platform labels. Ordinary builds default to custom with no number. Identity is not a security boundary.
- [x] One global publication lock covers existence checks, numbered publication, and latest promotion. Neither newer runs nor enclosing workflow cancellation cancel its active owner. Do not assume FIFO execution.
- [x] Publish build-N only on a confirmed not-found result. Existing numbered indexes are immutable and reused by digest; network/authentication failures do not mean absence.
- [x] Read latest afresh under the lock and promote only a greater numeric candidate. Alias the already-published exact multi-architecture index digest without rebuilding or transforming it, and verify equality. Equal-number conflicting digests fail; older candidates leave latest untouched.
- [x] Interrupted promotion fails the job and may leave latest behind. A rerun repairs it from the existing numbered digest, unless a newer build already won. No background repair service or atomic-two-tag promise.
- [x] Operator instructions explain immutable pinning, manual replacement, numbering, the retained volume/key, and rerun repair.
- [x] Behavioral publication checks cover out-of-order candidates, immutable reruns, lookup errors, initial publication, conflicting digests, and interrupted promotion. Verify metadata on the built artifact and routing of Docker execution to master only; do not merely assert YAML text.

Use the accepted publication command/registry boundary and built-artifact behavior for test-first checks. No live release publication is necessary to test this ticket.


Implementation notes: publication uses the existing Check workflow run number, a non-cancelling global container-job lock, explicit registry not-found responses, and exact index-digest promotion. First rollout requires an operator to retire the old unnumbered latest alias safely through GHCR package administration; no compatibility inference or live registry mutation is included. Built runtime metadata is verified against platform labels in both architectures before publication. Local publication tests exercise registry and command boundaries; Docker itself is unavailable in this workspace, so actual container execution remains a CI verification.
