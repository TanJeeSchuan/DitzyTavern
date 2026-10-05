import { describe, expect, test } from "bun:test";
import type {
	GenerationIntent,
	PromptBlock,
	PromptImage,
	PromptPlan,
} from "../../shared/contract/conversation-schema";
import { transferRetainedEdits } from "./retry-plan-merge";

const definition = (kind: Exclude<PromptBlock["kind"], "history">, role: "system" | "human" | "model", content: string): PromptBlock =>
	({ kind, role, content });
const history = (role: "human" | "model", speakerName: string, content: string): PromptBlock =>
	({ kind: "history", role, speakerName, content });
const plan = (blocks: PromptBlock[], overrides: Partial<PromptPlan> = {}): PromptPlan =>
	({ blocks, warnings: [], sendImages: true, images: [], ...overrides });
const instructionIntent = (instruction: string): GenerationIntent =>
	({ type: "continuation", strategy: "instruction", instruction });
const image = (disposition: PromptImage["disposition"], tokens: number): PromptImage =>
	({ block: 0, start: 4, hash: "img-1", name: "Sketch", disposition, tokens });

const identity = (content: string) => definition("identity", "system", content);
const lore = (content: string) => definition("lore", "system", content);

describe("retry retained edits", () => {
	test("replays the user's edits when the Chat still assembles the same plan", () => {
		const assembled = plan(
			[identity("Identity"), lore("Lore"), history("human", "Writer", "Hello")],
			{ images: [image("send", 350)] },
		);
		const edited = plan(
			[identity("Identity, annotated"), lore("Lore"), history("human", "Writer", "Hello, kept")],
			{ images: [image("send", 350)] },
		);
		const fresh = plan(
			[identity("Identity"), lore("Lore"), history("human", "Writer", "Hello")],
			{ images: [image("anchor", 0)] },
		);

		expect(transferRetainedEdits(assembled, edited, fresh)).toEqual({
			sendImages: true,
			blocks: edited.blocks,
			warnings: [],
			images: [image("anchor", 0)],
		});
	});

	test("requires inspection when a Definition changed", () => {
		const assembled = plan([identity("Identity"), lore("Lore")]);
		const edited = plan([identity("Identity, annotated"), lore("Lore")]);
		// A model Participant's prompt changed after the failed attempt.
		const fresh = plan([identity("Identity changed"), lore("Lore")]);

		expect(transferRetainedEdits(assembled, edited, fresh)).toBeNull();
	});

	test("requires inspection when the history window changed", () => {
		const assembled = plan([
			history("human", "Writer", "Earlier"),
			history("model", "Maren", "Reply"),
		]);
		const edited = plan([
			history("human", "Writer", "Earlier"),
			history("model", "Maren", "Reply, kept"),
		]);
		// Marking a model text-only re-admitted an older Message.
		const fresh = plan([
			history("human", "Writer", "Oldest"),
			history("human", "Writer", "Earlier"),
			history("model", "Maren", "Reply"),
		]);

		expect(transferRetainedEdits(assembled, edited, fresh)).toBeNull();
	});

	test("requires inspection when the intent changed", () => {
		const assembled = plan([history("model", "Maren", "Reply")], { intent: instructionIntent("Continue the scene") });
		const edited = assembled;
		const fresh = plan([history("model", "Maren", "Reply")], { intent: instructionIntent("Continue differently") });

		expect(transferRetainedEdits(assembled, edited, fresh)).toBeNull();
	});

	test("accepts changed image and warning metadata alone", () => {
		const assembled = plan([identity("Identity")], { images: [image("send", 350)] });
		const edited = assembled;
		const fresh = plan([identity("Identity")], { images: [image("missing", 0)], warnings: [{ block: "identity", macro: "greeting" }] });

		expect(transferRetainedEdits(assembled, edited, fresh)).toEqual(fresh);
	});
});
