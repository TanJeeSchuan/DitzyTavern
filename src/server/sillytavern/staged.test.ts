import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	createCharacterLibraryModule,
	type CharacterDefinition,
} from "../character-library";
import { openDatabase } from "../database/database";
import { artifactTable, chatTable, participantTable } from "../database/schema";
import { importSillyTavernChat } from "./import";
import {
	clearStagedImportRegistry,
	createChatImportModule,
	type ChatImportModule,
} from "./staged";
import { UNKNOWN_IMPORTED_AUTHOR_NAME } from "./import-projection";
import {
	StagedChatImportExpiredError,
	StagedChatImportTokenMismatchError,
	StagedChatImportUnavailableError,
	SillyTavernImportError,
} from "./errors";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	rulershipFixture as rulership,
	writerFixture as writer,
} from "./fixtures";

const definition = (overrides: Partial<CharacterDefinition> = {}): CharacterDefinition => ({
	name: "Maren Voss",
	prompt: {
		systemInstruction: "System text.",
		identity: "Identity text.",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
	openings: [],
	...overrides,
});

const sha256Of = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

describe("staged SillyTavern chat import", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let module: ChatImportModule;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-staged-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		module = createChatImportModule(database, { artifactDirectory });
		// Each test starts with a fresh session registry exactly like a new
		// server process; the registry is cleared before and after every test.
		clearStagedImportRegistry();
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
		clearStagedImportRegistry();
	});

	const stageBytes = (bytes: Buffer, filename = "lantern-house.jsonl") =>
		module.stageFile({
			// SAFETY: the copy into a fresh Uint8Array carries the exact bytes
			// while satisfying Blob's ArrayBuffer typing at the test boundary.
			bytes: new Blob([new Uint8Array(bytes)]).stream(),
			originalFilename: filename,
		});

	const stageText = (records: unknown[], filename = "lantern-house.jsonl") =>
		stageBytes(Buffer.from(jsonl(records), "utf8"), filename);

	const stagingFiles = () =>
		readdirSync(join(artifactDirectory, "staging")).sort();

	const addCharacter = (overrides: Partial<CharacterDefinition>) =>
		createCharacterLibraryModule(database).execute({
			type: "create",
			definition: definition(overrides),
		});

	// Imports one source through the developer path so prior-import evidence
	// exists exactly like committed Chats would.
	const priorImport = (records: unknown[], filename = "prior.jsonl") => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, jsonl(records), "utf8");
		return importSillyTavernChat(database, path, artifactDirectory).conversation;
	};

	test("stages a valid export once and previews it without creating any domain record", async () => {
		const records = [header, writer, rulership, blankName];
		const bytes = Buffer.from(jsonl(records), "utf8");
		const { token, preview } = await stageBytes(bytes);

		// The preview surfaces the editable filename-derived title, the
		// source identity, declared integrity, and the Message/Variant counts.
		expect(preview.title).toBe("lantern-house");
		expect(preview.originalFilename).toBe("lantern-house.jsonl");
		expect(preview.sha256).toBe(sha256Of(bytes));
		expect(preview.byteLength).toBe(bytes.length);
		expect(preview.integrity).toBe("9543f21f-8aab-42c8-92a4-1f6453d4b63c");
		expect(preview.counts).toEqual({ messages: 3, variants: 3 });

		// The uploaded bytes were streamed into managed temporary staging
		// exactly once: one staging file carrying the exact bytes.
		expect(stagingFiles()).toHaveLength(1);
		const stagedPath = join(artifactDirectory, "staging", stagingFiles()[0] ?? "");
		expect(readFileSync(stagedPath)).toEqual(bytes);

		// Previewing never reopens the file, re-uploads, or writes anything:
		// the staging directory is unchanged and no domain table row exists.
		const refreshed = module.preview(token);
		expect(refreshed).toEqual(preview);
		expect(stagingFiles()).toHaveLength(1);
		expect(drizzle(database).select().from(chatTable).all()).toEqual([]);
		expect(drizzle(database).select().from(participantTable).all()).toEqual([]);
		expect(drizzle(database).select().from(artifactTable).all()).toEqual([]);
	});

	test("builds one initial group per trimmed captured author string, merging whitespace variants and blank names", async () => {
		const spaceOnly = { name: " ", send_date: "2026-08-08T13:11:00.000Z", mes: "blank space name" };
		const records = [
			header,
			writer, // "Writer"
			{ ...writer, name: " Writer ", send_date: "2026-08-08T12:54:00.000Z", mes: "padded" },
			{ ...writer, name: "writer", send_date: "2026-08-08T12:55:00.000Z", mes: "lowercase" },
			blankName, // ""
			spaceOnly, // " "
		];
		const { preview } = await stageText(records);

		// Resolved (trimmed) captured names collapse: the padded variant
		// merges into "Writer"; case stays distinct so "writer" remains its
		// own group; and every blank captured name merges into one shared
		// blank group with the empty-string key.
		expect(preview.groups.map((group) => group.key)).toEqual([
			"Writer",
			"writer",
			"",
		]);
		expect(preview.groups.map((group) => group.isBlank)).toEqual([
			false, false, true,
		]);
		// Blank groups carry the editable Participant-name default; others
		// keep the trimmed captured string as their proposed name.
		expect(
			preview.groups.map((group) => group.participantNameDefault),
		).toEqual([
			"Writer",
			"writer",
			UNKNOWN_IMPORTED_AUTHOR_NAME,
		]);
		expect(preview.groups.map((group) => group.messageCount)).toEqual([2, 1, 2]);
		expect(preview.groups.map((group) => group.messagePositions)).toEqual([
			[1, 2], [3], [4, 5],
		]);
		expect(
			preview.groups.map((group) => group.variantCount),
		).toEqual([2, 1, 2]);
	});

	test("ranks Character suggestions exact, then case-insensitive, then fuzzy", async () => {
		addCharacter({ name: "Maren Voss" });
		addCharacter({ name: "Maren Vos" });

		// Exact tier beats every other candidate for the same key.
		const exact = await stageText([
			header,
			{ ...writer, name: "Maren Voss", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		expect(exact.preview.groups[0]?.suggestion).toEqual({
			characterId: 1,
			name: "Maren Voss",
			match: "exact",
			confirmed: false,
		});

		// Case-insensitive tier beats a fuzzy candidate for the same key
		// ("Maren Vos" is an edit-distance-1 fuzzy match of "maren voss").
		const caseInsensitive = await stageText([
			header,
			{ ...writer, name: "maren voss", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		expect(caseInsensitive.preview.groups[0]?.suggestion).toMatchObject({
			characterId: 1,
			match: "case-insensitive",
		});

		const exactOther = await stageText([
			header,
			{ ...writer, name: "Maren Vos", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		expect(exactOther.preview.groups[0]?.suggestion).toMatchObject({
			characterId: 2,
			match: "exact",
		});
	});

	test("applies the fuzzy tier only when neither exact nor case-insensitive matches", async () => {
		addCharacter({ name: "Maren Voss" });

		// One typo away: the fuzzy tier supplies the strongest candidate.
		const fuzzy = await stageText([
			header,
			{ ...writer, name: "Maren Vos", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		expect(fuzzy.preview.groups[0]?.suggestion).toEqual({
			characterId: 1,
			name: "Maren Voss",
			match: "fuzzy",
			confirmed: false,
		});

		// Whitespace-shifted names also land in the fuzzy tier, never in a
		// higher one: the captured string is matched verbatim.
		const spaced = await stageText([
			header,
			{ ...writer, name: "MarenVoss", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		expect(spaced.preview.groups[0]?.suggestion).toMatchObject({
			characterId: 1,
			match: "fuzzy",
		});

		// Names too dissimilar never cross into the suggestion set.
		const unrelated = await stageText([
			header,
			{ ...writer, name: "Completely Unrelated", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		expect(unrelated.preview.groups[0]?.suggestion).toBeNull();
	});

	test("keeps SillyTavern roles, headers, avatar data, content, and is_user out of suggestions", async () => {
		addCharacter({ name: "Writer" });
		addCharacter({ name: "Rulership" });
		addCharacter({ name: "Juno Ashfeld" });

		// One author name with every legacy hint flipped: is_user true and
		// false, header character_name, avatar fields, and content naming
		// another Character. The suggestion must be identical in all cases
		// because only the captured name participates.
		const variants = [
			{ ...writer, is_user: true },
			{ ...writer, is_user: false },
			{
				...writer,
				is_user: "yes",
				is_system: true,
				force_avatar: "/thumbnail?file=Writer.png",
				original_avatar: "Writer.png",
				mes: "Juno Ashfeld speaks here",
			},
		];
		for (const record of variants) {
			const { preview } = await stageText([header, record]);
			const [group] = preview.groups;
			expect(group?.key).toBe("Writer");
			expect(group?.suggestion).toEqual({
				characterId: 1,
				name: "Writer",
				match: "exact",
				confirmed: false,
			});
			expect(group?.suggestion?.characterId).not.toBe(2);
			expect(group?.suggestion?.characterId).not.toBe(3);
		}
	});

	test("pre-fills the strongest suggestion but leaves it visibly unconfirmed", async () => {
		addCharacter({ name: "Maren Voss" });
		const { preview } = await stageText([
			header,
			{ ...writer, name: "Maren Voss", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		// The suggestion is present (pre-filled) and marked unconfirmed; a
		// group without any plausible Character carries no suggestion at all.
		expect(preview.groups[0]?.suggestion?.confirmed).toBe(false);
		const unrelated = await stageText([
			header,
			{ ...writer, name: "Invented Name", send_date: "2026-08-08T12:53:02.008Z" },
		]);
		expect(unrelated.preview.groups[0]?.suggestion).toBeNull();
	});

	test("classifies matching SHA-256 as exact duplicates and integrity-only matches as related sources", async () => {
		// A prior Chat imported from the exact same bytes (sha + integrity
		// both match) is an exact duplicate of a later staged file.
		const priorBytesSource = await priorImport([header, writer, rulership]);
		const sameBytes = await stageBytes(
			Buffer.from(jsonl([header, writer, rulership]), "utf8"),
			"copy.jsonl",
		);
		expect(sameBytes.preview.duplicates.exact).toEqual([
			{ id: priorBytesSource.id, name: priorBytesSource.name },
		]);
		expect(sameBytes.preview.duplicates.related).toEqual([]);

		// A different file that only reuses the declared integrity (same
		// header, different Messages) is a related source, never an exact
		// duplicate: the declared value is advisory while SHA-256 is
		// authoritative over the raw bytes.
		const relatedBytesSource = await stageText([header, blankName], "related.jsonl");
		expect(relatedBytesSource.preview.duplicates.exact).toEqual([]);
		expect(relatedBytesSource.preview.duplicates.related).toEqual([
			{ id: priorBytesSource.id, name: priorBytesSource.name },
		]);
	});

	test("binds the token to the exact byte length and SHA-256 and rejects changed or expired tokens", async () => {
		const bytes = Buffer.from(jsonl([header, writer]), "utf8");
		const { token } = await stageBytes(bytes, "bound.jsonl");

		// The token alone returns the preview; supplying the bound hash is
		// the verified recoverable-error path.
		expect(module.preview(token)).toBeDefined();
		expect(module.preview(token, sha256Of(bytes))).toBeDefined();

		// A hash that does not match the binding is rejected without
		// touching the flow.
		expect(() => module.preview(token, sha256Of(Buffer.from("other")))).toThrow(
			StagedChatImportTokenMismatchError,
		);
		// Unknown or already-discarded tokens are expired.
		expect(() => module.preview("unknown-token")).toThrow(
			StagedChatImportExpiredError,
		);
	});

	test("reports cleaned-up staging bytes as unavailable instead of serving a broken preview", async () => {
		const bytes = Buffer.from(jsonl([header, writer]), "utf8");
		const { token } = await stageBytes(bytes, "cleaned.jsonl");

		const stagedPath = join(artifactDirectory, "staging", stagingFiles()[0] ?? "");
		writeFileSync(stagedPath, Buffer.from("different bytes", "utf8"));
		expect(() => module.preview(token)).toThrow(
			StagedChatImportUnavailableError,
		);
		try {
			module.preview(token);
		} catch (error) {
			expect(error).toBeInstanceOf(StagedChatImportUnavailableError);
			// SAFETY: the instanceof check immediately above guarantees this
			// catch only narrows the typed unavailable error before reading
			// its reason.
			expect((error as StagedChatImportUnavailableError).reason).toBe("corrupt");
		}

		rmSync(stagedPath);
		try {
			module.preview(token);
		} catch (error) {
			expect(error).toBeInstanceOf(StagedChatImportUnavailableError);
			// SAFETY: the instanceof check immediately above guarantees this
			// catch only narrows the typed unavailable error before reading
			// its reason.
			expect((error as StagedChatImportUnavailableError).reason).toBe("missing");
		}
	});

	test("cancellation removes only the uncommitted temporary staging data of that flow", async () => {
		const first = await stageBytes(Buffer.from(jsonl([header, writer]), "utf8"), "a.jsonl");
		const second = await stageBytes(Buffer.from(jsonl([header, rulership]), "utf8"), "b.jsonl");

		module.discard(first.token);
		// The discarded handle is expired and was never committed.
		expect(() => module.preview(first.token)).toThrow(
			StagedChatImportExpiredError,
		);
		// The other flow still previews, and exactly its staging file remains.
		expect(module.preview(second.token)).toBeDefined();
		expect(stagingFiles()).toHaveLength(1);
		// Discard is idempotent for unknown handles.
		expect(() => module.discard(first.token)).not.toThrow();
		expect(() => module.discard("never-existed")).not.toThrow();
	});

	test("a server restart expires every staged flow and requires file reselection", async () => {
		const { token, preview } = await stageBytes(
			Buffer.from(jsonl([header, writer]), "utf8"),
			"restart.jsonl",
		);
		expect(preview).toBeDefined();

		// A restart clears the in-memory session registry; no durable import
		// draft or resume system exists. Handles become expired and the
		// staged file is simply never cleaned up (no GC is added).
		clearStagedImportRegistry();
		expect(() => module.preview(token)).toThrow(StagedChatImportExpiredError);
		expect(() => module.discard(token)).not.toThrow();
		// The same module instance (and a fresh one) agree: no resume.
		const freshModule = createChatImportModule(database, { artifactDirectory });
		expect(() => freshModule.preview(token)).toThrow(
			StagedChatImportExpiredError,
		);
	});

	test("reports malformed JSON, invalid UTF-8, and structural defects contextually and discards the upload", async () => {
		const brokenLine = Buffer.from(
			`${JSON.stringify(header)}\n{"broken`,
			"utf8",
		);
		await expect(stageBytes(brokenLine)).rejects.toThrow(
			/Line 2 is not valid JSON/,
		);
		await expect(
			stageBytes(Buffer.from([0xc3, 0x28, 0x0a]), "binary.jsonl"),
		).rejects.toThrow(/The source is not valid UTF-8/);

		await expect(stageText([["not", "an", "object"]])).rejects.toThrow(
			/expected a SillyTavern chat header/,
		);
		await expect(
			stageText([
				header,
				{ name: "Writer", send_date: "2026-08-08T12:00:00.000Z" },
			]),
		).rejects.toThrow(/has no string content/);

		// A validation failure never leaves uncommitted staging bytes behind.
		await expect(stageBytes(brokenLine)).rejects.toThrow(
			SillyTavernImportError,
		);
		expect(stagingFiles()).toEqual([]);
	});

	test("accepts any extension whose content validates as SillyTavern JSONL", async () => {
		const { preview } = await stageText(
			[header, writer],
			"export.txt",
		);
		expect(preview.originalFilename).toBe("export.txt");
		expect(preview.title).toBe("export");
		expect(preview.counts).toEqual({ messages: 1, variants: 1 });
	});

	test("imposes no application-level source-size limit", async () => {
		// A synthetic export large enough to stream through staging (roughly
		// a megabyte) stages and previews with exact counts; no cap exists at
		// the module seam.
		const records: unknown[] = [header];
		for (let index = 0; index < 24000; index += 1) {
			records.push({
				name: index % 2 === 0 ? "Writer" : "Rulership",
				send_date: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
				mes: `Message ${index} with a comfortably sized payload for streaming.`,
			});
		}
		const bytes = Buffer.from(jsonl(records), "utf8");
		expect(bytes.length).toBeGreaterThan(1_000_000);

		const { preview } = await stageBytes(bytes, "large-export.jsonl");
		expect(preview.counts.messages).toBe(24000);
		expect(preview.counts.variants).toBe(24000);
		expect(preview.groups.map((group) => group.key)).toEqual(["Writer", "Rulership"]);
		expect(preview.groups[0]?.messageCount).toBe(12000);
		expect(preview.groups[1]?.messageCount).toBe(12000);
	});
});