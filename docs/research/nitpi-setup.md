# NitPi in DitzyTavern

The local setup replaces lgtmaybe with `.github/workflows/nitpi-review.yml` and trusted guidance in `.nitpi/review-instructions.md`. GitHub must receive these files on the default branch, `master`, before comment-triggered reviews work.

## Configured settings

- Manual mode. A writer comments exactly `/review`, `/review clean`, or `/review cancel` on a pull request, or selects the PR number and command with Run workflow in Actions. Close and draft-conversion events also reach the host.
- Storage: `http://100.100.175.73:51733`.
- Both model stages: `https://api.tanjs.dev/v1/`.
- Primary: `opencode-go/deepseek-v4.1-flash(max)`.
- Re-review: `gpt-6.1-sol(high)`.
- Tailscale: ephemeral, preauthorized runner with `tag:ci-nitpi-reviewer`; the tailnet policy must allow this tag to reach `100.100.175.73` on `tcp:51733`.

The runner installs Node 24 and NitPi's dependencies in a separate checkout pinned to [`1b1b67cd`](https://github.com/TanJeeSchuan/NitPi/tree/1b1b67cde8c8c971100c4625bda0e0353b4d15cf). This includes the Actions publishing-identity, queued-recovery, and review-response status fixes. DitzyTavern's default branch provides trusted instructions; PR commits are fetched as git objects. The entry runs with DitzyTavern as its working directory because `headCheckoutSource` is `process.cwd()`. ([Entry](https://github.com/TanJeeSchuan/NitPi/blob/1b1b67cde8c8c971100c4625bda0e0353b4d15cf/actions/entry.mts))

## Credentials

Saved repository secrets:

- `NITPI_PRIMARY_API_KEY`
- `NITPI_RE_REVIEW_API_KEY`
- `NITPI_STORAGE_AUTH_KEY`
- `NITPI_TAILSCALE_OAUTH_SECRET`

NitPi is public. Its engine checkout needs no additional credential. The temporary deploy key and checkout secret were removed after the visibility change.

The job's built-in `GITHUB_TOKEN` publishes reviews and checks with `contents: read`, `pull-requests: write`, and `checks: write`, mapped to `NITPI_SECRET_GITHUB_TOKEN`. No separate publishing credential is needed. GitHub documents App authentication for creating check runs; NitPi's upstream PAT recommendation should not be copied. ([Check runs](https://docs.github.com/en/rest/checks/runs#create-a-check-run), [automatic token authentication](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication))

## Integration decisions and verification

To start a review from the CLI, run `gh workflow run nitpi-review.yml --repo TanJeeSchuan/DitzyTavern --ref master -f pr_number=11 -f command=review`. Replace `11` with your PR number. Use `review-clean` for a fresh review and `review-cancel` to queue a cancellation request; it cannot stop a running review immediately.

The workflow passes inputs directly to the entry, removing upstream's routing job. This avoids its missing job-output mappings, `NITPI_COMMAND`/`NITPI_INPUT_COMMAND` mismatch, and stop-event outputs written only to stdout. ([Upstream workflow](https://github.com/TanJeeSchuan/NitPi/blob/6704c388e67bc76070aa18dfaa113781b7a36236/.github/workflows/tailscale-review.yml))

Per-PR concurrency follows upstream with `cancel-in-progress: false`. It serializes jobs, so cancel and stop deliveries wait behind an active review. Immediate cancellation remains an upstream integration limitation; concurrent entry processes cannot both hold the storage lease. ([Entry](https://github.com/TanJeeSchuan/NitPi/blob/6704c388e67bc76070aa18dfaa113781b7a36236/actions/entry.mts))

Actionlint validates the workflow. The real runner successfully checked out NitPi, joined Tailscale, opened the storage partition, and published check runs. The first full attempt failed at bot identification because REST `/user` rejects installation tokens. [NitPi PR #2](https://github.com/TanJeeSchuan/NitPi/pull/2) replaces that lookup with GraphQL `viewer`, verified on the runner with the same token and covered by a failing-then-passing publication test.

Subsequent jobs exited green without a review because a new-head request queued behind an interrupted attempt, then the entry closed the resumed work. [NitPi PR #3](https://github.com/TanJeeSchuan/NitPi/pull/3) waits for resumed tasks and joins the queue drain. A real entry-process regression reproduced the empty green result before the fix and now publishes the new head; 51 related tests and typecheck pass.

[The next run](https://github.com/TanJeeSchuan/DitzyTavern/actions/runs/37175607946) published [a complete review](https://github.com/TanJeeSchuan/DitzyTavern/pull/11#pullrequestreview-5404314911), but failed because NitPi expected HTTP 201 instead of GitHub's HTTP 200. [NitPi PR #4](https://github.com/TanJeeSchuan/NitPi/pull/4) corrects that endpoint's expected status and its test fixture; typecheck and 20 publication, retry, rerun, and identity tests pass. The updated pin is being verified on GitHub.
