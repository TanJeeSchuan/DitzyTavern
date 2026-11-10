import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { otherBoxTags, type BoxId } from "../../shared/contract/box";
import { assertChecked, delegateApplyInput } from "../../shared/contract/box-descriptor";
import { delegateRequest } from "../../shared/delegate-request";
import { snapshotQuery } from "../../shared/contract/box-sandboxed";
import type { BoxValue } from "../../shared/contract/box-value";
import type { DecisionAnswer } from "../../shared/contract/decision-model";
import type { ScenarioInput, ScenarioResult } from "../../shared/contract/authoring";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { checkedDecisionAnswers } from "../decision-model";
import type { BoxContext, DigestPassage } from "../box/contract";
import { withBoxOperations, checkSandboxedFolder, type CheckedSandboxedBox, type LoadedBox } from "../box/registry";
import { boxSeed } from "../box/seed";
import { assertPlainHome, readLatest, VERSION_PATTERN, versionFolder } from "../box/versions";
import { playedRefusals, refusedUpgrade } from "../conversation";

type Turn = ScenarioResult["turns"][number];
type Step = { readonly kind: "turn" | "swipe"; readonly index: number };
const stepsOf = (input: ScenarioInput): Step[] => [...input.turns.map((_, index) => ({ kind: "turn" as const, index })), ...(input.swipes ?? []).map((_, index) => ({ kind: "swipe" as const, index }))];

// @approved
//  One version as a scenario runs it: its hooks, the scenario's setup checked
// against it, and its fold. A version without a stored setup reads its own
// `initial`, as a Chat does, and `setupError` never sees it, since no Chat
// saved it. A stored setup goes through `setupError` with `initial` as the
// previous setup, as a new Chat's first save does, unless it is one an Update
// check already accepted, which checks it against itself.
const runnerOf = (id: BoxId, { descriptor, box }: Pick<CheckedSandboxedBox, "descriptor" | "box">, input: ScenarioInput, upgraded = false) => {
	if (descriptor.setup === undefined && input.setup !== undefined) throw new Error(`The ${id} Box declares no setup.`);
	const setup = input.setup === undefined ? descriptor.setup?.initial : input.setup;
	if (descriptor.setup !== undefined) {
		assertChecked(descriptor.setup.schema, setup, "The scenario's setup");
		const refused = input.setup === undefined ? undefined : box.setupError?.(setup, upgraded ? setup : descriptor.setup.initial);
		if (refused !== undefined) throw new Error(`The ${id} Box refuses the scenario's setup: ${refused}`);
	}
	return { descriptor, box, setup, fold: (records: readonly GenerationJsonValue[]) => box.records?.foldAll?.(box.records.initial, records, setup) };
};
type Runner = ReturnType<typeof runnerOf>;

const fail = (message: string): never => { throw new Error(message); };

// @approved
//  A delegating Box's record for one step: the batch the scenario scripts in
// place of the agent, checked against the operations of the version running
// the step and reduced by its `delegate.apply` from the state before the
// step, exactly as a delegate run's batch is. It is that Variant's record,
// never a Move. Prose holding the Box's request needs a scripted batch, and
// a batch needs a request to answer, so no step runs a model.
const delegate = async (descriptor: CheckedSandboxedBox["descriptor"], box: CheckedSandboxedBox["box"], index: number, prose: string, delegated: readonly BoxValue[] | undefined, input: Omit<Parameters<NonNullable<CheckedSandboxedBox["box"]["delegate"]>["apply"]>[0], "operations">) => {
	const { tag, operations } = descriptor.delegate!; // @approved Called only for a delegating Box.
	const request = delegateRequest(prose, tag, otherBoxTags(tag));
	if (request === undefined) return delegated === undefined ? undefined : fail(`Turn ${index} scripts delegated, but its prose holds no <${tag}> request.`);
	if (delegated === undefined) return fail(`Turn ${index}'s prose holds a <${tag}> request, so the step needs delegated: the batch the delegate would apply.`);
	assertChecked(delegateApplyInput(operations), { operations: delegated }, `Turn ${index}'s delegated batch`);
	return await box.delegate!.apply({ ...input, operations: delegated }); // @approved The loader requires delegate.apply for a delegate.
};

// @approved
//  Plays a scenario's turns and swipes on whichever version each step names,
// keeping one history across them: each turn folds the records selected
// before it, runs `dependencies` and `advance` with its Moves and its own
// seed, and digests its passage; a swipe runs its turn again with that
// turn's seed and Moves and selects the new record without touching later
// ones. A delegating Box's step reduces its scripted batch in place of a
// delegate run. A digest reads what production's reads: each Message's raw prose,
// never its rendered Moves, and only a passage that holds some. `decide`
// answers from the turn's script. `played` keeps every Variant's record per
// turn, as a Chat stores them.
const scenarioPlayer = (id: BoxId, input: ScenarioInput, signal: AbortSignal) => {
	const database = new Database(":memory:");
	const controller = new AbortController();
	const cast = input.cast.map((name, index) => ({ id: index + 1, name }));
	const human = cast[0]!; // @approved The input schema requires at least one Cast member.
	const speaker = cast[1] ?? human;
	const unavailable = (service: string) => () => { throw new Error(`A scenario has no ${service}.`); };
	const context: BoxContext = { signal: AbortSignal.any([signal, controller.signal]), llm: () => undefined, decide: unavailable("decide outside a digest"), embed: unavailable("embed") };
	const history: DigestPassage[] = [];
	const selected: (GenerationJsonValue | undefined)[] = [];
	const played: { moves: readonly BoxValue[]; records: (GenerationJsonValue | undefined)[] }[] = [];
	const records = () => selected.flatMap((record) => record === undefined ? [] : [record]);
	const run = async ({ descriptor, box, setup, fold }: Runner, index: number, moves: readonly BoxValue[], prose: string | undefined, scripted: Readonly<Record<string, DecisionAnswer>> | undefined, delegated: readonly BoxValue[] | undefined): Promise<Turn> => {
		signal.throwIfAborted();
		if (moves.length > 0 && descriptor.moves === undefined) throw new Error(`Turn ${index} has Moves, but the ${id} Box declares none.`);
		if (descriptor.moves !== undefined) {
			if (moves.length > descriptor.moves.max) throw new Error(`Turn ${index} has ${moves.length} Moves; the ${id} Box allows ${descriptor.moves.max}.`);
			moves.forEach((move, at) => assertChecked(descriptor.moves!.schema, move, `Turn ${index}'s Move ${at}`)); // @approved Checked just above.
		}
		const before = selected.slice(0, index).flatMap((record) => record === undefined ? [] : [record]);
		const { rendered, seed, advanced } = await withBoxOperations([{ box }], async () => {
			const seed = boxSeed(`${input.seed}:${index}`, id);
			const state = fold(before);
			const rendered = moves.map((move) => box.moves!.render(move, human.name)); // @approved The loader requires a render for Moves.
			const dependencies = box.dependencies?.({ database, conversationId: 0, seed, intent: "respond", human, cast, messages: [], pending: undefined }, setup);
			const advanced = await box.advance?.run({ setup, dependencies, state, moves }, context) ?? { items: [] };
			return { rendered, seed, advanced };
		});
		const digest = box.records?.digest;
		const asked = { messageId: index * 2 + 1, speaker: human.name, authorId: human.id, content: "" };
		const passage = { messageId: index * 2 + 2, speaker: speaker.name, authorId: speaker.id, content: prose ?? "" };
		const earlier = [...history.slice(0, index * 2), asked];
		// @approved
		//  The Message and its Variant are stored once `advance` returns, as a
		// Send stores them; a digest only fills the Variant's record later, so
		// one that fails still leaves the Moves and an empty Variant behind.
		const variants = (played[index] ??= { moves, records: [] }).records;
		const at = variants.push(undefined) - 1;
		const record = descriptor.delegate !== undefined ? await withBoxOperations([{ box }], () => delegate(descriptor, box, index, passage.content, delegated, { setup, state: fold(before), cast }))
			: delegated !== undefined ? fail(`Turn ${index} scripts delegated, but the ${id} Box declares no delegate.`)
			: digest === undefined ? advanced.record : passage.content.trim() === "" ? undefined : await digest.run({
			passage, preceding: digest.window === 0 ? [] : earlier.slice(-digest.window), seed,
			cast: cast.map((member) => ({ ...member, removed: false })), data: {},
		}, { ...context, database, decide: async (_state, questions) => {
			const ids = Object.keys(questions);
			const missing = ids.find((question) => scripted?.[question] === undefined);
			if (missing !== undefined) throw new Error(`Turn ${index} scripts no answer for the ${missing} question.`);
			return checkedDecisionAnswers(questions, Object.fromEntries(ids.map((question) => [question, scripted![question]!]))); // @approved Every id was found just above.
		} });
		history.splice(index * 2, 2, asked, passage);
		selected[index] = record;
		variants[at] = record;
		return { moves: rendered, items: [...advanced.items], ...record !== undefined && { record } };
	};
	const play = async (runner: Runner, steps: readonly Step[], into: Pick<ScenarioResult, "turns" | "swipes">) => {
		for (const { kind, index } of steps) {
			if (kind === "turn") {
				const turn = input.turns[index]!; // @approved Steps index the scenario's own turns.
				into.turns.push(await run(runner, index, turn.moves ?? [], turn.prose, turn.decisions, turn.delegated));
				continue;
			}
			const swipe = input.swipes![index]!; // @approved Steps index the scenario's own swipes.
			const turn = input.turns[swipe.turn];
			if (turn === undefined) throw new Error(`A swipe names turn ${swipe.turn}; the scenario has ${input.turns.length}.`);
			into.swipes.push(await run(runner, swipe.turn, turn.moves ?? [], swipe.prose ?? turn.prose, swipe.decisions ?? turn.decisions, swipe.prose === undefined ? swipe.delegated ?? turn.delegated : swipe.delegated));
		}
	};
	const close = () => {
		controller.abort();
		database.close();
	};
	return { cast, human, played, records, play, close };
};

// @approved
//  Loads an installed version of the Box, `latest` or one by hash, from its
// id folder under the plugin folder, as the registry loads one, on a runtime
// of its own the caller frees. A Box with no id folder, as the CLI checks
// one, has no version to run from.
const loadVersion = async (home: string | undefined, id: BoxId, seen: ReadonlySet<BoxId>, version: string, signal: AbortSignal) => {
	if (home !== undefined) await assertPlainHome(home);
	const hash = home === undefined ? undefined : version === "latest" ? await readLatest(home) : version;
	if (home === undefined || hash === undefined || !VERSION_PATTERN.test(hash) || !existsSync(versionFolder(home, hash))) throw new Error(`The ${id} Box has no installed version ${version} to run from.`);
	return { version: hash, checked: await checkSandboxedFolder(versionFolder(home, hash), id, seen, signal) };
};

type StateChange = { readonly path: string; readonly earlier: BoxValue | undefined; readonly candidate: BoxValue | undefined };
const container = (value: BoxValue | undefined): value is { readonly [key: string]: BoxValue } | readonly BoxValue[] => value !== null && typeof value === "object";
const pointerKey = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
// @approved
//  Each place where the candidate's fold of the same records differs from
// the earlier version's, as an RFC 6901 pointer: two objects, or two
// arrays, differ key by key, and anything else that is not equal is one
// change in place. Information, since a version may change state on purpose.
export const stateChanges = (earlier: BoxValue | undefined, candidate: BoxValue | undefined, path = ""): StateChange[] => {
	if (container(earlier) && container(candidate) && Array.isArray(earlier) === Array.isArray(candidate)) {
		const before = new Map<string, BoxValue>(Object.entries(earlier));
		const after = new Map<string, BoxValue>(Object.entries(candidate));
		return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => stateChanges(before.get(key), after.get(key), `${path}/${pointerKey(key)}`));
	}
	return Value.Equal(earlier, candidate) ? [] : [{ path, earlier, candidate }];
};

// @approved
//  Runs one scenario on a candidate exactly as the loader would load it: the
// shared folder check, then the Box's hooks as production calls them, on an
// adapter of its own that is freed afterwards, so nothing reaches a model or
// the database; `read`'s `snapshot` answers from the scenario's script.
// With `from`, its first turns run on that installed version, found under
// `home`, the Box's id folder; then the writer's Update check runs on the
// data they left, and a refusal ends the scenario reading exactly as an
// Update would. Once it passes, the result reports where the candidate's
// fold of those records differs from the version's own, and the remaining
// turns and swipes run on the candidate, folding the earlier records. The
// first refusal or failure ends the scenario with its diagnostic, and so
// does `signal`, when the turn that asked for it is cancelled.
export const runScenario = async (folder: string, id: BoxId, seen: ReadonlySet<BoxId>, input: ScenarioInput, signal: AbortSignal, home?: string): Promise<ScenarioResult> => {
	const result: ScenarioResult = { ok: false, diagnostics: [], turns: [], swipes: [], records: [], recordBytes: 0 };
	let checked: CheckedSandboxedBox;
	try {
		checked = await checkSandboxedFolder(folder, id, seen, signal);
	} catch (error) {
		return { ...result, diagnostics: [signal.aborted ? "The scenario was cancelled." : `The candidate did not load: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const player = scenarioPlayer(id, input, signal);
	let earlier: CheckedSandboxedBox | undefined;
	try {
		let steps = stepsOf(input);
		if (input.from !== undefined) {
			const { turns } = input.from;
			if (turns !== undefined && turns > input.turns.length) throw new Error(`from names ${turns} turns; the scenario has ${input.turns.length}.`);
			const handover = turns ?? steps.length;
			const loaded = await loadVersion(home, id, seen, input.from.version, signal);
			earlier = loaded.checked;
			const before = runnerOf(id, earlier, input);
			const upgrade: NonNullable<ScenarioResult["upgrade"]> = result.upgrade = { version: loaded.version, turns: 0, swipes: 0 };
			try {
				await player.play(before, steps.slice(0, handover), result);
			} finally {
				Object.assign(upgrade, { turns: result.turns.length, swipes: result.swipes.length });
			}
			const refusals = playedRefusals(id, player.cast, input.setup, player.played, earlier, checked);
			if (refusals.length > 0) throw new Error(refusedUpgrade(earlier.descriptor.label, refusals));
			upgrade.changes = stateChanges(before.fold(player.records()), runnerOf(id, checked, input, true).fold(player.records()));
			steps = steps.slice(handover);
		}
		const candidate = runnerOf(id, checked, input, input.from !== undefined);
		await player.play(candidate, steps, result);
		const records = player.records();
		const state = await withBoxOperations([checked], () => candidate.fold(records));
		Object.assign(result, { records, recordBytes: Buffer.byteLength(JSON.stringify(records)), state });
		if (checked.box.status !== undefined) result.status = await withBoxOperations([checked], () => checked.box.status?.(candidate.setup, candidate.fold(records)));
		if (checked.guestRead !== undefined) {
			const scripted = input.snapshot ?? [];
			result.read = await withBoxOperations([checked], () => checked.guestRead!({ setup: candidate.setup, state: candidate.fold(records), human: player.human.id, cast: player.cast.map((member) => ({ ...member, portrait: null, character: null })) }, (json) => {
				const query: unknown = JSON.parse(json);
				assertChecked(snapshotQuery, query, `The ${id} Box's snapshot query`);
				const answer = scripted.find((entry) => Value.Equal(entry.query, query))?.answer;
				if (answer === undefined) throw new Error(`The scenario scripts no snapshot answer for ${json}.`);
				return JSON.stringify(answer);
			})); // @approved guestRead was checked above.
		}
		return { ...result, ok: true };
	} catch (error) {
		return { ...result, diagnostics: [signal.aborted ? "The scenario was cancelled." : error instanceof Error ? error.message : String(error)] };
	} finally {
		player.close();
		earlier?.dispose();
		checked.dispose();
	}
};

// @approved
//  Install's check of one saved scenario: plays every turn and swipe on the
// installed version `earlier`, as far as that version gets, since a
// scenario written for the candidate may stop partway on it and what it
// played is still data a Chat could hold, then returns the writer's Update
// check's refusals for that data against the candidate. A scenario whose
// setup the installed version refuses leaves no Chat behind, so it has
// nothing to check. It ignores the scenario's own `from`.
export const replayRefusals = async (id: BoxId, earlier: CheckedSandboxedBox, candidate: Pick<LoadedBox, "descriptor" | "box">, input: ScenarioInput): Promise<string[]> => {
	let runner: Runner;
	try { runner = runnerOf(id, earlier, input); } catch { return []; }
	const player = scenarioPlayer(id, input, new AbortController().signal);
	try {
		await player.play(runner, stepsOf(input), { turns: [], swipes: [] }).catch(() => undefined);
		return playedRefusals(id, player.cast, input.setup, player.played, earlier, candidate);
	} finally {
		player.close();
	}
};
