# Issue tracker: Plane

Issues and specs live in [Plane](https://plane.tanjs.dev), workspace `personal`, project `DitzyTavern` (`DT`). Use the `plane` MCP server with project ID `2a12c18a-22fe-41c6-95fe-37d0a3cbd829`.

## Conventions

- Create one parent work item per feature, with the spec in its description.
- Create a separate child work item for each implementation ticket, setting `parent` to the feature's UUID.
- Reference tickets by their Plane identifier, such as `DT-42`.
- Apply the project labels defined in [triage-labels.md](triage-labels.md). Resolve label names to UUIDs with `label(action="list")`; use `workitem(action="manage_label")` to preserve unrelated labels.
- Track implementation progress with Plane workflow states and update checklists in the description as work proceeds. Resolve state names and groups with `state(action="list")`.
- Add conversation history as work item comments.

## When a skill says "publish to the issue tracker"

Use `workitem(action="create")` in this project, with the spec or ticket body in `description_html`. Link implementation tickets to their feature parent and return each created identifier and URL.

## When a skill says "fetch the relevant ticket"

Use `workitem(action="retrieve_by_identifier", workitem_identifier="DT-42")`. For a bare issue number, prepend `DT-`. For a Plane URL, extract the work item UUID and use `workitem(action="retrieve")`. Read the description, comments, parent, and blocking relations before working.

## Wayfinding operations

Used by `/wayfinder`. The map is a parent work item with one child work item per ticket.

- **Map**: keep Notes / Decisions-so-far / Fog in the parent's description.
- **Child ticket**: set `parent` to the map's UUID, put the question in the description, and retain a `Type:` line (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: use Plane's `blocked_by` work item relations. A ticket is unblocked when all its blockers are in the `completed` state group.
- **Frontier**: list the map's children, following pagination, and select open, unblocked tickets in the `backlog` or `unstarted` state groups; lowest issue number wins.
- **Claim**: move the ticket to a state in the `started` group before any work. Tickets in this group are claimed.
- **Resolve**: append the answer under an Answer heading in the ticket's description, move it to a state in the `completed` group, then append a context pointer (gist + ticket link) to the map's Decisions-so-far.
