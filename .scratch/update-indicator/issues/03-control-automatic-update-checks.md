# 03: Control automatic checks across the installation

**What to build:** Writers can control automatic update checks for the whole installation from Settings. The server checks at startup and every 24 hours when enabled, while manual checking remains available when disabled. The accepted update-indicator specification and ADR 0049 govern this work. Source: https://github.com/TanJeeSchuan/DitzyTavern/issues/29.

**Blocked by:** 02: Check for updates from Settings.

**Status:** ready-for-agent

- [ ] Persist one installation-wide automatic-check preference through the existing data-volume lifecycle, enabled by default. Every browser reads and changes the same value; do not use browser local storage.
- [ ] Eligible official servers check after startup only when enabled, then every 24 hours while running. Enabling checks immediately; disabling stops scheduled work without hiding prior results or disabling manual checking.
- [ ] Custom builds make no outbound requests regardless of preference. Settings visits and additional browsers do not create schedulers.
- [ ] Automatic and manual requests use the existing shared in-flight check. Server shutdown stops scheduling cleanly.
- [ ] Persist only the preference. Successful results, attempt times, and errors clear on restart; with checks disabled the restarted server starts not checked until a manual action.
- [ ] Settings exposes the shared toggle using the established design system and keeps all existing manual status and retry behavior.
- [ ] Verify startup/24-hour/enable/disable behavior through lifecycle/API boundaries with controllable time and scripted registry responses. Verify preference survival, clearing ephemeral results on restart, cross-client visibility, and automatic/manual request sharing. No component or snapshot tests.
- [ ] If seed data changes, keep matching teardown data and dependency order in sync; do not add seed records merely to represent the default preference.

Use the accepted server lifecycle/API and persistence-through-restart behavior for test-first checks. Close this ticket only after its checklist and relevant checks pass.
