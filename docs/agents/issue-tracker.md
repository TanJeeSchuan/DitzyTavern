# Issue tracker: SimpleTracker

DitzyTavern uses the SimpleTracker server at `https://tan-server.taild926e3.ts.net:8444`. The `simpletracker` executable is on `PATH`. In this repository it is a client for that remote server. Do not run `serve`, `bootstrap`, `backup`, or `restore`; those are server-operator commands.

Do not put an API key in this file, an issue, a comment, a commit, or command output. Load it into `SIMPLETRACKER_API_KEY` before using the CLI. Every client command returns JSON.

```powershell
$env:SIMPLETRACKER_API_KEY = '<key>'
simpletracker project list --server 'https://tan-server.taild926e3.ts.net:8444'
```

Use `ditzytavern` as the DitzyTavern project slug. If it is absent from `project list`, create it once:

```powershell
simpletracker project create --server 'https://tan-server.taild926e3.ts.net:8444' --name 'DitzyTavern' --slug 'ditzytavern'
```

Use `--actor <agent-name>` and `--session <run-id>` on writes. The tracker records the key, actor, session, and time. A typical write ends with:

```text
--actor 'codex' --session '<run-id>'
```

## Identity and state

An issue has an opaque ID, a project-local number, and a stable reference such as `ditzytavern#12`. Use the stable reference or ID for reads and writes. Never identify an issue by its title or board position.

Issues are `open` or `closed`. There is no delete operation. Close obsolete or rejected work so its reference, discussion, and audit history remain available. Use labels for workflow meaning; see [triage-labels.md](triage-labels.md).

SimpleTracker has native relations:

- A child has at most one `parent`. Parent and child must belong to the same project.
- A blocker edge points from blocked work to its prerequisite. In `issue block --id A --parent B`, A is blocked by B.
- Closing every open blocker makes an issue unblocked. Self-links, parent cycles, and blocker cycles are rejected.
- `position` orders siblings. New children append. Lists break position ties by issue number, then ID.

Do not encode `Head:` or `Blocked by:` lines in issue bodies. Those were Collattice workarounds and are obsolete.

## Everyday commands

All examples below need `--server 'https://tan-server.taild926e3.ts.net:8444'`. It is shown once per command because the client has no server environment variable.

```powershell
# Read and search
simpletracker issue get --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12'
simpletracker issue list --server 'https://tan-server.taild926e3.ts.net:8444' --project 'ditzytavern' --state open --label ready-for-agent
simpletracker issue list --server 'https://tan-server.taild926e3.ts.net:8444' --project 'ditzytavern' --q 'database'

# Create and edit
simpletracker issue create --server 'https://tan-server.taild926e3.ts.net:8444' --project 'ditzytavern' --title 'Title' --body 'Markdown' --labels 'ready-for-agent,enhancement'
simpletracker issue update --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12' --body 'Revised Markdown'
simpletracker issue comment --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12' --body 'Progress note'

# Labels, ownership, and lifecycle
simpletracker issue label --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12' --label needs-info
simpletracker issue label --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12' --label needs-info --remove
simpletracker issue assign --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12' --assignee 'codex/<run-id>'
simpletracker issue unassign --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12'
simpletracker issue close --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12'
simpletracker issue reopen --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#12'

# Hierarchy, blockers, and ordering
simpletracker issue parent --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#13' --parent 'ditzytavern#12'
simpletracker issue parent --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#13'
simpletracker issue block --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#13' --parent 'ditzytavern#9'
simpletracker issue unblock --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#13' --parent 'ditzytavern#9'
simpletracker issue order --server 'https://tan-server.taild926e3.ts.net:8444' --id 'ditzytavern#13' --position 0
```

`issue get` returns the Markdown body, comments, labels, attribution, assignment, parent, children, blockers, reverse blocked issues, position, state, and derived `blocked` value. Read it before changing an issue.

## Finding and claiming work

`issue frontier` returns open, unblocked, unassigned issues in stable order. The `ready-for-agent` label expresses intent, but it does not control frontier membership.

```powershell
simpletracker issue frontier --server 'https://tan-server.taild926e3.ts.net:8444' --project 'ditzytavern'
simpletracker issue frontier --server 'https://tan-server.taild926e3.ts.net:8444' --project 'ditzytavern' --parent 'ditzytavern#12'
```

Claiming is two requests, not an atomic operation:

1. Read the frontier and choose an issue.
2. Assign it with `issue assign` before starting work.
3. Read it again. If another worker owns it, query the frontier and choose again.
4. Add useful progress or resolution notes as comments, then close completed work.

Assignment is not a lease and does not expire. Unassign abandoned work.

`issue list` supports `--project`, `--state`, `--parent`, `--label`, `--assigned assigned|unassigned`, `--assignee`, `--q`, `--age`, `--updated-since`, and `--updated-until`. Use `--parent root` or `--parent none` for top-level issues.

## Skill workflows

For a spec, create one parent issue containing the accepted Markdown. For implementation tickets, create children with `--parent`, add blocker edges for real prerequisites, and apply `ready-for-agent` only to fully specified executable work. Create prerequisites before dependants so their references are available.

For Wayfinder, label the parent `wayfinder:map`. Give each decision child exactly one type label: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. Assign a frontier child before working it. Comment the resolution, close the child, and add a short pointer to it in the map's decisions.

For triage, query the relevant labels and assignment buckets, then sort `created_at` ascending when presenting oldest first. Read each full issue before changing it. Start every triage comment with this exact line:

```text
> *This was generated by AI during triage.*
```

For code review, resolve the issue reference from the commit or spec context and read its body and comments. SimpleTracker does not synchronize pull requests, and issue tracking does not replace the repository's normal Git workflow.

When a skill says "publish to the issue tracker", create or update the SimpleTracker issue, return its stable reference and canonical URL, and apply `ready-for-agent` only when another agent can start without more decisions.

## Browser and HTTP API

Open the server URL and sign in with the API key. Browser login creates a 30-day session. The browser lists projects, shows parent-based swimlanes, filters issues, and edits existing issues. Its columns are derived, not separate workflow states:

- `Unclaimed`: open, unblocked, unassigned
- `In progress`: open, unblocked, assigned
- `Blocked`: open with at least one open blocker
- `Done`: closed

Dragging only reorders work inside the same lane and derived column. Create projects and issues with the CLI or API.

The API root is `/api/v1`. Send `Authorization: Bearer <key>` or `X-API-Key: <key>`. Add `X-Actor-ID` and `X-Session-ID` to writes. Common routes are:

| Operation | Request |
| --- | --- |
| Projects | `GET/POST /api/v1/projects`, `GET /api/v1/projects/<id-or-slug>` |
| Issues | `GET /api/v1/issues`, `GET/PATCH /api/v1/issues/<ref>`, `POST /api/v1/projects/<slug>/issues` |
| Comments | `GET/POST /api/v1/issues/<ref>/comments` |
| Labels | `GET/POST /api/v1/issues/<ref>/labels`, `DELETE /api/v1/issues/<ref>/labels/<label>` |
| Assignment | `POST/DELETE /api/v1/issues/<ref>/assign` |
| Parent | `POST/DELETE /api/v1/issues/<ref>/parent` |
| Blockers | `GET/POST /api/v1/issues/<ref>/blockers`, `DELETE /api/v1/issues/<ref>/blockers/<blocker-ref>` |
| Order | `POST /api/v1/issues/<ref>/position` |
| State | `POST /api/v1/issues/<ref>/close`, `POST /api/v1/issues/<ref>/reopen` |
| Frontier | `GET /api/v1/frontier`, `GET /api/v1/projects/<slug>/frontier` |

Raw HTTP URLs must encode `#` in references as `%23`; the CLI does this for you. A 4xx response has `error.code` and `error.message`. Fix the request or relation instead of switching to another issue system.
