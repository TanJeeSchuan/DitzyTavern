# Rewrite the authoring guide for the generic host

Status: TODO

Blocked By: 15-thoughts, 17-generic-digests

Source: the guide test report (11 gaps); tickets 16 and 17.

## Goal

`docs/box-system/authoring.md` describes the generic host as built: adding a Box is its descriptor, one server module, one client module and tests. Every gap from the guide test report is resolved.

## Ownership

- `docs/box-system/authoring.md`
- `docs/box-system/spec.md` where it differs from the code

## Work

- [ ] Rewrite "Add a Box" for the generic host, with a check per step that can run without a live app.
- [ ] Give every hook a "Host wiring" line, or state that it needs none.
- [ ] Cover the lens contract, the `read`, `dependencies` and `remove` hooks, digests and per-Box Decision Model selection, window CSS, and that parsers used by both lens and `read` live in `src/shared/`.
- [ ] Resolve each of the 11 gaps from the guide test report, or explain why it no longer applies.
- [ ] Have the reviewer check every claim against the code.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The guide names no step that edits a host file.
