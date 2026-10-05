import { describe, expect, test } from "bun:test";
import { compileGenerationPlan } from ".";
import type { CompilePromptDefinition, PromptContextEntry } from "../prompt-compiler";
import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";
import { createAttemptEnvironment } from "../../shared/prompt-macro-engine";
import { formatImageReference } from "../../shared/image-reference";

const A = "a".repeat(64);
const B = "b".repeat(64);
const GONE = "c".repeat(64);

// 1568x1568 costs 1568*1568/750 = 3278.3 -> 3279. 3136x1568 fits to 1568x784: 1639.1 -> 1640.
const dimensions = new Map([
	[A, { width: 1568, height: 1568 }],
	[B, { width: 3136, height: 1568 }],
]);
const COST_A = 3279;
const COST_B = 1640;
const lookup = (hash: string) => dimensions.get(hash);

const ref = (name: string, hash: string) => formatImageReference(name, hash);
const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const human: CompilePromptDefinition = { name: "Writer", prompt };
const model: CompilePromptDefinition = { name: "Maren", prompt };
const entry = (content: string, role: PromptContextEntry["role"]): PromptContextEntry => ({ kind: "message", speakerName: role === "human" ? "Writer" : "Maren", content, role });

const settings = (overrides: Partial<CanonicalGenerationSettings> = {}): CanonicalGenerationSettings => ({
	modelId: "m",
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 1_000_000,
	responseBudget: 100,
	safetyAllowance: 0,
	siblingGenerationLimit: 4,
	continuationStrategy: "instruction",
	continuationInstruction: "Go on.",
	continuationPrefillSuffix: "",
	repeatedImagePlacement: "last",
	requestOverrides: { "chat-completions": {}, responses: {}, "anthropic-messages": {} },
	...overrides,
});

const compile = (
	context: PromptContextEntry[],
	overrides: Partial<CanonicalGenerationSettings> = {},
	extra: Partial<Parameters<typeof compileGenerationPlan>[0]> = {},
) => compileGenerationPlan({
	human,
	model,
	recipe: [{ reference: "history", enabled: true }],
	context,
	settings: settings(overrides),
	connection: { apiFormat: "chat-completions", sendImages: true },
	estimator: () => 0,
	imageLookup: lookup,
	...extra,
});

const dispositions = (plan: ReturnType<typeof compile>) => plan.promptPlan.images.map((image) => image.disposition);

describe("Prompt Plan Images", () => {
	test("Repeated Image Placement picks the first, last, or every stored copy", () => {
		const context = [entry(`one ${ref("map", A)}`, "model"), entry(`two ${ref("map", A)}`, "model"), entry("go", "human")];
		expect(dispositions(compile(context, { repeatedImagePlacement: "first" }))).toEqual(["send", "anchor"]);
		expect(dispositions(compile(context, { repeatedImagePlacement: "last" }))).toEqual(["anchor", "send"]);
		expect(dispositions(compile(context, { repeatedImagePlacement: "every" }))).toEqual(["send", "send"]);
	});

	test("each sent Image adds its fitted w*h/750 cost to the estimate, and anchors add none", () => {
		const context = [entry(`${ref("a", A)} ${ref("a", A)} ${ref("b", B)}`, "model"), entry("go", "human")];
		const every = compile(context, { repeatedImagePlacement: "every" });
		expect(every.budget.tokenEstimate).toBe(COST_A * 2 + COST_B);
		const last = compile(context, { repeatedImagePlacement: "last" });
		expect(last.budget.tokenEstimate).toBe(COST_A + COST_B);
		expect(last.promptPlan.images.map((image) => [image.disposition, image.tokens])).toEqual([["anchor", COST_A], ["send", COST_A], ["send", COST_B]]);
	});

	test("does not charge image tokens when the selected model is text-only", () => {
		const plan = compile(
			[entry("usable prior history", "model"), entry(`${ref("map", A)}`, "human")],
			{ contextLimit: 3_000 },
			{ connection: { apiFormat: "chat-completions", sendImages: false } },
		);

		expect(plan.promptPlan.images).toEqual([{ block: 1, start: 0, hash: A, name: "map", disposition: "text-only", tokens: 0 }]);
		expect(plan.budget.tokenEstimate).toBe(0);
		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.retainedContext.map(({ content }) => content)).toEqual([
			"usable prior history",
			ref("map", A),
		]);
		expect(plan.budget.omittedContext).toEqual([]);
	});

	test("a Reference whose Image is not stored stays an anchor-only missing entry", () => {
		const text = `lost ${ref("ghost", GONE)}`;
		const plan = compile([entry(text, "model"), entry("go", "human")]);
		expect(plan.promptPlan.images).toEqual([{ block: 0, start: 5, hash: GONE, name: "ghost", disposition: "missing", tokens: 0 }]);
		expect(plan.budget.tokenEstimate).toBe(0);
	});

	test("text-only inspection retains missing warnings and captures policy without occurrences", () => {
		const connection = { apiFormat: "chat-completions" as const, sendImages: false };
		const empty = compile([entry("go", "human")], {}, { connection });
		expect(empty.promptPlan.sendImages).toBe(false);
		const missing = compile([entry(ref("ghost", GONE), "human")], {}, { connection });
		expect(missing.promptPlan.images[0]?.disposition).toBe("missing");
	});

	test("a missing copy never takes a placement slot from a stored one", () => {
		const context = [entry(`${ref("a", A)}`, "model"), entry("go", "human")];
		const plan = compile(context, { repeatedImagePlacement: "last" }, { imageLookup: (hash) => (hash === A ? undefined : lookup(hash)) });
		expect(dispositions(plan)).toEqual(["missing"]);
	});

	test("References produced by a Prompt Macro resolve like typed ones", () => {
		const attempt = createAttemptEnvironment({
			self: "Writer",
			other: "Maren",
			conversationId: 1,
			promptPresetId: 1,
			now: new Date("2026-10-04T00:00:00Z"),
			variables: new Map([["outfit", ref("dress", A)]]),
		});
		const plan = compile(
			[entry("go", "human")],
			{},
			{ human: { name: "Writer", prompt: { ...prompt, identity: "Wearing {{getvar::outfit}}" } }, recipe: [{ reference: "human-identity", enabled: true, role: "user" }, { reference: "history", enabled: true }], attempt },
		);
		expect(plan.promptPlan.blocks[0]?.content).toBe(`Wearing ${ref("dress", A)}`);
		expect(plan.promptPlan.images).toEqual([{ block: 0, start: 8, hash: A, name: "dress", disposition: "send", tokens: COST_A }]);
	});

	test("eviction removes whole entries with their Images, and placement is decided over what remains", () => {
		const context = [
			entry(`old ${ref("a", A)}`, "model"),
			entry(`mid ${ref("b", B)}`, "model"),
			entry(`go ${ref("a", A)}`, "human"),
		];
		// Room for one Image beside the protected latest entry's own copy of A.
		const plan = compile(context, { repeatedImagePlacement: "first", contextLimit: COST_A + 100 + 50 });
		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.omittedContext.map((omitted) => omitted.content)).toEqual([`old ${ref("a", A)}`, `mid ${ref("b", B)}`]);
		expect(plan.promptPlan.blocks).toHaveLength(1);
		expect(plan.promptPlan.images).toEqual([{ block: 0, start: 3, hash: A, name: "a", disposition: "send", tokens: COST_A }]);
		expect(plan.budget.tokenEstimate).toBe(COST_A);
	});

	test("last and every placement are also decided over the entries that survive eviction", () => {
		const limit = COST_A + 100 + 50;
		const last = compile([
			entry(`old ${ref("a", A)} ${ref("b", B)}`, "model"),
			entry(`mid ${ref("a", A)}`, "model"),
			entry("go", "human"),
		], { repeatedImagePlacement: "last", contextLimit: limit });
		expect(last.budget.omittedContext).toHaveLength(1);
		expect(last.promptPlan.images.map((image) => [image.block, image.hash, image.disposition])).toEqual([[0, A, "send"]]);

		const every = compile([
			entry(`old ${ref("a", A)}`, "model"),
			entry(`mid ${ref("a", A)}`, "model"),
			entry("go", "human"),
		], { repeatedImagePlacement: "every", contextLimit: limit });
		expect(every.budget.omittedContext).toHaveLength(1);
		expect(every.promptPlan.images.map((image) => [image.block, image.disposition])).toEqual([[0, "send"]]);
		expect(every.budget.tokenEstimate).toBe(COST_A);
	});

	test("the Estimation transcript reads References only as Image Anchors", () => {
		const transcripts: string[] = [];
		compile([entry(`see ${ref("the map", A)} and ${ref("ghost", GONE)}`, "model"), entry("go", "human")], {}, {
			estimator: (transcript) => { transcripts.push(transcript); return 0; },
		});
		expect(transcripts.length).toBeGreaterThan(0);
		for (const transcript of transcripts) {
			expect(transcript).toContain("[Image: the map] and [Image: ghost]");
			expect(transcript).not.toContain(A);
			expect(transcript).not.toContain(GONE);
			expect(transcript).not.toContain("image:");
		}
	});
});
