# Update indicator

Status: Design accepted. Implementation authorized through the three local update-indicator tickets.

Source: [GitHub issue #29](https://github.com/TanJeeSchuan/DitzyTavern/issues/29).

## Settled decisions

- Q1: Notify only. Show that an update is available and link to instructions for obtaining it. DitzyTavern does not download, install, or restart itself for an update.
- Q2 and Q16: Publish one rolling Docker stream from `master`. Each distinct workflow run has an automatically assigned, increasing build number, such as `build-142`; its successful master build publishes that number, and reruns retain it. `latest` identifies the greatest build whose promotion has completed. Failed promotion can temporarily leave it behind a published numbered image, as described below. Deliberate version tags and separate stable/nightly tracks are not required.
- Q3 and Q6: Update comparison covers official Docker images, including pinned official images. Source checkouts and custom builds show "Custom build · update checks unavailable" and do not check for updates. "Detached" was rejected because it can be confused with Git's detached HEAD state.
- Q4: Check automatically and provide a manual "Check now" action.
- Q5: Show update availability inside the Settings panel. No navigation badge, toast, or workspace banner is planned.
- Q7: Check once after server startup, then every 24 hours while running. "Check now" requests a fresh check. All browsers share the server's result.
- Q8: A Settings toggle controls automatic checks and is enabled by default. Manual checks remain available when automatic checks are disabled.
- Q9, refined in final review: A failed check before any success shows "Couldn't check for updates" and a retry action in Settings. A failed refresh after a success retains that result and separately reports the failed refresh. Before the first result, show "Checking…" while the request is running, never "Up to date" without a successful check.
- Q10, refined in final review: An available update offers "Update instructions" linking to the Docker update docs. Show "View changes" linking to the GitHub comparison only when the running and available source revisions differ. A higher build number at the same revision is still an update.
- Q16 supersedes Q11's source-commit comparison: compare build numbers numerically. A greater published number means an update is available; equal numbers mean current; a smaller published number is not an upgrade. Retain source commits for the changes link.
- Q12: Persist one server-wide automatic-check preference in the existing data volume. Changes apply to every browser and survive container replacement. Disabling the preference stops scheduled checks but leaves manual checks available. Enabling it checks immediately. The startup check runs only when automatic checks are enabled.
- Q17: Reruns retry the same build number. Once published, the numbered image is immutable. A new numbered version requires a new workflow run. Older reruns cannot move `latest` backward.
- Q18, superseded during ticket review: Only master builds and publishes Docker images. PRs must neither build nor publish Docker images; remove the existing PR Docker build and container smoke checks. Ordinary non-Docker PR checks remain.

## Build identity and metadata

`build-N` is the release identity. The commit revision is descriptive provenance, never an ordering key. Use the publishing workflow's numeric `github.run_number`; reruns retain it, and gaps are valid.

Official publishing CI supplies `distribution=official`, a positive integer `buildNumber`, and a full source `revision`. Ordinary source and Docker builds default to `distribution=custom` with no build number. Custom builds do not perform outbound update requests. Deliberately supplying official metadata can identify a custom-built artifact as official; these fields identify a build and are not a security boundary.

Embed matching values in runtime build metadata and OCI metadata. The multi-architecture index must expose them as annotations so checking requires no platform selection or platform-config download. Platform config labels carry the same values. Both supported architectures must report the same identity.

Missing or invalid metadata on a remote official index is a failed check, not evidence that the installation is current. Do not infer a build number from a commit, image timestamp, or an obsolete image format.

### Workflow identity is part of versioning

GitHub defines `run_number` per workflow, not as a permanent repository-wide sequence. Preserve the publishing workflow's sequence. Replacing it with a new workflow that resets numbering requires an explicit numbering transition before publication; do not silently restart at 1. A durable allocator spanning arbitrary workflow replacement is outside this design. Future workflow changes must preserve existing immutable identities and numeric ordering.

## Publication contract

1. `build-N` never changes after its first successful publication. Under the publication lock, check whether it exists. If it does, reuse its published manifest digest and never rebuild or overwrite that tag. Only an explicit registry not-found result permits first publication; network or authentication errors do not establish absence.
2. `latest` is an alias of an already-published numbered multi-architecture index. Promote its exact digest without rebuilding or modifying annotations. Buildx `imagetools create` supports a carbon copy of a single existing index; supply the resolved numbered digest as its sole source, with no transformations. Verify that `digest(latest) == digest(build-N)` for the number exposed by `latest`.
3. One global publication lock covers the numbered-tag existence check and write, and the evaluation and mutation of `latest`. Every publishing path uses it. An active publication is not cancelled by a newer run. Existing per-ref cancellation is insufficient; enclosing workflow cancellation must not cancel the job holding the publication lock either. Pending-job order is not assumed to be FIFO.
4. Inside that lock, read `latest` afresh immediately before promotion. Promote only when the candidate number is greater than the current number. Equal numbers must identify the same digest; a conflict fails publication. An older candidate leaves `latest` untouched. A genuinely absent `latest` permits initial promotion; a failed lookup does not.
5. The application determines update availability solely by comparing official numeric build numbers. Commit revisions never establish ordering.

### Partial publication and repair

Writing `build-N` and writing `latest` are separate registry operations. A failure between them leaves an immutable numbered image published while `latest` still identifies an earlier build. Therefore "latest always references the greatest successfully published build-N" is not an unconditional invariant. The enforceable guarantee is that `latest` never regresses and references the exact numbered index for the greatest build whose promotion completed.

Treat failed or unverified promotion as a failed publication job, even if the numbered tag already exists. Rerunning that job acquires the same lock, resolves the existing numbered digest without rebuilding, reads `latest` afresh, and retries promotion if its number is greater. If a newer build has already been promoted, the rerun leaves it untouched. Retry also handles an interrupted initial promotion when `latest` is absent. No background repair service is introduced.

The checker reads `latest`, so a numbered image awaiting repair is not advertised as an update yet. An operator may rerun the failed publication to make it discoverable. This failure qualification was accepted in Q19.

## Checker state and Settings behavior

Keep the last successful result separate from the current attempt. A result contains the available build number, revision, and successful-check time. An attempt records whether it is in flight or failed, with its time and error. A refresh never destroys an earlier successful result.

- `custom`: "Custom build · update checks unavailable". No outbound registry request, scheduled or manual.
- `not_checked`: no result and no request in flight, such as after restart with automatic checks disabled. Show "Not checked" and "Check now".
- `checking`: a request is in flight. Show "Checking…"; retain any previous result while refreshing.
- `current`: remote and local numbers are equal. Show "Up to date".
- `update_available`: the remote number is greater. Show the available build and update instructions. Show "View changes" only if revisions differ.
- `ahead`: the remote number is smaller. Show "No newer build available" and both build numbers. Do not offer an update.
- `error`: the attempt failed and no successful result exists in this server session. Show "Couldn't check for updates" with retry.
- `stale`: the latest attempt failed after a success. Retain the previous comparison result and its time, with "Last refresh failed" and retry. For example, "Build 150 available. Last refresh failed." A retained equality or ahead result must likewise be identified as the last successful check, not a fresh assertion.

These states describe behavior, not a requirement for one flat enum. `checking` and `stale` can accompany a retained comparison result. Automatic-check preference is independent of availability: disabling checks stops scheduling without hiding an existing result, and manual checking remains available for official builds.

Persist only the automatic-check preference. Results, attempt times, and errors remain server runtime state and clear on restart. Startup checks remain conditional on the preference. Concurrent requests share one in-flight check; opening Settings or opening another browser does not create another independent polling schedule.

## Current behavior

The documented distribution is a Docker image published to GHCR. Successful master builds publish `latest`; version-tag builds publish the exact tag without moving `latest`. The workflow does not create GitHub Releases. On 2026-10-07, the upstream repository had no Releases or tags.

The application has no declared package version or existing update checker. Operators replace containers themselves, preserving the data volume and encryption key, as described in [Updates and backups](../docker.md#updates-and-backups).

GHCR exposes the public `latest` multi-architecture image index through anonymous pull access. The platform image configs contain the source commit in their OCI revision labels. The running app cannot read those container labels directly, and the Docker build context excludes `.git`. The publishing workflow already knows the commit and can supply runtime build metadata.

Existing Appearance and prompt-inspection preferences live in browser local storage. There is no existing server-wide settings store for the automatic-check preference.

The existing GitHub Actions workflow has an increasing run number. PRs and failed runs consume numbers, so published build numbers will have gaps. Current per-ref concurrency cancels superseded runs, but rerunning an older run still requires care to prevent replacing `latest` with an older build number. The workflow also builds containers for PR validation without publishing them.

## Final review

The product design, executable publication guarantees, deterministic build identity, checker state, and workflow-numbering caveat are accepted. Q19 closes the final decision by accepting temporary promotion lag and repair through rerunning the publication job. During ticket review, the user superseded Q18: PRs must neither build nor publish Docker images. The user subsequently approved all three local tickets and authorized implementation, commits, a pull request, and fixes in response to review.

## Proposals discussed, not accepted

Commit equality alone could show "Different master build available", but cannot establish that the published build is newer. The user questioned whether version tags would simplify this.

Stable releases plus a separate `edge` or `nightly` stream were proposed. The user chose one automatically numbered stream from master instead. No development-branch Docker publication or separate release-promotion process is planned.

## Proposed implementation boundaries

Remove version-tag-triggered Docker builds and publication, and remove Docker builds and container smoke checks from PR execution. Keep ordinary non-Docker PR checks. Successful master runs build, smoke-test, and publish Docker images. Introduce automatic numbered image tags and matching runtime/OCI build metadata, a server-owned update checker with shared status, a persisted server-wide automatic-check preference, and Settings controls. Source-commit metadata remains available for change comparisons, but does not determine update availability.

The checker reads the published index's metadata, rather than assuming the current GitHub branch head is available. Introduce a single global publication lock and exact-digest promotion of existing numbered indexes. Remove mutable SHA/version aliases from the future publication contract; `build-N` is the immutable pin and `latest` is the moving alias. Retain SHA only as provenance. The existing generation and manual container-replacement behavior does not change.

## Verification requirements

Verify behavior with scripted registry responses: numeric ordering including 9 versus 10, same-revision updates, custom builds making no requests, successful-result retention after failure, initial failure, restart clearing cached state while retaining the preference, and concurrent manual checks sharing one request.

Verify publication with out-of-order candidates, reruns after publication, registry lookup failures, first publication, mismatched digests for one build number, and interruption between numbered publication and promotion. Assert immutable numbered digests and exact alias digest equality. Verify that PR execution neither builds nor publishes Docker images and that master retains container smoke checks. Do not test these guarantees merely by matching workflow YAML text. Do not add UI component or snapshot tests.

## Primary references

- [GitHub Actions contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts): `run_number` belongs to a particular workflow and does not change on rerun.
- [GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency): concurrency groups serialize execution, can replace pending work, and do not guarantee FIFO ordering.
- [Rerunning workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs): reruns retain the original revision and ref.
- [Docker annotations in GitHub Actions](https://docs.docker.com/build/ci/github-actions/annotations/): the existing metadata-action/build-push-action toolchain supports index annotations with Buildx 0.12 or later.
- [Buildx imagetools create](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/): one existing manifest-list or image-index source is copied as a "carbon copy". Use no annotation changes or other transformations, and verify digest equality after promotion.
