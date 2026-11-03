import { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import type { BoxId } from "../../shared/contract/box";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { snapshotQuery } from "../../shared/contract/box-sandboxed";
import type { BoxValue } from "../../shared/contract/box-value";
import type { DecisionAnswer } from "../../shared/contract/decision-model";
import type { ScenarioInput, ScenarioResult } from "../../shared/contract/authoring";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { checkedDecisionAnswers } from "../decision-model";
import type { BoxContext, DigestPassage } from "../box/contract";
import { checkSandboxedFolder } from "../box/registry";
import { boxSeed } from "../box/seed";

type Turn = ScenarioResult["turns"][number];

// @approved
//  Runs one scenario on a candidate exactly as the loader would load it: the
// shared folder check, then the Box's hooks as production calls them, on an
// adapter of its own that is freed afterwards. `decide` answers from the
// turn's script and `read`'s `snapshot` from the scenario's, so nothing
// reaches a model or the database. Each turn folds the records selected
// before it, runs `dependencies` and `advance` with its Moves and its own
// seed, and digests its passage; a swipe runs its turn again with that
// turn's seed and Moves and selects the new record without touching later
// ones. The first refusal or failure ends the scenario with its diagnostic.
export const runScenario = async (folder: string, id: BoxId, seen: ReadonlySet<BoxId>, input: ScenarioInput): Promise<ScenarioResult> => {
	const result: ScenarioResult = { ok: false, diagnostics: [], turns: [], swipes: [], records: [], recordBytes: 0 };
	let checked: Awaited<ReturnType<typeof checkSandboxedFolder>>;
	try {
		checked = await checkSandboxedFolder(folder, id, seen);
	} catch (error) {
		return { ...result, diagnostics: [`The candidate did not load: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const database = new Database(":memory:");
	const controller = new AbortController();
	try {
		const { descriptor, box, guestRead } = checked;
		const cast = input.cast.map((name, index) => ({ id: index + 1, name }));
		const human = cast[0]!; // @approved The input schema requires at least one Cast member.
		const speaker = cast[1] ?? human;
		if (descriptor.setup === undefined && input.setup !== undefined) throw new Error(`The ${id} Box declares no setup.`);
		const setup = input.setup ?? descriptor.setup?.initial;
		if (descriptor.setup !== undefined) {
			assertChecked(descriptor.setup.schema, setup, "The scenario's setup");
			const refused = box.setupError?.(setup, descriptor.setup.initial);
			if (refused !== undefined) throw new Error(`The ${id} Box refuses the scenario's setup: ${refused}`);
		}
		const fold = (records: readonly GenerationJsonValue[]) => box.records?.foldAll?.(box.records.initial, records, setup);
		const unavailable = (service: string) => () => { throw new Error(`A scenario has no ${service}.`); };
		const context: BoxContext = { signal: controller.signal, llm: () => undefined, decide: unavailable("decide outside a digest"), embed: unavailable("embed") };
		const history: DigestPassage[] = [];
		const selected: (GenerationJsonValue | undefined)[] = [];
		const run = async (index: number, moves: readonly BoxValue[], prose: string | undefined, scripted: Readonly<Record<string, DecisionAnswer>> | undefined): Promise<Turn & { readonly selection: GenerationJsonValue | undefined }> => {
			if (moves.length > 0 && descriptor.moves === undefined) throw new Error(`Turn ${index} has Moves, but the ${id} Box declares none.`);
			if (descriptor.moves !== undefined) {
				if (moves.length > descriptor.moves.max) throw new Error(`Turn ${index} has ${moves.length} Moves; the ${id} Box allows ${descriptor.moves.max}.`);
				moves.forEach((move, at) => assertChecked(descriptor.moves!.schema, move, `Turn ${index}'s Move ${at}`)); // @approved Checked just above.
			}
			const rendered = moves.map((move) => box.moves!.render(move, human.name)); // @approved The loader requires a render for Moves.
			const seed = boxSeed(`${input.seed}:${index}`, id);
			const state = fold(selected.slice(0, index).flatMap((record) => record === undefined ? [] : [record]));
			const dependencies = box.dependencies?.({ database, conversationId: 0, seed, intent: "respond", human, cast, messages: [], pending: undefined }, setup);
			const advanced = await box.advance?.run({ setup, dependencies, state, moves }, context) ?? { items: [] };
			const digest = box.records?.digest;
			const asked = { messageId: index * 2 + 1, speaker: human.name, authorId: human.id, content: rendered.join("\n") };
			const passage = { messageId: index * 2 + 2, speaker: speaker.name, authorId: speaker.id, content: prose ?? "" };
			const earlier = [...history.slice(0, index * 2), asked];
			const record = digest === undefined ? advanced.record : await digest.run({
				passage, preceding: digest.window === 0 ? [] : earlier.slice(-digest.window), seed,
				cast: cast.map((member) => ({ ...member, removed: false })), data: {},
			}, { ...context, database, decide: async (_state, questions) => {
				const ids = Object.keys(questions);
				const missing = ids.find((question) => scripted?.[question] === undefined);
				if (missing !== undefined) throw new Error(`Turn ${index} scripts no answer for the ${missing} question.`);
				return checkedDecisionAnswers(questions, Object.fromEntries(ids.map((question) => [question, scripted![question]!]))); // @approved Every id was found just above.
			} });
			history.splice(index * 2, 2, asked, passage);
			return { moves: rendered, items: [...advanced.items], ...record !== undefined && { record }, selection: record };
		};
		for (const [index, turn] of input.turns.entries()) {
			const { selection, ...ran } = await run(index, turn.moves ?? [], turn.prose, turn.decisions);
			selected[index] = selection;
			result.turns.push(ran);
		}
		for (const swipe of input.swipes ?? []) {
			const turn = input.turns[swipe.turn];
			if (turn === undefined) throw new Error(`A swipe names turn ${swipe.turn}; the scenario has ${input.turns.length}.`);
			const { selection, ...ran } = await run(swipe.turn, turn.moves ?? [], swipe.prose ?? turn.prose, swipe.decisions ?? turn.decisions);
			selected[swipe.turn] = selection;
			result.swipes.push(ran);
		}
		result.records = selected.flatMap((record) => record === undefined ? [] : [record]);
		result.recordBytes = Buffer.byteLength(JSON.stringify(result.records));
		result.state = fold(result.records);
		if (box.status !== undefined) result.status = box.status(setup, result.state);
		if (guestRead !== undefined) {
			const scripted = input.snapshot ?? [];
			result.read = guestRead({ setup, state: result.state, human: human.id, cast: cast.map((member) => ({ ...member, portrait: null, character: null })) }, (json) => {
				const query: unknown = JSON.parse(json);
				assertChecked(snapshotQuery, query, `The ${id} Box's snapshot query`);
				const answer = scripted.find((entry) => Value.Equal(entry.query, query))?.answer;
				if (answer === undefined) throw new Error(`The scenario scripts no snapshot answer for ${json}.`);
				return JSON.stringify(answer);
			});
		}
		return { ...result, ok: true };
	} catch (error) {
		return { ...result, diagnostics: [error instanceof Error ? error.message : String(error)] };
	} finally {
		controller.abort();
		checked.dispose();
		database.close();
	}
};
