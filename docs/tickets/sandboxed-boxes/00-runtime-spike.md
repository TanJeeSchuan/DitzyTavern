# Runtime spike: QuickJS and libfx under Bun

Status: TODO

Blocked By: None

Source: `docs/research/sandbox-box-landmark-fit.md` (Performance and QuickJS risks; decisions 11–12), `docs/research/deepseek-harness-creator-mode.md`, issue #69.

## Goal

Answer the runtime questions tickets 01–03 depend on, with measurements: does `quickjs-emscripten` run under Bun 1.4.4 with limits, sync calls and a Promise bridge; what do Race's fold and advance cost across a QuickJS boundary; does `libfx` run under Bun with host-only tools.

## Ownership

- `.scratch/spike/` (throwaway code, its own `package.json` per experiment; never `/tmp`)
- `docs/research/sandboxed-box-spike.md` (findings)
- This ticket directory (risk updates)

No dependency is added to the root `package.json` or `bun.lock`. No source under `src/` changes.

## Work

- [ ] QuickJS loads: in `.scratch/spike/quickjs/`, install a pinned `quickjs-emscripten` and run the normal (not asyncify) build under Bun 1.4.4. Record versions and any flags.
- [ ] Limits: a memory limit stops a runaway allocation and an interrupt handler stops an infinite loop. Record what the host sees in each case and whether the context is reusable afterwards.
- [ ] Sync inside SQLite: call a guest function synchronously from inside a `bun:sqlite` `db.transaction()` callback. This is how capture calls `fold`, `dependencies` and `read`.
- [ ] Promise bridge: a host function returns a QuickJS promise that the host resolves later and pumps with `executePendingJobs`. Inside the guest, `Promise.all` over two such calls: confirm they overlap (wall time) and that cancelling one through a host abort handle rejects it without leaking the handle.
- [ ] Race cost: bundle `src/boxes/race/server-engine.ts` and its local deps to one plain JS file with `bun build` (no Node imports; replace `isNonEmpty` if needed). Generate synthetic races (8 runners; 10, 50 and 200 Stretches). Time `foldRace` and `advanceRace` natively and inside QuickJS, comparing one JSON round trip per fold call with the whole fold batch run inside the VM and serialized once.
- [ ] libfx loads: in `.scratch/spike/libfx/`, install pinned `libfx@0.0.16` (note any newer version on npm). Does the native backend load under Bun 1.4.4? If not, does `backend: 'wasm'` work, and does it need a JSPI flag?
- [ ] libfx agent loop: `createFxAgent` with only host tools (stub `read_contract`, stub `run_scenario`), `provider: { name, baseUrl, models }` pointing at a local `Bun.serve` fake `/chat/completions` scripted to return one tool call, then a final message. Record the events seen (`text_delta`, `tool_start`, `tool_end`), that `session.cancel()` stops a turn, and the checkpoint size.
- [ ] Write `docs/research/sandboxed-box-spike.md`: each question, its answer, numbers, versions and the exact commands. Keep measured results separate from inference.
- [ ] Update the "Open risks" sections of tickets 01–03 where results change them.
- [ ] Set this ticket to DONE and commit.

Wrap any non-trivial command in `flock /tmp/ditzy-heavy.lock <cmd>`. Do not run the full test suite, typecheck or e2e.

## Acceptance

- Every question above has a measured yes/no or number, or a stated reason it could not be measured.
- Nothing outside `.scratch/`, `docs/research/` and `docs/tickets/sandboxed-boxes/` changed.
