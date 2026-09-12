import { expect, test } from "bun:test";
import {
	createPromptPresetEditorState,
	createPromptPresetEditorOperationRunner,
	operationApplies,
	reducePromptPresetEditorState,
	type OperationStartEffects,
	type PromptPresetEditorEvent,
	type PromptPresetEditorState,
} from "../../prompt-preset-editor-state";

const effects: OperationStartEffects = {
	supersedesReads: false,
	ownsConversation: false,
	clearNotice: false,
	clearProblem: false,
};

test("the public operation runner refuses a second active operation", async () => {
	let state = createPromptPresetEditorState("open:1", 1);
	const current = (): PromptPresetEditorState => state;
	const dispatch = (event: PromptPresetEditorEvent): void => {
		state = reducePromptPresetEditorState(state, event);
	};
	const runner = createPromptPresetEditorOperationRunner({
		current,
		dispatch,
		canStart: () => !state.busy,
		ownsOperation: (claim) => operationApplies(state, claim),
	});
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	let calls = 0;
	const first = runner(effects, async () => {
		calls += 1;
		await held;
		return "first";
	});
	const second = await runner(effects, async () => {
		calls += 1;
		return "second";
	});

	expect(second).toBeUndefined();
	expect(calls).toBe(1);
	expect(state.busy).toBe(true);

	release();
	expect(await first).toBe("first");
	expect(state.busy).toBe(false);
});
