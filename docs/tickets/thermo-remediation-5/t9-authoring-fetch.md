# T9: Authoring requests and redirects

Status: READY

Blocked By: T5

Model: Sol 6.2 high. Reviewer: Opus 5.5 high.

Found on 2026-11-19 while writing the round 5 retro; not in the scout reports. Same class as bug 4 in `bugs.md`, which T1 fixed inside `fetchWithTimeout` (`src/server/model-client/model-fetch.ts`).

## The bug

`src/server/authoring/provider.ts` sends Creator Mode's coding-agent requests through the global `fetch`, once with an idle timeout (around line 20) and once without (around line 66). Both carry the Connection Profile's credential in `Authorization` (`authenticatedHeaders`) and set no `redirect`, so the request follows redirects by default.

Whether a cross-origin redirect still carries `Authorization` depends on Bun's `fetch`. The Fetch standard strips it; check that Bun does before treating this as a leak. Write the test first:

- A local server answers the authoring request with a 307 to a second local server on another port. The test asserts the second server never sees the `Authorization` header and the request fails.
- If that test passes on master, the premise is false: drop the fix, record what Bun does in the Outcome, and set Status to DONE.

## Fix

Send both requests with `redirect: "error"`, as `fetchWithTimeout` and `box/sandboxed-deps.ts` do. Prefer routing the provider through `fetchWithTimeout` if its timeout model fits the idle timeout; otherwise set the option at the provider's one `fetch` call.

## TODO

- [ ] Failing test, then fix
- [ ] CI check and e2e

## Acceptance

The new test fails on master and passes on the branch, or the Outcome records why the premise was false. `git grep -nE '[^.a-zA-Z]fetch\(' -- src/server ':!*.test.ts'` lists only `model-client/model-fetch.ts`, `box/sandboxed-deps.ts` and calls that pass `redirect: "error"`.

## Outcome
