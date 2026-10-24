# Production upgrade readiness

The initial Box-stack upgrade was destructive. The revised migrations preserve the deployed instance's Author Notes, Memory configuration, saved claims, and embedding cache. Production remains on its original container and data.

The rehearsal starts from Docker build 103, revision `cc2baa33b2c0c536084bad37b4f5b8f607037d66`, with migrations through `0016`. The target is `751586c880145accccba820396c0d2d4b4307fac` plus the working-tree preservation changes and `0029`. Origin/master was `496310b9168b2aa92fb0c589672788c197501830`; the deployment is three commits behind it. The current branch includes the stacked work, so the rehearsal covers the cumulative upgrade.

## Findings and changes

Migration `0017` already saved Author Note text and rewrote preset references, but no migration installed Box lifecycles. Existing Chats consequently reported Author Note and Memory as absent. Revised [0024](../../src/server/database/migrations/0024_amused_dexter_bennett.sql) installs both lifecycle keys, preserves existing Box rows, and maps the old global Memory switch to each Chat's enabled state. Other Boxes remain absent. Existing preset block enablement still controls whether a Box contributes to a Generation.

The same migration now moves extraction and embedding settings to `box:memory/settings` in `library_data`, the Decision Model selection to `box-decision/memory`, and allowance, note, identities, and label merges into each Chat's `box:memory` values. It copies those values before dropping the old tables.

Revised [0025](../../src/server/database/migrations/0025_first_solo.sql) wraps completed automatic collections and Writer corrections in `record:<instance>` slots. Writer-maintained empty lists remain overrides, so a deliberately removed claim does not return. Failed automatic collections become errors tied to their original source hash. Unfinished jobs are not marked complete. The old source hashes remain intact.

Revised [0026](../../src/server/database/migrations/0026_freezing_darkstar.sql) renames the embedding cache instead of dropping it. The old and new code use the same vector encoding and space-key calculation. [0029](../../src/server/database/migrations/0029_request_override_namespaces.sql) supplies missing Request Override namespaces without overwriting existing objects.

These are edits to migrations not yet applied by production. They do not reconstruct data on an instance that already ran the destructive versions. Such an instance needs its pre-upgrade backup.

## Evidence

A SQLite backup API snapshot was taken through a read-only connection to the production database. Migrations were run on separate copies. The source container, its data, and its configuration were not changed.

The initial upgrade applied all 30 journal entries and passed foreign-key checks, while leaving both Notes inactive and deleting all Memory data. This demonstrated why an empty-database startup or successful migration is insufficient.

After the fixes, the copied database retains:

- Both Chats and both nonempty Author Notes, with Author Note and Memory enabled.
- Memory extraction, embedding, and Decision selections on profiles 1, 2, and 3.
- Each Chat's 20,480-token allowance, rather than the new default of 2,048.
- All 678 completed or failed Memory collections as slots: 552 automatic records containing 1,588 claims and 126 errors.
- All 1,866 embedding vectors, with identical keys and bytes.
- All 1,810 Messages and 3,437 Variants, with unchanged rows.
- Unchanged connection secrets, Images, and artifact rows.

All 3,437 Variants decode through `readVariantDetails` after migration. Every legacy claim payload validates against the new `memoryRecord` schema. The source has no `source_changed` flags or mismatched source hashes. Foreign-key checks pass before and after migration.

Using the production encryption key in process memory, the current Connection Settings code decrypts all four saved credentials. Memory's current read reports its extraction Decision Model and embedding configuration ready, and exposes all 1,588 saved claims. No provider request was made.

`LOCAL=1 bun run check` passed, including both typechecks, lint rules, contract checks, all 1,449 tests, and four E2E harness tests. The focused migration tests passed again after their registry cleanup was added. Existing lint warnings and Elysia `exactMirror` diagnostics remain in the broader check output; neither caused a failure.

The working-tree Docker image built successfully and started against a fresh copy of the original database and artifact directory on an internal Docker network with no provider egress. All 15 checked HTTP routes returned 200, including both Chats, Generation Settings, connection settings, Box discovery, Memory settings, Decision selection, allowances, and saved Memories. The image retained 1,588 claims, applied all 30 migrations, and passed foreign-key checks. A browser loaded the new bundle, opened Author Note and Generation Settings, and reported no failed asset requests. A second container startup retained its ready Memory configuration. No live model generation was attempted.

A subsequent flow rehearsal upgraded another fresh production snapshot and exercised both existing Chats through the real application routes with injected fake providers. Both Prompt Plans fit their unchanged budgets, included their Author Notes, and recalled saved claims from the migrated records. The chat provider requests matched the inspected plans, including the second Chat's image data after the SDK's normal conversion to `image_url` parts. Each Chat streamed and committed a reply and a sibling Swipe. All four new Variants and their complete provenance read back after closing and reopening the application. Foreign-key checks remained clean. The fake handled four chat calls, four embedding calls using the configured 3,072-dimensional space, four Decision calls, and six extraction calls. Every outbound request was intercepted; no live provider was contacted. This establishes the upgraded application flow, not the availability or answer quality of the live providers.

The regression test uses the actual migration runner to create a database through `0016`, inserts legacy data, and upgrades it with the full journal. It covers Memory globally enabled and disabled, Unicode and quoted Author Notes, empty Notes, settings, identity exclusions, label merges, automatic claims, a Writer's empty override, failed extraction, unfinished work, catch-up references, vector bytes, and a second startup. Run it with:

```sh
bun test --preload ./src/server/test-fixtures/boxes.ts src/server/database/migrations.test.ts
```

## Cutover constraints

Include the preservation changes and `0029` in the published artifact before the first production update. Keep the full snapshot and old image digest together with the encryption key. Replace the container, preserve its existing mount and port mapping, and refresh browser tabs. Follow [the pre-Box upgrade procedure](../docker.md#upgrade-from-the-pre-box-release).

The operator accepts loss of work in progress, including unsaved drafts, active streams, staged imports, and unfinished jobs. Preserving those states is not a release requirement. Stop the old server before backing up its durable data.

Historical Memory recall snapshots and per-source extraction traces are still retired. Pending extraction and catch-up jobs require another run. Resetting a migrated Writer-only record removes it; there is no older automatic record to restore. These changes follow the new Box model and do not erase retained claims during the upgrade.

The Dockerfile includes the new Box source, SDK, path-alias configuration, and built client assets. No new production environment variable is required. Existing plugin clients must be built for the current SDK and loaded by a container restart. See [the runtime audit](prod-upgrade-runtime-audit.md) and [the original migration findings](prod-upgrade-migration-audit.md).
