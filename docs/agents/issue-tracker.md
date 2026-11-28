# Issue tracker: SimpleTracker

Issues, specs and research for this repo live in SimpleTracker, reached through its MCP server `simple-tracker` (Streamable HTTP at `/mcp`). If its tools are missing from your context, stop and ask the user to connect the server.

This repo's Project slug is `ditzytavern`. Pass it wherever a tool asks for `project`; `list_projects` lists the others. Projects are created only in the UI.

## Records

- An **Issue** is work: it has a Status (`todo`, `doing`, `done`, `dropped`; the last two are closed), an optional Parent, ordered Children, Tags and Blockers. Its description holds the current truth.
- A **Document** is knowledge: a markdown page with no Status.
- A **Comment** is a dated, append-only entry on an Issue. Comments record history.
- Write `#42` in any markdown to make a Reference. It renders as the target's title and shows up in the target's Backlinks. Issues and Documents share one number sequence, so `#42` is never ambiguous.

Skills written for other trackers say "issue", "label", "sub-issue", "assign". Here those are Issue, Tag, Child and Claim. Triage roles from `triage-labels.md` are Tags.

## Your name and Mood

Every write that records who acted takes your name: `claimant` on `claim_issue`, `author` on `add_comment` and on description or body writes. Use your session id if it's in your context; otherwise pick a short name you'd like to be called, and reuse it for the whole session.

Those same tools take an optional `mood`: a kaomoji for your state at that moment. Your name stays fixed; your Mood can change from one write to the next.

## Versioned writes

`update_issue` with `description`, and `update_document` with `body`, replace the whole text and need the `version` you last read plus your `author`. Read both from the second block of `get(id)`'s result, the JSON `{ version, text }`. Never cut the text out of the markdown: a description can contain its own `## Context` or `## Comments` heading. Edit that `text` and write it back; the title sits outside it. Other sessions edit concurrently, so the write can be rejected: the error's `current` carries the latest `version` and text. Merge your change into that text and retry with that version. Titles, Status, Tags, Parent and Blockers are not versioned.

## When a skill says "publish to the issue tracker"

- A spec or feature: `create_issue(project, title, description)`, with the spec as the description.
- Its implementation Issues: `create_issue(project, title, description, parent: <spec>, tags?)`, one per Issue, created in priority order (each lands last among its siblings, or right after `after`). Pass `blockedBy: [ids]` for Blockers that already exist, and wire later ones with `update_issue(id, blockedBy: {add: [ids]})`. Apply a triage role with `tags`.
- Knowledge with no work attached (research, a write-up): `create_document(title, body, project, tags?)`.

Every Issue's description is self-contained: another session reads only it and what it References.

## When a skill says "fetch the relevant ticket"

The user passes a number like `42` or `#42`: `get(id: 42)` returns the record as markdown: frontmatter (an Issue's Blockers are its `blockedBy`), then its Context (Parents, Children, what it Blocks, Backlinks) and, for an Issue, its Comments. Without a number, `search(query, project)` finds records by words; filter with `kind`, `status`, `tag` or `parent`.

## Claim, comment, close

- **Claim** before any work: `claim_issue(id, claimant, mood?)` moves a `todo` Issue to `doing` under your name. Only a Claim enters `doing`. If it's rejected, someone else holds it or it is Blocked; the error says which, and you pick other work.
- **Comment**: `add_comment(id, author, body, mood?)`.
- **Close**: `update_issue(id, status: "done")`. Reopen with `status: "todo"`.
- **Out of scope**: `update_issue(id, status: "dropped")`, after an `add_comment` saying why. A duplicate is dropped the same way, with a Comment Referencing the Issue it duplicates.
- **Retag or move**: `update_issue(id, tags: {add, remove}, parent, after, project)`; `update_document` takes `tags` and `project` too.

`delete_issue` and `delete_document` are for records created by mistake. Finished or abandoned work is closed, not deleted, so its history stays.

## Wayfinding operations

Used by `/wayfinder`.

- **Map**: an Issue tagged `wayfinder:map`, holding the map body (Destination, Notes, Decisions so far, Not yet specified, Out of scope) in its description. Create it with `create_issue(project, title, description, tags: ["wayfinder:map"])`; find existing maps with `search(project, tag: "wayfinder:map")`.
- **Ticket**: a Child of the map tagged with its type: `create_issue(project, title, description: <the question>, parent: <map>, tags: ["wayfinder:<type>"])`, where type is `research`, `prototype`, `grilling` or `task`. Sibling order is priority.
- **Blocking**: create every ticket first, then wire Blockers in a second pass with `update_issue(id, blockedBy: {add: [ids]})`. A ticket is Blocked until each of its Blockers is `done` or `dropped`. A cycle is rejected.
- **Frontier**: `search(parent: <map>, frontier: true)` returns the map's `todo`, unblocked Children in priority order. Claimed tickets are `doing`, so they never appear. Take the first.
- **Claim**: `claim_issue(id: <ticket>, claimant, mood?)`, before any work. If another session won the race, take the next Frontier ticket.
- **Resolve**, in this order:
  1. `add_comment(id: <ticket>, author, body: <the answer>, mood?)`.
  2. `update_issue(id: <ticket>, status: "done")`.
  3. `get(id: <map>)`, append `- #<ticket>: <one-line gist>` under Decisions so far, and write it back with `update_issue(id: <map>, description, version, author, mood?)`. On a version mismatch, merge and retry as in Versioned writes, until it succeeds. `#<ticket>` renders as the ticket's title, which is how the map refers to tickets by name.
- **Out of scope**: `add_comment` saying why, `update_issue(id: <ticket>, status: "dropped")`, then a versioned append of `- #<ticket>: <gist and why>` under the map's Out of scope, retried the same way.
- **Research findings**: `create_document(title, body: <findings>, project)`, then Reference the Document as `#<document>` in the ticket's answer Comment.
