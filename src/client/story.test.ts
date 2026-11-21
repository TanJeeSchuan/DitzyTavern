import { describe, expect, test } from "bun:test";
import { historyVariant, historyMessage, historyPage } from "./test-fixtures/conversation";
import {
	EMPTY_VARIANT_PLACEHOLDER,
	canOfferSiblingGeneration,
	classifyVariantSelection,
	createStoryOverlays,
	displayedVariantId,
	isPreviewDownstream,
	previewOnMessage,
	readStory,
	reduceStoryOverlays,
	retireStoryOverlays,
	reusesTrailingHumanMessage,
	shownMessage,
	toStoryMessage,
	visibleVariantContent,
	type StoryOverlays,
} from "./story";

const older = historyMessage({ id: 10, position: 1, variants: [
	historyVariant(),
	historyVariant({ id: 101, position: 2, content: "Alternative", selected: false }),
] });
const later = historyMessage({ id: 20, position: 2, variants: [
	historyVariant({ id: 200, content: "Afterward" }),
	historyVariant({ id: 201, position: 2, content: "Alternate ending", selected: false }),
] });
const history = (messages = [older, later], revision = 3, hasNewer = false) => ({
	revision, page: historyPage({ page: { hasNewer } }).page, messages: messages.map(toStoryMessage),
});
const read = (overlays: StoryOverlays, window = history(), activeGenerations: { generationId: number }[] = []) =>
	readStory({
		overlays: retireStoryOverlays(overlays, window, { revision: window.revision, activeGenerations }),
		window, conversationId: 7, loadingMore: false, historyFailed: false,
	});

describe("Preview", () => {
	test("an older Variant only changes the local reading until Confirm", () => {
		const window = history();
		const first = window.messages[0]!;
		const last = window.messages[1]!;
		const clean = createStoryOverlays();
		expect(classifyVariantSelection(read(clean, window), first.id, 101).kind).toBe("preview");
		const previewing = reduceStoryOverlays(clean, { type: "preview-changed", preview: previewOnMessage(first, 101) });
		const preview = read(previewing, window);
		expect(displayedVariantId(preview, first)).toBe(101);
		expect(isPreviewDownstream(last, preview.preview)).toBe(true);
		expect(classifyVariantSelection(preview, last.id, 201).kind).toBe("blocked");
		expect(displayedVariantId(read(clean, window), first)).toBe(100);

		const request = { value: 101 };
		const confirmed = reduceStoryOverlays(previewing, { type: "preview-confirmed", messageId: first.id, request });
		const accepted = reduceStoryOverlays(confirmed, { type: "selection-settled", messageId: first.id, request, revision: 4 });
		expect(isPreviewDownstream(last, read(confirmed, window).preview)).toBe(false);
		expect(displayedVariantId(read(accepted, window), first)).toBe(101);

		const changed = { ...older, variants: [historyVariant({ selected: false }), historyVariant({ id: 101, position: 2 })] };
		const refreshed = read(accepted, history([changed, later], 4));
		expect(displayedVariantId(refreshed, refreshed.messages[0]!)).toBe(101);
		const laterRead = read(refreshed, history([older, later], 5));
		expect(displayedVariantId(laterRead, laterRead.messages[0]!)).toBe(100);
	});

	test("the last loaded Message previews if newer history is off screen", () => {
		const overlays = createStoryOverlays();
		expect(classifyVariantSelection(read(overlays, history([older], 3, true)), 10, 101).kind).toBe("preview");
		expect(classifyVariantSelection(read(overlays, history([older])), 10, 101).kind).toBe("immediate");
	});

	test("returning to the selected Variant or losing the previewed Variant ends Preview", () => {
		const window = history();
		const first = window.messages[0]!;
		const preview = reduceStoryOverlays(createStoryOverlays(), { type: "preview-changed", preview: previewOnMessage(first, 101) });
		expect(read(preview, window).preview?.variantId).toBe(101);
		expect(previewOnMessage(first, 100)).toBeNull();
		const withoutAlternative = { ...older, variants: [historyVariant()] };
		expect(read(preview, history([withoutAlternative, later], 4)).preview).toBeNull();
	});
});

describe("Requested Generation", () => {
	const request = (variantId: number) => reduceStoryOverlays(
		reduceStoryOverlays(createStoryOverlays(), { type: "generation-requested", request: { kind: "sibling", messageId: 20 } }),
		{ type: "generation-request-accepted", generationId: 9, variantId, sentRevision: 3 },
	);

	test("a Requested Swipe holds an empty slot until its accepted Variant appears", () => {
		const accepted = request(202);
		const running = read(accepted, history([older, later], 4), [{ generationId: 9 }]);
		const message = shownMessage(running, running.messages[1]!);
		expect(message.swipes.at(-1)).toMatchObject({ id: displayedVariantId(running, message), content: "", empty: true });

		const placed = { ...later, variants: [
			...later.variants.map((variant) => ({ ...variant, selected: false })),
			historyVariant({ id: 202, position: 3 }),
		] };
		const ready = read(accepted, history([older, placed], 4), [{ generationId: 9 }]);
		expect(shownMessage(ready, ready.messages[1]!).swipes.map(({ id }) => id)).toEqual([200, 201, 202]);
		expect(displayedVariantId(ready, ready.messages[1]!)).toBe(202);
	});

	test("an ended attempt without a Variant gives the row back to history", () => {
		const accepted = request(202);
		const olderRead = read(accepted);
		expect(displayedVariantId(olderRead, olderRead.messages[1]!)).toBe(-1);
		const ended = read(accepted, history([older, later], 5));
		expect(displayedVariantId(ended, ended.messages[1]!)).toBe(200);
	});

	test("reuses the trailing human Message only for the same writer, Content and Moves", () => {
		const story = read(createStoryOverlays(), history([older]));
		const texted = { phone: [{ to: "Mara", text: "Running late" }] };
		expect(reusesTrailingHumanMessage(story, 1, "Once", undefined)).toBe(true);
		expect(reusesTrailingHumanMessage(story, 1, "Once more", undefined)).toBe(false);
		expect(reusesTrailingHumanMessage(story, 2, "Once", undefined)).toBe(false);
		expect(reusesTrailingHumanMessage(story, 1, "Once", texted)).toBe(false);
		expect(reusesTrailingHumanMessage(read(createStoryOverlays(), history([{ ...older, moves: texted }])), 1, "Once", texted)).toBe(true);
	});
});

test("accepted Moves stay visible until history catches up and permits another edit", () => {
	const messageId = older.id;
	const olderMoves = { phone: [{ to: "Mara", text: "Wait" }] };
	const newMoves = { phone: [{ to: "Mara", text: "Go" }] };
	const first = { value: olderMoves };
	const second = { value: newMoves };
	let overlays = reduceStoryOverlays(createStoryOverlays(), { type: "moves-requested", messageId, request: first });
	overlays = reduceStoryOverlays(overlays, { type: "moves-settled", messageId, request: first, revision: 4 });
	const stale = read(overlays);
	expect(shownMessage(stale, stale.messages[0]!).moves).toEqual(olderMoves);
	const firstApplied = history([{ ...older, moves: olderMoves }], 4);
	overlays = retireStoryOverlays(overlays, firstApplied, null);
	overlays = reduceStoryOverlays(overlays, { type: "moves-requested", messageId, request: second });
	overlays = reduceStoryOverlays(overlays, { type: "moves-settled", messageId, request: second, revision: 5 });
	expect(shownMessage(read(overlays, firstApplied), firstApplied.messages[0]!).moves).toEqual(newMoves);
	const changedElsewhere = read(overlays, history([{ ...older, moves: {} }], 6));
	expect(shownMessage(changedElsewhere, changedElsewhere.messages[0]!).moves).toEqual({});
});

test("a refused queued Swipe reveals the earlier selection after history catches up", () => {
	const messageId = older.id;
	const first = { value: 101 };
	const second = { value: 100 };
	let overlays = reduceStoryOverlays(createStoryOverlays(), { type: "selection-requested", messageId, request: first });
	overlays = reduceStoryOverlays(overlays, { type: "selection-requested", messageId, request: second });
	overlays = reduceStoryOverlays(overlays, { type: "selection-settled", messageId, request: first, revision: 4 });
	const applied = { ...older, variants: [historyVariant({ selected: false }), historyVariant({ id: 101, position: 2 })] };
	const refreshed = history([applied], 4);
	overlays = retireStoryOverlays(overlays, refreshed, null);
	const pending = read(overlays, refreshed);
	expect(displayedVariantId(pending, pending.messages[0]!)).toBe(100);
	overlays = reduceStoryOverlays(overlays, { type: "selection-settled", messageId, request: second, revision: null });
	const refused = read(overlays, refreshed);
	expect(displayedVariantId(refused, refused.messages[0]!)).toBe(101);
});

test("a refused Moves edit reveals the latest persisted Moves", () => {
	const messageId = older.id;
	const first = { value: { phone: [{ to: "Mara", text: "Wait" }] } };
	const second = { value: { phone: [{ to: "Mara", text: "Go" }] } };
	const persisted = history([{ ...older, moves: first.value }, later], 4);
	let overlays = reduceStoryOverlays(createStoryOverlays(), { type: "moves-requested", messageId, request: second });
	const pending = read(overlays, persisted);
	expect(shownMessage(pending, pending.messages[0]!).moves).toEqual(second.value);
	overlays = reduceStoryOverlays(overlays, { type: "moves-settled", messageId, request: second, revision: null });
	const refused = read(overlays, persisted);
	expect(shownMessage(refused, refused.messages[0]!).moves).toEqual(first.value);
	const refreshed = read(overlays, history([{ ...older, moves: {} }, later], 5));
	expect(shownMessage(refreshed, refreshed.messages[0]!).moves).toEqual({});
});

test("only an exact empty Variant shows the presentation placeholder", () => {
	const message = toStoryMessage(historyMessage({ variants: [
		historyVariant({ content: "", empty: true }),
		historyVariant({ id: 101, position: 2, content: "  ", selected: false }),
	] }));
	expect(message.swipes.map(visibleVariantContent)).toEqual([EMPTY_VARIANT_PLACEHOLDER, "  "]);
});

test("New Swipe uses history eligibility and allows parallel attempts only at the same Message", () => {
	const message = toStoryMessage({ ...older, swipe: { eligible: true, reason: null } });
	const target = { message, playable: true, previewActive: false, activeGenerationMessageIds: [message.id] };
	expect(canOfferSiblingGeneration(target)).toBe(true);
	expect(canOfferSiblingGeneration({ ...target, activeGenerationMessageIds: [later.id] })).toBe(false);
	expect(canOfferSiblingGeneration({ ...target, previewActive: true })).toBe(false);
	expect(canOfferSiblingGeneration({ ...target, playable: false })).toBe(false);
	expect(canOfferSiblingGeneration({ ...target, message: { ...message, swipe: { eligible: false, reason: "missing-historical-context" } } })).toBe(false);
});
