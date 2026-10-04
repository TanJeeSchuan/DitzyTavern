# NitPi in DitzyTavern

The local setup replaces lgtmaybe with `.github/workflows/nitpi-review.yml` and trusted guidance in `.nitpi/review-instructions.md`. GitHub must receive these files on the default branch, `master`, before comment-triggered reviews work.

## Configured settings

- Manual mode. A writer comments exactly `/review`, `/review clean`, or `/review cancel` on a pull request, or selects the PR number and command with Run workflow in Actions. Close and draft-conversion events also reach the host.
- Storage: `http://100.100.175.73:51733`.
- Both model stages: `https://api.tanjs.dev/v1/`.
- Primary: `opencode-go/deepseek-v4.1-flash(max)`.
- Re-review: `gpt-6.1-sol(high)`.
- Tailscale: ephemeral, preauthorized runner with `tag:ci-nitpi-reviewer`; the tailnet policy must allow this tag to reach `100.100.175.73` on `tcp:51733`.

The runner installs Node 24 and NitPi's dependencies in a separate checkout pinned to [`6704c388`](https://github.com/TanJeeSchuan/NitPi/tree/6704c388e67bc76070aa18dfaa113781b7a36236). DitzyTavern's default branch provides trusted instructions; PR commits are fetched as git objects. The entry runs with DitzyTavern as its working directory because `headCheckoutSource` is `process.cwd()`. ([Entry](https://github.com/TanJeeSchuan/NitPi/blob/6704c388e67bc76070aa18dfaa113781b7a36236/actions/entry.mts))

## Credentials

Saved repository secrets:

- `NITPI_PRIMARY_API_KEY`
- `NITPI_RE_REVIEW_API_KEY`
- `NITPI_STORAGE_AUTH_KEY`
- `NITPI_TAILSCALE_OAUTH_SECRET`

NitPi is public. Its engine checkout needs no additional credential. The temporary deploy key and checkout secret were removed after the visibility change.

The job's built-in `GITHUB_TOKEN` publishes reviews and checks with `contents: read`, `pull-requests: write`, and `checks: write`, mapped to `NITPI_SECRET_GITHUB_TOKEN`. No separate publishing credential is needed. GitHub documents App authentication for creating check runs; NitPi's upstream PAT recommendation should not be copied. ([Check runs](https://docs.github.com/en/rest/checks/runs#create-a-check-run), [automatic token authentication](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication))

## Integration decisions and verification

The workflow passes inputs directly to the entry, removing upstream's routing job. This avoids its missing job-output mappings, `NITPI_COMMAND`/`NITPI_INPUT_COMMAND` mismatch, and stop-event outputs written only to stdout. ([Upstream workflow](https://github.com/TanJeeSchuan/NitPi/blob/6704c388e67bc76070aa18dfaa113781b7a36236/.github/workflows/tailscale-review.yml))

Per-PR concurrency follows upstream with `cancel-in-progress: false`. It serializes jobs, so cancel and stop deliveries wait behind an active review. Immediate cancellation remains an upstream integration limitation; concurrent entry processes cannot both hold the storage lease. ([Entry](https://github.com/TanJeeSchuan/NitPi/blob/6704c388e67bc76070aa18dfaa113781b7a36236/actions/entry.mts))

Actionlint validates the workflow. The storage health endpoint returned `{"ok":true}` from this workstation. Runner networking, model tool calls, publication, and interrupted-run recovery still need a real PR check after the workflow reaches `master`.
