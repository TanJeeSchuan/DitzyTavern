import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq } from "drizzle-orm";
import { createArtifactModule, type ArtifactModule } from "../artifact";
import { openDatabase } from "../database/database";
import {
	artifactTable,
	chatDataTable,
	chatTable,
	conversationControlTable,
	messageTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	IMPORTER_VERSION,
	UNKNOWN_IMPORTED_AUTHOR_NAME,
	VARIANT_KEYS,
	importSillyTavernChat,
} from "./index";
import { SillyTavernImportError } from "./errors";
import type { SillyTavernImportReport } from "./adapter";
import {
	ConversationNotPlayableError,
	SiblingVariantUnavailableError,
	createConversationModule,
} from "../conversation";
import { createFakeModelClient } from "../model-client";
import {
	generateSiblingVariant,
} from "../workflows";
import { generateTerminalTailFixture } from "../workflows/generate";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	provenancedPayloadFixture as provenancedPayload,
	rulershipFixture as second,
	swipeRecordFixture as swiped,
	writerFixture as first,
} from "./fixtures";

const findEntry = (
	entries: { namespace: string; key: string; value: string }[] | undefined,
	namespace: string,
	key: string,
) => entries?.find((entry) => entry.namespace === namespace && entry.key === key);

describe("SillyTavern chat import", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let artifacts: ArtifactModule;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-import-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		artifacts = createArtifactModule(database, { directory: artifactDirectory });
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
	});

	// Every import call in these tests preserves the exact source bytes in
	// an isolated managed artifact directory, through the same public
	// signature the developer command uses.
	const importChat = (sourcePath: string) =>
		importSillyTavernChat(database, sourcePath, artifactDirectory);

	const writeSource = (records: unknown[], filename = "lantern-house.jsonl") => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, jsonl(records), "utf8");
		return path;
	};

	// Writes raw source bytes (BOM, CRLF, escape spelling, and trailing
	// newlines included) without re-serializing through the fixture helper.
	const writeSourceRaw = (text: string, filename: string) => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, Buffer.from(text, "utf8"));
		return path;
	};

	const sha256Of = (records: unknown[]) =>
		createHash("sha256")
			.update(Buffer.from(jsonl(records), "utf8"))
			.digest("hex");

	const countRows = (
		table:
			| typeof chatTable
			| typeof messageTable
			| typeof messageVariantTable
			| typeof chatDataTable
			| typeof artifactTable
			| typeof participantTable,
	) => drizzle(database).select().from(table).all().length;

	test("imports a payload-only JSONL file end to end as a Participant Conversation", () => {
		const path = writeSource([header, first, second, blankName]);
		const result = importChat(path);
		const conversation = result.conversation;

		// The Chat takes its temporary name from the filename stem.
		expect(conversation.name).toBe("lantern-house");
		expect(conversation.revision).toBe(0);
		// Every exact resolved source-author group becomes a named
		// Participant in first-appearance order with an empty typed Prompt
		// and no openings: Writer, Rulership, and the shared blank-resolved
		// group using the imported-author placeholder.
		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			"Writer",
			"Rulership",
			UNKNOWN_IMPORTED_AUTHOR_NAME,
		]);
		expect(conversation.cast.map((participant) => participant.position)).toEqual([
			1, 2, 3,
		]);
		for (const participant of conversation.cast) {
			expect(participant.prompt).toEqual({
				systemInstruction: "",
				identity: "",
				scenario: "",
				exampleDialogue: "",
				postHistoryInstruction: "",
			});
			expect(participant.openings).toEqual([]);
			expect(participant.sourceCharacterId).toBeNull();
		}

		// Deterministic Control by first resolved appearance: Writer human,
		// Rulership model, the blank-resolved Participant unseated.
		const [writer, rulership, blankAuthor] = conversation.cast;
		expect(writer).toBeDefined();
		expect(rulership).toBeDefined();
		expect(blankAuthor).toBeDefined();
		expect(conversation.control).toEqual({
			humanParticipantId: writer?.id ?? null,
			modelParticipantId: rulership?.id ?? null,
		});
		expect(conversation.controlValidity).toEqual({
			valid: true,
			reason: null,
		});
		expect(conversation.playable).toBe(true);
		expect(conversation.capabilities).toEqual({
			compose: { available: true, reason: null },
			generate: { available: true, reason: null },
			swipe: { available: true, reason: null },
		});

		expect(conversation.messages).toHaveLength(3);
		expect(conversation.messages.map((message) => message.position)).toEqual([
			1, 2, 3,
		]);
		expect(
			conversation.messages[2]?.variants[0]?.content,
		).toBe("🔥 Wait, truly?");

		// Every imported Message receives a native immutable Author Stamp
		// for its resolved Participant while the exact raw source author
		// value — including the blank string — stays untouched in the
		// message-level preserved data.
		expect(
			conversation.messages.map((message) => message.author?.participantId),
		).toEqual([writer?.id, rulership?.id, blankAuthor?.id]);
		expect(
			conversation.messages.map((message) => message.author?.capturedName),
		).toEqual(["Writer", "Rulership", UNKNOWN_IMPORTED_AUTHOR_NAME]);
		expect(
			conversation.messages.every((message) => message.author?.inCast === true),
		).toBe(true);
		expect(conversation.messages[0]?.data).toEqual([
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.authorName,
				value: "Writer",
			},
		]);
		expect(conversation.messages[2]?.data).toEqual([
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.authorName,
				value: "",
			},
		]);

		// No historical Control context is ever fabricated for imported
		// Messages: deterministic current Control does not reinterpret
		// history, so targeted Swipe reports the missing-context denial.
		expect(
			conversation.messages.every((message) => message.historicalContext === null),
		).toBe(true);
		expect(
			conversation.messages.every(
				(message) =>
					message.swipe.eligible === false &&
					message.swipe.reason === "missing-historical-context",
			),
		).toBe(true);

		// Chat and activity times are derived from the mapped timestamps.
		const chatRow = drizzle(database)
			.select()
			.from(chatTable)
			.where(eq(chatTable.id, conversation.id))
			.get();
		expect(chatRow?.creation_time).toBe("2026-08-08T12:53:02.008Z");
		expect(chatRow?.last_message_time).toBe("2026-08-08T13:10:00.000Z");

		// The canonical archive round-trips the entire parsed source.
		const archive = findEntry(
			conversation.data,
			ARCHIVE_NAMESPACE,
			ARCHIVE_KEY,
		);
		expect(JSON.parse(archive?.value ?? "")).toEqual({
			header,
			messages: [first, second, blankName],
		});

		// Source identity, counts, importer version, warnings, and the JSON
		// report remain separate entries in the transitional import namespace.
		const sha256 = sha256Of([header, first, second, blankName]);
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.sha256)
				?.value,
		).toBe(sha256);
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.integrity)
				?.value,
		).toBe("9543f21f-8aab-42c8-92a4-1f6453d4b63c");
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.filename)
				?.value,
		).toBe("lantern-house.jsonl");
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.importerVersion)
				?.value,
		).toBe(IMPORTER_VERSION);
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.countsMessages)
				?.value,
		).toBe("3");
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.countsVariants)
				?.value,
		).toBe("3");
		expect(
			JSON.parse(
				findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.warnings)
					?.value ?? "",
			),
		).toEqual([
			"Message at position 3 has a blank captured author name.",
		]);
		expect(
			JSON.parse(
				findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.reportJson)
					?.value ?? "",
			),
		).toEqual(result.report);

		// The result is readable through the public snapshot seam.
		expect(
			createConversationModule(database).getSnapshot(conversation.id),
		).toEqual(conversation);
	});

	test("commits a zero-Participant source atomically as an incomplete archive", () => {
		const path = writeSource([header]);
		const result = importChat(path);
		const conversation = result.conversation;

		expect(conversation.cast).toEqual([]);
		expect(conversation.messages).toEqual([]);
		expect(conversation.control).toEqual({
			humanParticipantId: null,
			modelParticipantId: null,
		});
		expect(conversation.controlValidity).toEqual({
			valid: false,
			reason: "missing-seat",
		});
		expect(conversation.playable).toBe(false);
		expect(conversation.capabilities).toEqual({
			compose: { available: false, reason: "conversation-not-playable" },
			generate: { available: false, reason: "conversation-not-playable" },
			swipe: { available: false, reason: "conversation-not-playable" },
		});
		// No Control rows are invented for an empty archive.
		expect(
			drizzle(database).select().from(conversationControlTable).all().length,
		).toBe(0);
		expect(
			drizzle(database).select().from(participantTable).all().length,
		).toBe(0);

		// The canonical archive and counts still preserve the source.
		const archive = findEntry(
			conversation.data,
			ARCHIVE_NAMESPACE,
			ARCHIVE_KEY,
		);
		expect(JSON.parse(archive?.value ?? "")).toEqual({
			header,
			messages: [],
		});
		expect(result.report.counts).toEqual({ messages: 0, variants: 0 });
		expect(
			createConversationModule(database).getSnapshot(conversation.id),
		).toEqual(conversation);
	});

	test("reserves only the human seat for a one-Participant source and commits it incomplete", () => {
		const path = writeSource([header, first]);
		const result = importChat(path);
		const conversation = result.conversation;

		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			"Writer",
		]);
		const writer = conversation.cast[0];
		expect(writer).toBeDefined();
		expect(conversation.control).toEqual({
			humanParticipantId: writer?.id ?? null,
			modelParticipantId: null,
		});
		expect(conversation.playable).toBe(false);
		expect(conversation.capabilities).toEqual({
			compose: { available: false, reason: "conversation-not-playable" },
			generate: { available: false, reason: "conversation-not-playable" },
			swipe: { available: false, reason: "conversation-not-playable" },
		});
		expect(
			drizzle(database).select().from(conversationControlTable).all().length,
		).toBe(1);

		// The preserved history is still readable with its resolved author
		// stamp; no historical pair is fabricated.
		expect(conversation.messages).toHaveLength(1);
		expect(conversation.messages[0]?.author).toEqual({
			participantId: writer?.id ?? null,
			capturedName: "Writer",
			inCast: true,
		});
		expect(conversation.messages[0]?.historicalContext).toBeNull();
		expect(conversation.messages[0]?.variants).toHaveLength(1);
		expect(conversation.messages[0]?.swipe).toEqual({
			eligible: false,
			reason: "conversation-not-playable",
		});

		// The report promises the preserved single Message.
		expect(result.report.counts).toEqual({ messages: 1, variants: 1 });
		expect(
			createConversationModule(database).getSnapshot(conversation.id),
		).toEqual(conversation);
	});

	test("assigns Control by first resolved appearance and ignores role hints", () => {
		// Rulership (is_user false) appears first and becomes the human
		// seat; Writer (is_user true) appears second and becomes the model
		// seat — legacy role hints never drive identity or Control.
		const path = writeSource([header, second, first]);
		const { conversation } = importChat(path);

		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			"Rulership",
			"Writer",
		]);
		const [rulership, writer] = conversation.cast;
		expect(rulership).toBeDefined();
		expect(writer).toBeDefined();
		expect(conversation.control).toEqual({
			humanParticipantId: rulership?.id ?? null,
			modelParticipantId: writer?.id ?? null,
		});
		expect(conversation.playable).toBe(true);
	});

	test("keeps later resolved Participants unseated with plain removal eligibility", () => {
		const records = [
			{ name: "Alpha", is_user: true, send_date: "2026-08-08T12:00:00.000Z", mes: "a" },
			{ name: "Beta", is_user: false, send_date: "2026-08-08T12:01:00.000Z", mes: "b" },
			{ name: "Gamma", is_user: true, send_date: "2026-08-08T12:02:00.000Z", mes: "c" },
			{ name: "Delta", is_user: false, send_date: "2026-08-08T12:03:00.000Z", mes: "d" },
		];
		const { conversation } = importChat(
			writeSource([header, ...records]),
		);

		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			"Alpha", "Beta", "Gamma", "Delta",
		]);
		const [alpha, beta, gamma, delta] = conversation.cast;
		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		expect(gamma).toBeDefined();
		expect(delta).toBeDefined();
		// First human, second model, later Participants unseated.
		expect(conversation.control).toEqual({
			humanParticipantId: alpha?.id ?? null,
			modelParticipantId: beta?.id ?? null,
		});
		expect(conversation.playable).toBe(true);
		// The unseated Participants are removable (their own Messages demand
		// a tombstone) while the seated pair is protected.
		expect(gamma?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "tombstone",
			affectedGenerationCount: 0,
		});
		expect(delta?.removal.eligible).toBe(true);
		expect(alpha?.removal.eligible).toBe(false);
		expect(beta?.removal.eligible).toBe(false);
	});

	test("collapses duplicate and surrounding-whitespace author names while preserving case", () => {
		const trailingSpace = {
			...first,
			send_date: "2026-08-08T12:54:00.000Z",
			mes: "same author, spaces around the captured name",
		};
		// The source fixture has name " Writer " here: trimming resolves it
		// to the same group as "Writer" while the exact raw value stays in
		// the preserved data.
		trailingSpace.name = " Writer ";
		const lowerCase = {
			name: "writer",
			is_user: false,
			send_date: "2026-08-08T12:55:00.000Z",
			mes: "case-preserved separate group",
		};
		const { conversation } = importChat(
			writeSource([header, first, trailingSpace, lowerCase]),
		);

		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			"Writer",
			"writer",
		]);
		const [writer, lowercaseWriter] = conversation.cast;
		expect(writer).toBeDefined();
		expect(lowercaseWriter).toBeDefined();
		expect(conversation.control).toEqual({
			humanParticipantId: writer?.id ?? null,
			modelParticipantId: lowercaseWriter?.id ?? null,
		});
		// Both "Writer" and " Writer " share one Participant and one stamp;
		// the lowercase writer is a distinct identity. Each Message keeps its
		// exact raw source value untouched in the preserved data.
		expect(
			conversation.messages.map((message) => message.author?.participantId),
		).toEqual([writer?.id, writer?.id, lowercaseWriter?.id]);
		expect(
			conversation.messages.map((message) => message.data[0]?.value),
		).toEqual(["Writer", " Writer ", "writer"]);
	});

	test("collapses all blank source author names into one shared Participant", () => {
		const anotherBlank = {
			name: "",
			is_user: false,
			send_date: "2026-08-08T13:11:00.000Z",
			mes: "also missing an author name",
		};
		const { conversation, report } = importChat(
			writeSource([header, blankName, anotherBlank]),
		);

		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			UNKNOWN_IMPORTED_AUTHOR_NAME,
		]);
		const blankAuthor = conversation.cast[0];
		expect(blankAuthor).toBeDefined();
		// Blank values resolve to one shared Participant; the native name is
		// nonblank while each Message keeps its raw empty value.
		expect(
			conversation.messages.every(
				(message) => message.author?.participantId === blankAuthor?.id,
			),
		).toBe(true);
		expect(
			conversation.messages.map((message) => message.data[0]?.value),
		).toEqual(["", ""]);
		expect(conversation.messages[0]?.author?.capturedName).toBe(
			UNKNOWN_IMPORTED_AUTHOR_NAME,
		);
		expect(report.warnings).toHaveLength(2);
		expect(report.warnings[0]).toContain("position 1");
		expect(report.warnings[1]).toContain("position 2");
	});

	test("keeps a blank group and a literal Blank Author group as distinct Participants", () => {
		const literalBlankAuthor = {
			name: "Blank Author",
			is_user: false,
			send_date: "2026-08-08T13:12:00.000Z",
			mes: "a real captured author named like the resolved fallback",
		};
		const { conversation, report } = importChat(
			writeSource([header, blankName, literalBlankAuthor]),
		);

		// The blank group (resolved key null) and the literal "Blank Author"
		// group (key "Blank Author") never collapse into one identity: both
		// stay separate native Participants with distinct names — a name is
		// never an identity key, and the placeholder is just another name.
		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			UNKNOWN_IMPORTED_AUTHOR_NAME,
			"Blank Author",
		]);
		expect(
			conversation.cast.map((participant) => participant.duplicateLabel),
		).toEqual([UNKNOWN_IMPORTED_AUTHOR_NAME, "Blank Author"]);
		const [blankGroup, literalGroup] = conversation.cast;
		expect(blankGroup?.id).not.toBe(literalGroup?.id);
		expect(conversation.messages[0]?.author?.participantId).toBe(blankGroup?.id);
		expect(conversation.messages[1]?.author?.participantId).toBe(literalGroup?.id);
		// Each Message keeps its exact raw source author value untouched.
		expect(
			conversation.messages.map((message) => message.data[0]?.value),
		).toEqual(["", "Blank Author"]);
		expect(conversation.messages[0]?.author?.inCast).toBe(true);
		expect(conversation.messages[1]?.author?.inCast).toBe(true);
		expect(report.warnings).toEqual([
			"Message at position 1 has a blank captured author name.",
		]);
	});

	test("blocks Compose, Generate, and Swipe in an incomplete import with the same typed reason", async () => {
		const { conversation } = importChat(
			writeSource([header, first]),
		);
		const module = createConversationModule(database);
		const messageId = conversation.messages[0]?.id ?? 0;

		// Every play action carries the same derived capability reason.
		expect(conversation.capabilities).toEqual({
			compose: { available: false, reason: "conversation-not-playable" },
			generate: { available: false, reason: "conversation-not-playable" },
			swipe: { available: false, reason: "conversation-not-playable" },
		});

		// Compose (create-message) and Swipe (create-variant) commands throw
		// the same typed not-playable domain outcome.
		expect(() =>
			module.execute({
				conversationId: conversation.id,
				expectedRevision: conversation.revision,
				action: {
					type: "create-message",
					timestamp: "2026-08-08T14:00:00.000Z",
					variantContents: ["draft"],
					authorParticipantId: conversation.cast[0]?.id ?? 0,
				},
			}),
		).toThrow(ConversationNotPlayableError);
		expect(() =>
			module.execute({
				conversationId: conversation.id,
				expectedRevision: conversation.revision,
				action: { type: "create-variant", messageId, content: "alt" },
			}),
		).toThrow(ConversationNotPlayableError);

		// The workflow seams deny Generate and targeted Swipe before any
		// transport is contacted, with the identical typed outcome.
		await expect(
			generateTerminalTailFixture(database, {
				conversationId: conversation.id,
				modelClient: createFakeModelClient(() => "never called"),
			}),
		).rejects.toThrow(ConversationNotPlayableError);
		await expect(
			generateSiblingVariant(database, {
				conversationId: conversation.id,
				messageId,
				modelClient: createFakeModelClient(() => "never called"),
			}),
		).rejects.toThrow(ConversationNotPlayableError);

		// Incomplete imports stay editable and configurable: content edits
		// and scoped data commands are never play-gated, and they keep
		// storing against the preserved history.
		const variantId = conversation.messages[0]?.variants[0]?.id ?? 0;
		const edited = module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "edit-variant",
				messageId,
				variantId,
				content: "Edited preserved text",
			},
		});
		expect(edited.messages[0]?.variants[0]?.content).toBe(
			"Edited preserved text",
		);
		const configured = module.execute({
			conversationId: edited.id,
			expectedRevision: edited.revision,
			action: {
				type: "put-data",
				scope: { type: "conversation" },
				namespace: "test",
				key: "note",
				value: "preserved",
			},
		});
		expect(configured.data).toContainEqual({
			namespace: "test",
			key: "note",
			value: "preserved",
		});
		const cleared = module.execute({
			conversationId: configured.id,
			expectedRevision: configured.revision,
			action: {
				type: "delete-data",
				scope: { type: "conversation" },
				namespace: "test",
				key: "note",
			},
		});
		expect(
			cleared.data.find((entry) => entry.namespace === "test"),
		).toBeUndefined();

		// Adding the missing Participant derives playability automatically;
		// no status toggle exists or is needed.
		const completed = module.execute({
			conversationId: cleared.id,
			expectedRevision: cleared.revision,
			action: {
				type: "add-participant",
				definition: {
					name: "Rulership",
					prompt: {
						systemInstruction: "",
						identity: "",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
					openings: [],
				},
			},
		});
		expect(completed.playable).toBe(true);
		expect(completed.control).toEqual({
			humanParticipantId: conversation.cast[0]?.id ?? null,
			modelParticipantId: completed.cast[1]?.id ?? null,
		});
	});

	test("keeps imported Variants selectable and editable but denies new sibling generation", async () => {
		const { conversation } = importChat(
			writeSource([header, swiped, second]),
		);
		const module = createConversationModule(database);
		expect(conversation.playable).toBe(true);

		const swipeMessage = conversation.messages[0];
		expect(swipeMessage).toBeDefined();
		const targetId = swipeMessage?.id ?? 0;
		// Imported Messages never gain fabricated historical Control context.
		expect(swipeMessage?.historicalContext).toBeNull();
		expect(swipeMessage?.swipe).toEqual({
			eligible: false,
			reason: "missing-historical-context",
		});

		// New sibling generation is denied with the typed reason even though
		// the Conversation is fully playable; the transport generate seam is
		// never contacted.
		let contacted = false;
		await expect(
			generateSiblingVariant(database, {
				conversationId: conversation.id,
				messageId: targetId,
				modelClient: createFakeModelClient(() => {
					contacted = true;
					return "Never reached";
				}),
			}),
		).rejects.toThrow(SiblingVariantUnavailableError);
		expect(contacted).toBe(false);

		// Existing Variants remain selectable and editable.
		const secondVariant = swipeMessage?.variants[1];
		expect(secondVariant).toBeDefined();
		const selected = module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "select-variant",
				messageId: targetId,
				variantId: secondVariant?.id ?? 0,
			},
		});
		expect(
			selected.messages[0]?.variants.map((variant) => variant.selected),
		).toEqual([false, true, false, false]);
		const edited = module.execute({
			conversationId: selected.id,
			expectedRevision: selected.revision,
			action: {
				type: "edit-variant",
				messageId: targetId,
				variantId: secondVariant?.id ?? 0,
				content: "Edited preserved alternative",
			},
		});
		expect(edited.messages[0]?.variants[1]?.content).toBe(
			"Edited preserved alternative",
		);
		// The Author Stamp survives content edits and selection changes.
		expect(edited.messages[0]?.author?.participantId).toBe(
			swipeMessage?.author?.participantId ?? null,
		);
	});

	test("native generation after completion captures ordinary authorship and historical Control", async () => {
		const { conversation } = importChat(
			writeSource([header, first]),
		);
		const module = createConversationModule(database);
		const completed = module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "add-participant",
				definition: {
					name: "Rulership",
					prompt: {
						systemInstruction: "",
						identity: "",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
					openings: [],
				},
			},
		});
		expect(completed.playable).toBe(true);

		// A native Generate after completion is an ordinary native Message:
		// immutable Author Stamp plus captured historical Control pair.
		const human = completed.cast[0];
		const model = completed.cast[1];
		expect(human).toBeDefined();
		expect(model).toBeDefined();
		const generated = await generateTerminalTailFixture(database, {
			conversationId: completed.id,
			timestamp: "2026-08-08T14:30:00.000Z",
			modelClient: createFakeModelClient(() => "The lamp answers at last."),
		});
		const nativeMessage = generated.messages[1];
		expect(nativeMessage).toBeDefined();
		expect(nativeMessage?.author).toEqual({
			participantId: model?.id ?? null,
			capturedName: "Rulership",
			inCast: true,
		});
		expect(nativeMessage?.historicalContext).toEqual({
			humanParticipantId: human?.id ?? 0,
			modelParticipantId: model?.id ?? 0,
		});

		// The native Message supports the same capabilities as any other
		// native Message: targeted Swipe generation works and leaves current
		// Control and the Author Stamp untouched.
		expect(nativeMessage?.swipe).toEqual({ eligible: true, reason: null });
		const sibling = await generateSiblingVariant(database, {
			conversationId: generated.id,
			messageId: nativeMessage?.id ?? 0,
			timestamp: "2026-08-08T14:31:00.000Z",
			modelClient: createFakeModelClient(() => "The lamp answers differently."),
		});
		expect(sibling.messages[1]?.variants).toHaveLength(2);
		expect(sibling.messages[1]?.variants[1]?.content).toBe(
			"The lamp answers differently.",
		);
		expect(sibling.messages[1]?.variants[1]?.selected).toBe(true);
		expect(sibling.messages[1]?.author).toEqual(nativeMessage?.author);
		expect(sibling.control).toEqual(completed.control);
		// Imported history still lacks fabricated context after completion.
		expect(sibling.messages[0]?.historicalContext).toBeNull();
		expect(sibling.messages[0]?.swipe).toEqual({
			eligible: false,
			reason: "missing-historical-context",
		});
	});

	test("allows re-importing the same source as an independent Chat with a warning", () => {
		const path = writeSource([header, first, second]);
		const firstImport = importChat(path);
		const secondImport = importChat(path);

		expect(secondImport.conversation.id).not.toBe(firstImport.conversation.id);
		expect(secondImport.duplicateChatIds).toEqual([firstImport.conversation.id]);
		expect(secondImport.report.warnings).toEqual([
			`Source was already imported as chat ${firstImport.conversation.id} ("lantern-house"); this import creates an independent copy.`,
		]);
		expect(firstImport.report.warnings).toEqual([]);
		expect(
			findEntry(
				firstImport.conversation.data,
				IMPORT_NAMESPACE,
				IMPORT_KEYS.sha256,
			)?.value,
		).toBe(
			findEntry(
				secondImport.conversation.data,
				IMPORT_NAMESPACE,
				IMPORT_KEYS.sha256,
			)?.value,
		);
	});

	test("aborts the whole import atomically on a structural defect", () => {
		const path = writeSource([header, first, '{"broken"', second]);
		expect(() => importChat(path)).toThrow(
			SillyTavernImportError,
		);
		expect(countRows(chatTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
		expect(countRows(chatDataTable)).toBe(0);
	});

	test("imports Swipes end to end with exact selection and derived chronology", () => {
		const path = writeSource([header, swiped, provenancedPayload]);
		const result = importChat(path);
		const conversation = result.conversation;

		// 2 Messages; the Swipe record owns 4 Variants in source order and
		// the payload-only record owns 1.
		expect(result.report.counts).toEqual({ messages: 2, variants: 5 });
		expect(conversation.messages).toHaveLength(2);

		const [swipeMessage, payloadMessage] = conversation.messages;
		expect(swipeMessage?.variants.map((variant) => variant.content)).toEqual([
			"First alternative text",
			"Second alternative, still saved",
			"Second alternative, still saved",
			"",
		]);
		expect(
			swipeMessage?.variants.map((variant) => variant.selected),
		).toEqual([false, true, false, false]);
		// Message time is the earliest owned Variant time.
		expect(swipeMessage?.timestamp).toBe("2026-08-08T13:04:50.000Z");
		expect(payloadMessage?.timestamp).toBe("2026-08-08T13:30:00.000Z");

		// Promoted provenance persists as Variant-scoped data rows. The
		// snapshot orders scoped data by namespace and key.
		const expectedFirstVariantData = [
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.swipeIndex, value: "0" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.api, value: "custom" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.model, value: "deepseek-v4-flash" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationId, value: "1786194665138" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationStarted, value: "2026-08-08T13:04:48.000Z" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationFinished, value: "2026-08-08T13:04:49.500Z" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationDuration, value: "1500" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.timeToFirstToken, value: "1235" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.finishReason, value: "stop" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningDuration, value: "25407" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningType, value: "model" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningText, value: "reasoning for the first alternative" },
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningSignature, value: "signature-abc" },
		].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		expect(swipeMessage?.variants[0]?.data).toEqual(expectedFirstVariantData);
		expect(
			swipeMessage?.variants[3]?.data,
		).toEqual([
			{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.swipeIndex, value: "3" },
		]);
		expect(payloadMessage?.variants[0]?.data).toContainEqual({
			namespace: IMPORT_NAMESPACE,
			key: VARIANT_KEYS.reasoningSignature,
			value: "signature-row",
		});

		// Chat creation time is the earliest Message time; activity time is
		// the latest timestamp across every Variant.
		const chatRow = drizzle(database)
			.select()
			.from(chatTable)
			.where(eq(chatTable.id, conversation.id))
			.get();
		expect(chatRow?.creation_time).toBe("2026-08-08T13:04:50.000Z");
		expect(chatRow?.last_message_time).toBe("2026-08-08T13:30:00.000Z");

		// The canonical archive still holds the complete parsed source,
		// including the duplicated top-level assistant payload.
		const archive = findEntry(
			conversation.data,
			ARCHIVE_NAMESPACE,
			ARCHIVE_KEY,
		);
		expect(JSON.parse(archive?.value ?? "")).toEqual({
			header,
			messages: [swiped, provenancedPayload],
		});

		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.countsVariants)
				?.value,
		).toBe("5");
		expect(
			createConversationModule(database).getSnapshot(conversation.id),
		).toEqual(conversation);
	});

	test("aborts the whole import atomically on a mismatched Swipe array", () => {
		const broken = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a", "b"],
			swipe_id: 0,
			swipe_info: [{ send_date: "2026-08-08T13:04:55.256Z" }],
		};
		const path = writeSource([header, swiped, broken]);
		expect(() => importChat(path)).toThrow(
			SillyTavernImportError,
		);
		expect(countRows(chatTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
		expect(countRows(chatDataTable)).toBe(0);
	});

	test("rejects a missing source file", () => {
		expect(() =>
			importChat(join(files[0] ?? "", "missing.jsonl")),
		).toThrow(/Could not read/);
	});

	test("rejects a source that is not valid UTF-8", () => {
		const path = join(files[0] ?? "", "binary.jsonl");
		writeFileSync(path, Buffer.from([0xc3, 0x28, 0x0a]));
		expect(() => importChat(path)).toThrow(
			/The source is not valid UTF-8/,
		);
	});

	test("derives a chat name that is the filename stem", () => {
		const path = writeSource([header, first], "archive-2026-08-08.jsonl");
		const { conversation, report } = importChat(path);
		expect(conversation.name).toBe("archive-2026-08-08");
		expect(report.source.filename).toBe("archive-2026-08-08.jsonl");
	});

	test("stores the full JSON report with the conversation", () => {
		const path = writeSource([header, first, blankName]);
		const { conversation, report } = importChat(path);
		// SAFETY: reportJson.value was serialized from the same report we compare against.
		const stored = JSON.parse(
			findEntry(
				conversation.data,
				IMPORT_NAMESPACE,
				IMPORT_KEYS.reportJson,
			)?.value ?? "",
		) as SillyTavernImportReport;
		expect(stored).toEqual(report);
		expect(stored.counts).toEqual({ messages: 2, variants: 2 });
		expect(stored.warnings).toHaveLength(1);
		expect(stored.warnings[0]).toContain("blank captured author name");
		expect(stored.source.integrity).toBe("9543f21f-8aab-42c8-92a4-1f6453d4b63c");
	});

	const exactArtifact = (chatId: number) =>
		artifacts.getArtifact(
			chatId,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);

	test("preserves an exact-byte copy that keeps BOM, CRLF, escapes, blank lines, and trailing newlines", () => {
		// Two source texts that parse to the same canonical chat but differ
		// only in bytes: BOM prefix, CRLF line endings, \u002d escape
		// spelling for every hyphen, a blank line, and a trailing newline
		// versus the clean LF form used by every other fixture.
		const escapedHeader = JSON.stringify(header).replace(/-/g, "\\u002d");
		const variantA = `\uFEFF${escapedHeader}\r\n${JSON.stringify(first)}\r\n\r\n${JSON.stringify(second)}\r\n`;
		const variantB = jsonl([header, first, second]);

		const pathA = writeSourceRaw(variantA, "bom-crlf.jsonl");
		const pathB = writeSourceRaw(variantB, "clean.jsonl");

		const chatA = importChat(pathA).conversation;
		const chatB = importChat(pathB).conversation;

		// The source SHA is authoritative over the raw bytes: the two files
		// differ in BOM, line endings, escape spelling, blank lines, and the
		// trailing newline, yet both remain valid.
		const bytesA = Buffer.from(variantA, "utf8");
		const bytesB = Buffer.from(variantB, "utf8");
		expect(bytesA.equals(bytesB)).toBe(false);

		const shaA = createHash("sha256").update(bytesA).digest("hex");
		const shaB = createHash("sha256").update(bytesB).digest("hex");
		expect(shaA).not.toBe(shaB);

		const artifactA = exactArtifact(chatA.id);
		const artifactB = exactArtifact(chatB.id);
		expect(artifactA?.availability).toEqual({ status: "available" });
		expect(artifactA?.sha256).toBe(shaA);
		expect(artifactA?.originalFilename).toBe("bom-crlf.jsonl");
		expect(artifactA?.byteLength).toBe(bytesA.length);
		expect(artifactB?.availability).toEqual({ status: "available" });
		expect(artifactB?.sha256).toBe(shaB);

		// Exact-byte round trips through the public artifact seam: the
		// downloaded bytes equal the raw source file bytes, BOM and CRLF and
		// all, never a normalized re-serialization.
		const readA = artifacts.readArtifact(
			chatA.id,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);
		const readB = artifacts.readArtifact(
			chatB.id,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);
		expect(readA?.status).toBe("available");
		expect(readB?.status).toBe("available");
		if (readA?.status !== "available" || readB?.status !== "available") return;
		expect(readA.bytes).toEqual(bytesA);
		expect(readB.bytes).toEqual(bytesB);
		expect(readA.artifact.sha256).toBe(shaA);
		expect(readA.artifact.originalFilename).toBe("bom-crlf.jsonl");
		expect(readA.artifact.byteLength).toBe(bytesA.length);
		expect(readB.artifact.sha256).toBe(shaB);
		expect(readB.artifact.originalFilename).toBe("clean.jsonl");

		// Both parse to the identical canonical archive despite the byte
		// differences: the exact representation and the canonical one are
		// preserved independently.
		const archiveOf = (data: { namespace: string; key: string; value: string }[]) =>
			JSON.parse(
				findEntry(data, ARCHIVE_NAMESPACE, ARCHIVE_KEY)?.value ?? "",
			);
		expect(archiveOf(chatA.data)).toEqual({
			header,
			messages: [first, second],
		});
		expect(archiveOf(chatB.data)).toEqual({
			header,
			messages: [first, second],
		});
	});

	test("returns the exact artifact metadata with the import result and keeps the canonical archive separate", () => {
		const path = writeSource([header, first, blankName], "lantern-house.jsonl");
		const rawBytes = readFileSync(path);
		const result = importChat(path);
		const { conversation, artifact, report } = result;

		// The committed metadata carries the full generic record.
		expect(artifact).toEqual({
			chatId: conversation.id,
			namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
			key: EXACT_SOURCE_ARTIFACT_KEY,
			relativePath: expect.any(String),
			originalFilename: "lantern-house.jsonl",
			mediaType: "application/jsonl",
			byteLength: rawBytes.length,
			sha256: report.source.sha256,
		});

		// The canonical parsed archive and compact report remain separate
		// conversation-scoped data; the exact artifact lives only in the
		// managed store behind the artifact seam.
		expect(JSON.parse(findEntry(conversation.data, ARCHIVE_NAMESPACE, ARCHIVE_KEY)?.value ?? "")).toEqual({
			header,
			messages: [first, blankName],
		});
		expect(
			JSON.parse(
				findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.reportJson)
					?.value ?? "",
			),
		).toEqual(report);
		const inspection = exactArtifact(conversation.id);
		expect(inspection?.availability).toEqual({ status: "available" });
		expect(inspection?.byteLength).toBe(rawBytes.length);
		expect(inspection?.originalFilename).toBe("lantern-house.jsonl");
		expect(inspection?.relativePath).toBe(artifact.relativePath);

		// The archived value is a parsed re-serialization, never the exact
		// bytes: canonical and exact remain distinguishable.
		expect(
			drizzle(database)
				.select()
				.from(chatDataTable)
				.where(
					and(
						eq(chatDataTable.chat_id, conversation.id),
						eq(chatDataTable.namespace, ARCHIVE_NAMESPACE),
						eq(chatDataTable.key, ARCHIVE_KEY),
					),
				)
				.get()?.value,
		).not.toBe(rawBytes.toString("utf8"));
	});

	test("stores an independent physical copy per import even for identical SHA-256", () => {
		const path = writeSource([header, first, second]);
		const firstChat = importChat(path);
		const secondChat = importChat(path);

		expect(secondChat.report.source.sha256).toBe(firstChat.report.source.sha256);
		expect(secondChat.artifact.relativePath).not.toBe(
			firstChat.artifact.relativePath,
		);
		expect(secondChat.artifact.chatId).not.toBe(firstChat.artifact.chatId);

		// Both physical copies exist at their own managed paths and both
		// deliver the exact same bytes; nothing is deduplicated.
		expect(
			readFileSync(join(artifactDirectory, firstChat.artifact.relativePath)),
		).toEqual(readFileSync(path));
		expect(
			readFileSync(join(artifactDirectory, secondChat.artifact.relativePath)),
		).toEqual(readFileSync(path));
		expect(exactArtifact(firstChat.conversation.id)?.availability).toEqual({
			status: "available",
		});
		expect(exactArtifact(secondChat.conversation.id)?.availability).toEqual({
			status: "available",
		});
	});

	test("aborts before creating any database rows when the exact artifact cannot be stored", () => {
		const path = writeSource([header, first, second]);
		// A regular file in place of a directory makes the managed root
		// impossible to create, forcing the initial storage failure.
		const blocker = join(files[0] ?? "", "blocker");
		writeFileSync(blocker, "not a directory");
		const brokenArtifactDirectory = join(blocker, "managed-artifacts");

		expect(() =>
			importSillyTavernChat(database, path, brokenArtifactDirectory),
		).toThrow(/preserve the exact source artifact/);

		// The abort happens before the database creation operation begins:
		// no Chat, Participant, Profile, Message, Variant, Roster, Author
		// Stamp, or artifact metadata row exists.
		expect(countRows(chatTable)).toBe(0);
		expect(countRows(participantTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
		expect(countRows(chatDataTable)).toBe(0);
		expect(countRows(artifactTable)).toBe(0);
	});

	test("reports a missing or corrupt exact artifact as cleaned up while native Conversation behavior stays usable", () => {
		const path = writeSource([header, first]);
		const { conversation, artifact } = importChat(path);
		const module = createConversationModule(database);

		// Nonfatal disappearance: deleting the physical copy never throws
		// and never impairs the native Conversation.
		rmSync(join(artifactDirectory, artifact.relativePath));

		expect(exactArtifact(conversation.id)?.availability).toEqual({
			status: "cleaned-up",
			reason: "missing",
		});
		expect(
			artifacts.readArtifact(
				conversation.id,
				EXACT_SOURCE_ARTIFACT_NAMESPACE,
				EXACT_SOURCE_ARTIFACT_KEY,
			)?.status,
		).toBe("cleaned-up");

		// The native Chat and its canonical archive remain fully usable.
		const snapshot = module.getSnapshot(conversation.id);
		expect(snapshot?.id).toBe(conversation.id);
		expect(snapshot?.playable).toBe(false);
		expect(JSON.parse(findEntry(snapshot?.data ?? [], ARCHIVE_NAMESPACE, ARCHIVE_KEY)?.value ?? "")).toEqual({
			header,
			messages: [first],
		});
		expect(snapshot?.messages).toHaveLength(1);

		// Normal Conversation commands keep working after the disappearance.
		const writer = snapshot?.cast[0];
		expect(writer).toBeDefined();
		const renamed = module.execute({
			conversationId: conversation.id,
			expectedRevision: snapshot?.revision ?? 0,
			action: {
				type: "rename-participant",
				participantId: writer?.id ?? 0,
				name: "Renamed After Cleanup",
			},
		});
		expect(renamed.cast[0]?.name).toBe("Renamed After Cleanup");
		expect(renamed.revision).toBe(1);

		// A corrupt file (wrong bytes) is likewise cleaned up, not fatal.
		const corruptPath = join(artifactDirectory, artifact.relativePath);
		writeFileSync(corruptPath, Buffer.from("different bytes", "utf8"));
		expect(exactArtifact(conversation.id)?.availability).toEqual({
			status: "cleaned-up",
			reason: "corrupt",
		});
	});

	test("never automatically deletes committed artifact copies when the Chat is removed", () => {
		const path = writeSource([header, first]);
		const { conversation, artifact } = importChat(path);
		const storedPath = join(artifactDirectory, artifact.relativePath);

		// No public Chat-deletion seam exists; removing the Chat row directly
		// simulates the future deletion path. The metadata row follows the
		// Chat, but the committed physical copy is never automatically
		// deleted and no cleanup subsystem touches it.
		database.run("DELETE FROM chat WHERE id = ?", [conversation.id]);
		expect(exactArtifact(conversation.id)).toBeUndefined();
		expect(
			artifacts.readArtifact(
				conversation.id,
				EXACT_SOURCE_ARTIFACT_NAMESPACE,
				EXACT_SOURCE_ARTIFACT_KEY,
			),
		).toBeUndefined();
		expect(readFileSync(storedPath)).toEqual(readFileSync(path));
	});

	test("downloads the exact artifact under the stored original leaf filename", () => {
		const path = writeSource([header, first], "archive-2026-08-08.jsonl");
		const { conversation } = importChat(path);
		const download = artifacts.downloadArtifact(
			conversation.id,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);
		expect(download?.status).toBe("available");
		if (download?.status !== "available") return;
		expect(download.contentDisposition).toBe(
			'attachment; filename="archive-2026-08-08.jsonl"',
		);
		expect(download.bytes).toEqual(readFileSync(path));
	});
});
