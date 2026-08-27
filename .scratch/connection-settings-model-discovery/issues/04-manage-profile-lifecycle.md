# 04 — Manage the global Connection Profile lifecycle

**What to build:** Let users maintain multiple global Connection Profiles under one revisioned aggregate, explicitly choose the active connection, and resolve deletion and concurrent-edit cases without silent mutation.

**Blocked by:** 03 — Create a first secure DeepSeek Connection Profile.

**Status:** complete

- [x] Users can create, inspect, edit, and delete multiple independently editable Profiles.
- [x] Profile display names are unique under case-insensitive comparison while preserving user-facing casing.
- [x] Creating a later Profile leaves the current active Profile unchanged.
- [x] Exactly one Profile is active whenever at least one Profile exists.
- [x] Users can activate another Profile explicitly, and the global Connection Settings revision advances atomically.
- [x] Deleting the active Profile requires a replacement unless it is the final Profile.
- [x] Deleting the final Profile returns model generation to the unconfigured state.
- [x] A stale expected revision rejects Apply or activation with the authoritative revision/state while preserving the complete client-local draft for manual retry.
- [x] Later bundled Preset changes never mutate Profiles already created from them.
- [x] Database constraints and module tests cover zero/one/many activation, deletion replacement, case-insensitive names, and atomic revision behavior.
- [x] HTTP contract and pure client-state tests cover typed conflicts and draft preservation.
