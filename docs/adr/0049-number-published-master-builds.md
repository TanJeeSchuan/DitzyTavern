---
status: accepted
---

# Number published master builds

For [issue #29](https://github.com/TanJeeSchuan/DitzyTavern/issues/29), build and publish one rolling Docker stream from `master` with automatically increasing build numbers. PRs neither build nor publish Docker images; retain their ordinary non-Docker checks. Master retains container smoke checks before publication. Remove version-tag-triggered Docker builds and publication and mutable SHA/version aliases from future publishing; `build-N` is the immutable pin and `latest` is the moving alias.

The update indicator compares official numeric build numbers rather than commit ancestry or image digests. This keeps automatic master publication without a manual semantic-version release process or multiple release tracks. Commit IDs describe provenance and enable a changes link only when revisions differ. GitHub's `run_number` belongs to a particular workflow, so preserving that workflow's numbering sequence is part of the public release contract. A workflow replacement must explicitly preserve ordering before it publishes.

Introduce a global publication lock covering numbered-tag existence checks and writes as well as `latest` promotion. Publish `build-N` only if absent; reruns reuse its existing digest. Under the lock, freshly compare numbers and promote only a greater candidate by aliasing its exact multi-architecture index digest. Existing per-ref cancellation does not enforce this contract and must not cancel the active publication.

Numbered publication and alias promotion are separate registry operations. If promotion fails, `latest` can lag while the job reports failure. Rerunning reuses the immutable numbered digest and repairs promotion unless a greater build already occupies `latest`. Thus `latest` never regresses and identifies the greatest completed promotion; it cannot be guaranteed to identify the greatest published numbered tag during an interrupted publication. This qualification is accepted.

Runtime metadata and OCI metadata identify distribution, build number, and revision. Put comparison metadata on the index itself. Ordinary builds default to custom and make no update requests; the metadata is identification, not a security boundary. Introduce a server-owned checker and persist only the installation-wide automatic-check preference. Keep results and attempt status in memory, retaining the last success when a refresh fails. Settings offers manual instructions, while image installation and restarts remain operator actions. See the [specification](../specs/update-indicator.md) for the state behavior and verification requirements.
