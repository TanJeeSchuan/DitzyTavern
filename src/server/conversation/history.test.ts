import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	DEFAULT_HISTORY_PAGE_SIZE,
	MAX_HISTORY_PAGE_SIZE,
	type ConversationModule,
} from ".";
import type { ConversationCreationInput, ParticipantDefinition } from ".";

// Paginated history read model tests: stable chronological pages, lightweight
// payloads (heavy provenance excluded), resolved Author Stamps, preserved
// Variant order and selected state, and page-boundary behavior. These run
// straight against the public Conversation read seam on a real migrated
// temporary SQLite database.

const prompt = (): ParticipantDefinition["prompt"] => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

const adHoc = (name: string): ParticipantDefinition => ({
	name,
	prompt: prompt(),
	openings: [],
});

const messageInput = (timestamp: string, variantContents: string[]) => ({
	timestamp,
	variants: variantContents.map((content, index) => ({
		content,
		timestamp,
		selected: index === 0,
	})),
});

describe("Conversation paginated history", () => {
	let database: Database;
	let conversation: ConversationModule;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		conversation = createConversationModule(database);
	});
	afterEach(() => {
		database.close();
	});

	const createHistoryChat = (
		count: number,
		overrides: Partial<ConversationCreationInput> = {},
	) =>
		conversation.create({
			name: "History Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
			control: { human: 0, model: 1 },
			messages: Array.from({ length: count }, (_, index) =>
				messageInput(
					new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
					[`Message ${index + 1}`],
				),
			),
			...overrides,
		});

	test("serves stable chronological pages with lightweight fields only", () => {
		const chat = createHistoryChat(6);

		// Page 1 is the latest window of history; each served page is still
		// chronological by creation order.
		const first = conversation.readHistory(chat.id, { page: 1, pageSize: 4 });
		expect(first).toBeDefined();
		expect(first?.page).toEqual({
			index: 1,
			pageSize: 4,
			totalMessages: 6,
			totalPages: 2,
			hasOlder: true,
			hasNewer: false,
		});
		expect(first?.messages.map((message) => message.position)).toEqual([3, 4, 5, 6]);
		expect(first?.messages.map((message) => message.timestamp)).toEqual([
			"2026-01-01T00:02:00.000Z",
			"2026-01-01T00:03:00.000Z",
			"2026-01-01T00:04:00.000Z",
			"2026-01-01T00:05:00.000Z",
		]);

		const second = conversation.readHistory(chat.id, { page: 2, pageSize: 4 });
		expect(second?.page.hasOlder).toBe(false);
		expect(second?.page.hasNewer).toBe(true);
		expect(second?.messages.map((message) => message.position)).toEqual([1, 2]);

		// Pages never overlap and together cover the whole sequence.
		const allPositions = [
			...(first?.messages ?? []),
			...(second?.messages ?? []),
		].map((message) => message.position);
		expect(allPositions).toEqual([3, 4, 5, 6, 1, 2]);
	});

	test("bounds an oversized page request to the final page and clamps the page size", () => {
		const chat = createHistoryChat(5);

		// A page far beyond the end serves the final, oldest page, so
		// accumulating clients converge instead of seeing empty pages
		// mid-sequence.
		const beyond = conversation.readHistory(chat.id, { page: 99, pageSize: 2 });
		expect(beyond?.page.index).toBe(3);
		expect(beyond?.page.totalPages).toBe(3);
		expect(beyond?.messages.map((message) => message.position)).toEqual([1]);

		// Page size bounds to the module maximum and defaults when missing.
		const capped = conversation.readHistory(chat.id, { pageSize: 10_000 });
		expect(capped?.page.pageSize).toBe(MAX_HISTORY_PAGE_SIZE);
		const defaulted = conversation.readHistory(chat.id);
		expect(defaulted?.page.pageSize).toBe(DEFAULT_HISTORY_PAGE_SIZE);
	});

	test("exposes resolved Author Stamps and preserves Variant order and selected state", () => {
		const chat = conversation.create({
			name: "Stamped History",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
			control: { human: 0, model: 1 },
			messages: [
				{
					timestamp: "2026-01-01T00:00:00.000Z",
					authorParticipantIndex: 0,
					variants: [
						{
							content: "Second alternative",
							timestamp: "2026-01-01T00:00:05.000Z",
							selected: true,
						},
						{
							content: "First alternative",
							timestamp: "2026-01-01T00:00:01.000Z",
							selected: false,
						},
					],
				},
			],
		});

		const page = conversation.readHistory(chat.id, { pageSize: 10 });
		expect(page?.cast.map((participant) => participant.name)).toEqual([
			"Writer",
			"Maren Voss",
		]);
		const [message] = page?.messages ?? [];
		// The Author Stamp carries the stable Participant identity and the
		// captured name; no source role flag is involved.
		expect(message?.author).toEqual({
			participantId: chat.cast[0]?.id,
			capturedName: "Writer",
			inCast: true,
		});
		// Variant order is preserved with the persisted selected state.
		expect(message?.variants.map((variant) => variant.content)).toEqual([
			"Second alternative",
			"First alternative",
		]);
		expect(
			message?.variants.map((variant) => ({
				position: variant.position,
				selected: variant.selected,
			})),
		).toEqual([
			{ position: 1, selected: true },
			{ position: 2, selected: false },
		]);
	});

	test("keeps empty and duplicate Variants as distinct positions with exact content", () => {
		const chat = conversation.create({
			name: "Variant History",
			participants: [{ definition: adHoc("Writer") }],
			messages: [
				{
					timestamp: "2026-01-01T00:00:00.000Z",
					variants: [
						{ content: "Once", timestamp: "2026-01-01T00:00:00.000Z", selected: false },
						{ content: "Once", timestamp: "2026-01-01T00:00:01.000Z", selected: true },
						{ content: "", timestamp: "2026-01-01T00:00:02.000Z", selected: false },
					],
				},
			],
		});

		const page = conversation.readHistory(chat.id, { pageSize: 10 });
		// The duplicate and the exact empty alternative remain separate
		// navigable positions; the empty content is untouched stored text.
		expect(page?.messages[0]?.variants.map((variant) => variant.content)).toEqual([
			"Once",
			"Once",
			"",
		]);
		expect(page?.messages[0]?.variants.length).toBe(3);
	});

	test("returns persisted Generation Reasoning Content in authoritative history", () => {
		const chat = conversation.create({
			name: "Reasoning History",
			participants: [{ definition: adHoc("Writer") }],
			messages: [{
				timestamp: "2026-01-01T00:00:00.000Z",
				variants: [
					{
						content: "Visible prose.",
						timestamp: "2026-01-01T00:00:00.000Z",
						selected: true,
						data: [{
							namespace: "generation",
							key: "reasoning",
							value: "Persisted thought.",
						}],
					},
					{
						content: "Alternative prose.",
						timestamp: "2026-01-01T00:00:01.000Z",
						selected: false,
						data: [{
							namespace: "generation",
							key: "reasoning",
							value: "Alternative thought.",
						}],
					},
				],
			}],
		});

		const page = conversation.readHistory(chat.id, { pageSize: 10 });
			expect(page?.messages[0]?.variants[0]).toMatchObject({
				content: "Visible prose.",
				reasoning: "Persisted thought.",
			});
			expect(page?.messages[0]?.variants[1]).toMatchObject({
				content: "Alternative prose.",
				reasoning: "Alternative thought.",
			});
	});

	test("excludes heavy provenance from ordinary reads: no message, variant, or Chat data", () => {
		const chat = conversation.create({
			name: "Lightweight",
			participants: [{ definition: adHoc("Writer") }],
			messages: [
				{
					timestamp: "2026-01-01T00:00:00.000Z",
					data: [{ namespace: "import.sillytavern", key: "author.name", value: "Writer" }],
					variants: [
						{
							content: "Prose",
							timestamp: "2026-01-01T00:00:00.000Z",
							selected: true,
							data: [
								{
									namespace: "import.sillytavern",
									key: "variant.reasoning.text",
									value: "long reasoning payload",
								},
								{
									namespace: "import.sillytavern",
									key: "variant.reasoning.signature",
									value: "signature-abc",
								},
							],
						},
					],
				},
			],
			data: [
				{
					namespace: "archive",
					key: "source",
					value: JSON.stringify({ heavy: "canonical archive text" }),
				},
			],
		});

		const page = conversation.readHistory(chat.id, { pageSize: 10 });
		expect(page?.messages[0]?.variants[0]).not.toHaveProperty("data");
		expect(page?.messages[0]).not.toHaveProperty("data");
		expect(page).not.toHaveProperty("data");
		// The exact archive text never crosses the read model.
		expect(JSON.stringify(page)).not.toContain("canonical archive text");
		expect(JSON.stringify(page)).not.toContain("long reasoning payload");
		expect(JSON.stringify(page)).not.toContain("signature-abc");
	});

	test("returns undefined for a missing Conversation", () => {
		expect(conversation.readHistory(999999)).toBeUndefined();
	});
});
