# 02: Check for updates from Settings

**What to build:** A writer can choose Check now in Settings and see whether a newer official build exists, with manual update instructions and source changes where applicable. Every browser shares the server's result. The accepted update-indicator specification and ADR 0049 govern this work. Source: https://github.com/TanJeeSchuan/DitzyTavern/issues/29.

**Blocked by:** 01: Publish immutable numbered Docker builds.

**Status:** completed

- [x] Settings is the only update UI location. No navigation badge, toast, workspace banner, image installation, or restart action is introduced. Use the existing design system.
- [x] Custom builds show Custom build · update checks unavailable and make no outbound update request, including manual attempts. Official pinned builds remain eligible.
- [x] Check now requests published latest index metadata through public registry access, without platform selection/config download. Missing or malformed required official metadata is an error, never evidence of currency or a reason for compatibility inference.
- [x] Numeric build comparison alone determines current, update available, or ahead. Equal numbers show Up to date; smaller remote numbers show No newer build available with both numbers. Greater numbers offer manual update instructions even when revisions are equal.
- [x] View changes appears only when available and running revisions differ and links their GitHub comparison. Source revision never establishes version ordering.
- [x] Expose not-checked, in-flight, successful comparison, first-error, and stale-success behavior. A failed refresh retains the previous result and successful-check time and separately displays Last refresh failed. An initial failure offers retry without claiming currency.
- [x] Keep comparison results and attempt state in server memory; a restart clears them. Concurrent requests share an in-flight check, and all browsers observe the same status without initiating independent schedules.
- [x] Verify public checker/API behavior with scripted registry responses: 9 versus 10, same-revision updates, no custom requests, current/ahead, malformed metadata, initial failure, retained success after failure, and request deduplication. Verify the Settings user flow without component or snapshot tests.

Use the accepted checker/API boundary and user-flow e2e for test-first behavioral checks. Automatic scheduling and its persistent preference belong to ticket 03.


Verified: 10 checker/API tests; 1,293 unit tests and three harness tests; four update user-flow e2e tests and ten existing generation e2e tests. Lint, contract ownership, both typechecks, and build passed. Desktop and narrow Settings visually inspected with shell Playwright after T3 preview reported no automation host. No live registry requests were made.
