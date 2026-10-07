# 01: Publish immutable numbered Docker builds

**What to build:** Operators can pull a numbered official master build or its exact `latest` alias, identify the running build, and safely retry an interrupted publication. The accepted update-indicator specification and ADR 0049 govern this work. Source: https://github.com/TanJeeSchuan/DitzyTavern/issues/29.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Only successful master runs build, smoke-test, and publish Docker images. PRs neither build nor publish images; ordinary non-Docker checks remain. Remove version-tag-triggered Docker work and future SHA/version aliases.
- [ ] Each publishing workflow run receives its numeric run number as release identity; reruns retain it and gaps are valid. Preserve workflow-number continuity and document the explicit transition required before replacing its allocator.
- [ ] Official images expose matching distribution, positive build number, and full source revision in runtime metadata, multi-architecture index annotations, and platform labels. Ordinary builds default to custom with no number. Identity is not a security boundary.
- [ ] One global publication lock covers existence checks, numbered publication, and latest promotion. Neither newer runs nor enclosing workflow cancellation cancel its active owner. Do not assume FIFO execution.
- [ ] Publish build-N only on a confirmed not-found result. Existing numbered indexes are immutable and reused by digest; network/authentication failures do not mean absence.
- [ ] Read latest afresh under the lock and promote only a greater numeric candidate. Alias the already-published exact multi-architecture index digest without rebuilding or transforming it, and verify equality. Equal-number conflicting digests fail; older candidates leave latest untouched.
- [ ] Interrupted promotion fails the job and may leave latest behind. A rerun repairs it from the existing numbered digest, unless a newer build already won. No background repair service or atomic-two-tag promise.
- [ ] Operator instructions explain immutable pinning, manual replacement, numbering, the retained volume/key, and rerun repair.
- [ ] Behavioral publication checks cover out-of-order candidates, immutable reruns, lookup errors, initial publication, conflicting digests, and interrupted promotion. Verify metadata on the built artifact and routing of Docker execution to master only; do not merely assert YAML text.

Use the accepted publication command/registry boundary and built-artifact behavior for test-first checks. No live release publication is necessary to test this ticket.
