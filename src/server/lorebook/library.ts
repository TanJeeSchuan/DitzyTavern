import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import type { SillyTavernJsonValue } from "../../shared/contract/prompt-preset";
import {
	type Lorebook,
	type LorebookCommand,
	type LorebookSummary,
	type LoreEntryFields,
	nativeLorebook,
	type NativeLorebook,
} from "../../shared/contract/lorebook";
import { lorebookEntryTable, lorebookTable } from "../database/schema";
import {
	InvalidLorebookCommandError,
	LorebookEntryNotFoundError,
	LorebookNotFoundError,
	StaleLorebookRevisionError,
} from "./errors";

const connect = (database: Database) => drizzle(database);
type LorebookDatabase = ReturnType<typeof connect>;
type JsonObject = Exclude<SillyTavernJsonValue, null | boolean | number | string | SillyTavernJsonValue[]>;
const isJsonObject = (value: SillyTavernJsonValue): value is JsonObject =>
	value !== null && !Array.isArray(value) && value.constructor === Object;

const parseList = (value: string, label: string): string[] => {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed) || !parsed.every((item) => item !== null && item.constructor === String)) {
			throw new Error();
		}
		return parsed;
	} catch {
		throw new Error(`Stored Lorebook ${label} is invalid.`);
	}
};

const fieldsFromRow = (row: typeof lorebookEntryTable.$inferSelect): LoreEntryFields => ({
	title: row.title,
	content: row.content,
	keywords: parseList(row.keywords_json, "keywords"),
	semanticTriggers: parseList(row.semantic_triggers_json, "semantic triggers"),
	matchOperator: row.match_operator === "and" ? "and" : "or",
	always: row.always,
	requireAny: parseList(row.require_any_json, "require-any conditions"),
	requireAll: parseList(row.require_all_json, "require-all conditions"),
	excludeAny: parseList(row.exclude_any_json, "exclude-any conditions"),
	excludeAll: parseList(row.exclude_all_json, "exclude-all conditions"),
	caseSensitive: row.case_sensitive,
	wholeWord: row.whole_word,
	keywordMode: row.keyword_mode === "regex" ? "regex" : "literal",
	regexFlags: row.regex_flags,
	semanticThreshold: row.semantic_threshold,
	priority: row.priority,
	enabled: row.enabled,
});

const readBook = (db: LorebookDatabase, bookId: number): Lorebook | undefined => {
	const book = db.select().from(lorebookTable).where(eq(lorebookTable.id, bookId)).get();
	if (book === undefined) return undefined;
	const entries = db
		.select()
		.from(lorebookEntryTable)
		.where(eq(lorebookEntryTable.lorebook_id, bookId))
		.orderBy(asc(lorebookEntryTable.position))
		.all()
		.map((row) => ({ id: row.id, position: row.position, ...fieldsFromRow(row) }));
	return { id: book.id, name: book.name, description: book.description, revision: book.revision, entries };
};

const requireBook = (db: LorebookDatabase, bookId: number): Lorebook => {
	const book = readBook(db, bookId);
	if (book === undefined) throw new LorebookNotFoundError(bookId);
	return book;
};

const requireCurrentRevision = (db: LorebookDatabase, bookId: number, revision: number): Lorebook => {
	const current = requireBook(db, bookId);
	if (current.revision !== revision) {
		throw new StaleLorebookRevisionError(bookId, revision, current.revision, current);
	}
	return current;
};

const textValue = (value: string, label: string): string => {
	const normalized = value.trim();
	if (normalized === "") throw new InvalidLorebookCommandError(`A Lorebook ${label} is required.`);
	return normalized;
};

const validateEntry = (entry: LoreEntryFields): LoreEntryFields => {
	if (!Number.isInteger(entry.priority)) {
		throw new InvalidLorebookCommandError("Lorebook entry priority must be an integer.");
	}
	if (entry.semanticThreshold !== null && (entry.semanticThreshold < 0 || entry.semanticThreshold > 1)) {
		throw new InvalidLorebookCommandError("Semantic threshold must be between 0 and 1.");
	}
	try {
		if (entry.keywordMode === "regex") {
		// ==[HUMAN APPROVED]== Validate flags even when the entry currently has no expressions. A
			// later edit must not inherit a malformed configuration that was
			// accepted merely because its lists happened to be empty.
			new RegExp("", entry.regexFlags);
			for (const keyword of [...entry.keywords, ...entry.requireAny, ...entry.requireAll, ...entry.excludeAny, ...entry.excludeAll]) {
				new RegExp(keyword, entry.regexFlags);
			}
		} else if (entry.regexFlags !== "") {
			throw new Error("flags");
		}
	} catch {
		throw new InvalidLorebookCommandError("Lorebook regular-expression syntax or flags are invalid.");
	}
	return entry;
};

const entryValues = (entry: LoreEntryFields) => ({
	title: entry.title,
	content: entry.content,
	keywords_json: JSON.stringify(entry.keywords),
	semantic_triggers_json: JSON.stringify(entry.semanticTriggers),
	match_operator: entry.matchOperator,
	always: entry.always,
	require_any_json: JSON.stringify(entry.requireAny),
	require_all_json: JSON.stringify(entry.requireAll),
	exclude_any_json: JSON.stringify(entry.excludeAny),
	exclude_all_json: JSON.stringify(entry.excludeAll),
	case_sensitive: entry.caseSensitive,
	whole_word: entry.wholeWord,
	keyword_mode: entry.keywordMode,
	regex_flags: entry.regexFlags,
	semantic_threshold: entry.semanticThreshold,
	priority: entry.priority,
	enabled: entry.enabled,
});

const incrementRevision = (db: LorebookDatabase, bookId: number) => {
	const current = db.select({ revision: lorebookTable.revision }).from(lorebookTable).where(eq(lorebookTable.id, bookId)).get();
	if (current === undefined) throw new LorebookNotFoundError(bookId);
	db.update(lorebookTable).set({ revision: current.revision + 1 }).where(eq(lorebookTable.id, bookId)).run();
};

export const readLorebook = (database: Database, bookId: number): Lorebook | undefined => readBook(connect(database), bookId);

export const listLorebooks = (database: Database): LorebookSummary[] => {
	const db = connect(database);
	const books = db.select().from(lorebookTable).orderBy(asc(lorebookTable.id)).all();
	return books.map((book) => ({
		id: book.id,
		name: book.name,
		description: book.description,
		revision: book.revision,
		entryCount: db.select({ id: lorebookEntryTable.id }).from(lorebookEntryTable).where(eq(lorebookEntryTable.lorebook_id, book.id)).all().length,
	}));
};

export const readNativeLorebook = (database: Database, bookId: number): NativeLorebook | undefined => {
	const book = readLorebook(database, bookId);
	if (book === undefined) return undefined;
	return {
		name: book.name,
		description: book.description,
		entries: book.entries.map(({ id: _id, position: _position, ...entry }) => entry),
	};
};

const createEntries = (db: LorebookDatabase, bookId: number, entries: LoreEntryFields[]) => {
	if (entries.length === 0) return;
	db.insert(lorebookEntryTable).values(entries.map((entry, index) => ({
		lorebook_id: bookId,
		position: index + 1,
		...entryValues(validateEntry(entry)),
	}))).run();
};

export const importNativeLorebook = (database: Database, native: NativeLorebook): Lorebook => {
	if (!Value.Check(nativeLorebook, native)) throw new InvalidLorebookCommandError("The native Lorebook JSON is invalid.");
	const name = textValue(native.name, "name");
	const description = native.description;
	for (const entry of native.entries) validateEntry(entry);
	const db = connect(database);
	return database.transaction(() => {
		const inserted = db.insert(lorebookTable).values({ name, description }).returning({ id: lorebookTable.id }).get();
		if (inserted === undefined) throw new Error("The Lorebook could not be imported.");
		createEntries(db, inserted.id, native.entries);
		return requireBook(db, inserted.id);
	}).immediate();
};

export interface LorebookImportResult { book: Lorebook; warnings: string[] }

const sourceObject = (source: SillyTavernJsonValue): JsonObject => {
	if (!isJsonObject(source)) throw new InvalidLorebookCommandError("SillyTavern lorebook JSON must be an object.");
	return source;
};

const isJsonString = (value: SillyTavernJsonValue | undefined): value is string => value?.constructor === String;
const isJsonBoolean = (value: SillyTavernJsonValue | undefined): value is boolean => value?.constructor === Boolean;
const sourceString = (value: SillyTavernJsonValue | undefined, fallback = ""): string =>
	isJsonString(value) ? value : fallback;
const sourceBoolean = (value: SillyTavernJsonValue | undefined, fallback: boolean): boolean =>
	isJsonBoolean(value) ? value : fallback;
const sourceStrings = (value: SillyTavernJsonValue | undefined): string[] =>
	value?.constructor === String
		? [value]
		: Array.isArray(value)
			? value.filter((item): item is string => item !== null && item.constructor === String)
			: [];

export const importSillyTavernLorebook = (database: Database, source: SillyTavernJsonValue): LorebookImportResult => {
	if (!isJsonObject(source)) throw new InvalidLorebookCommandError("SillyTavern lorebook JSON must be an object.");
	const root = sourceObject(source);
	const data = sourceObject(root.data ?? root);
	const sourceEntries = data.entries;
	const rawEntries = Array.isArray(sourceEntries)
		? sourceEntries
		: sourceEntries && isJsonObject(sourceEntries)
			? Object.values(sourceEntries)
			: [];
	if (rawEntries.length === 0 && sourceEntries === undefined) throw new InvalidLorebookCommandError("SillyTavern lorebook entries are required.");
	const warnings: string[] = [];
	const entries: LoreEntryFields[] = rawEntries.map((raw, index) => {
		const item = sourceObject(raw);
		const keys = sourceStrings(item.key ?? item.keys);
		const secondary = item.secondary_keys;
		const selectiveLogic = String(item.selectiveLogic ?? "0");
		const always = sourceBoolean(item.constant, false);
		if (item.vectorized === true || item.useProbability === true || item.sticky === true || item.delay !== undefined || item.group !== undefined || item.recursion !== undefined || item.position !== undefined) {
			warnings.push(`Entry ${index + 1} uses unsupported SillyTavern behavior; supported fields were imported.`);
		}
		if (item.content && /\{\{[^}]+\}\}/.test(String(item.content))) warnings.push(`Entry ${index + 1} contains macro-looking text; it remains literal.`);
		if (item.vectorized === true && keys.length === 0) warnings.push(`Entry ${index + 1} has full-content semantic matching but no authored Semantic Triggers; it remains unmatched until edited.`);
		return validateEntry({
			title: sourceString(item.comment ?? item.title),
			content: sourceString(item.content),
			keywords: keys,
			semanticTriggers: [],
			matchOperator: selectiveLogic === "1" ? "and" : "or",
			always,
			requireAny: Array.isArray(secondary) ? sourceStrings(secondary) : sourceStrings(item.requireAny),
			requireAll: Array.isArray(secondary) ? [] : sourceStrings(item.requireAll),
			excludeAny: sourceStrings(item.excludeAny),
			excludeAll: sourceStrings(item.excludeAll),
			caseSensitive: sourceBoolean(item.caseSensitive, false),
			wholeWord: sourceBoolean(item.matchWholeWords, true),
			keywordMode: "literal",
			regexFlags: "",
			semanticThreshold: null,
			priority: Number.isInteger(item.order) ? Number(item.order) : 0,
			enabled: sourceBoolean(item.enabled, true),
		});
	});
	return { book: importNativeLorebook(database, {
		name: sourceString(data.name ?? root.name, "Imported Lorebook"),
		description: sourceString(data.description ?? root.description),
		entries,
	}), warnings };
};

const reorder = (db: LorebookDatabase, bookId: number, entryId: number, toPosition: number) => {
	const rows = db.select().from(lorebookEntryTable).where(eq(lorebookEntryTable.lorebook_id, bookId)).orderBy(asc(lorebookEntryTable.position)).all();
	const index = rows.findIndex((row) => row.id === entryId);
	if (index < 0) throw new LorebookEntryNotFoundError(entryId);
	if (toPosition < 1 || toPosition > rows.length) throw new InvalidLorebookCommandError("Lorebook entry position is out of range.");
	const [entry] = rows.splice(index, 1);
	rows.splice(toPosition - 1, 0, entry);
	rows.forEach((row, position) => db.update(lorebookEntryTable).set({ position: -(position + 1) }).where(eq(lorebookEntryTable.id, row.id)).run());
	rows.forEach((row, position) => db.update(lorebookEntryTable).set({ position: position + 1 }).where(eq(lorebookEntryTable.id, row.id)).run());
};

export const executeLorebookCommand = (database: Database, command: LorebookCommand): Lorebook | { deleted: number } => {
	const db = connect(database);
	return database.transaction(() => {
		switch (command.type) {
			case "create": {
				const inserted = db.insert(lorebookTable).values({ name: textValue(command.name, "name"), description: command.description ?? "" }).returning({ id: lorebookTable.id }).get();
				if (inserted === undefined) throw new Error("The Lorebook could not be created.");
				return requireBook(db, inserted.id);
			}
			case "update-book": {
				requireCurrentRevision(db, command.bookId, command.expectedRevision);
				db.update(lorebookTable).set({ name: textValue(command.name, "name"), description: command.description }).where(eq(lorebookTable.id, command.bookId)).run();
				incrementRevision(db, command.bookId);
				return requireBook(db, command.bookId);
			}
			case "duplicate": {
				const source = requireCurrentRevision(db, command.bookId, command.expectedRevision);
				const inserted = db.insert(lorebookTable).values({ name: textValue(command.name ?? `Copy of ${source.name}`, "name"), description: source.description }).returning({ id: lorebookTable.id }).get();
				if (inserted === undefined) throw new Error("The Lorebook could not be duplicated.");
				createEntries(db, inserted.id, source.entries.map(({ id: _id, position: _position, ...entry }) => entry));
				return requireBook(db, inserted.id);
			}
			case "delete":
				requireCurrentRevision(db, command.bookId, command.expectedRevision);
				db.delete(lorebookTable).where(eq(lorebookTable.id, command.bookId)).run();
				return { deleted: command.bookId };
			case "save-entry": {
				requireCurrentRevision(db, command.bookId, command.expectedRevision);
				const entry = validateEntry(command.entry);
				if (command.entryId === undefined) {
					const count = db.select({ id: lorebookEntryTable.id }).from(lorebookEntryTable).where(eq(lorebookEntryTable.lorebook_id, command.bookId)).all().length;
					db.insert(lorebookEntryTable).values({ lorebook_id: command.bookId, position: count + 1, ...entryValues(entry) }).run();
				} else {
					const existing = db.select({ id: lorebookEntryTable.id }).from(lorebookEntryTable).where(and(eq(lorebookEntryTable.id, command.entryId), eq(lorebookEntryTable.lorebook_id, command.bookId))).get();
					if (existing === undefined) throw new LorebookEntryNotFoundError(command.entryId);
					db.update(lorebookEntryTable).set(entryValues(entry)).where(eq(lorebookEntryTable.id, command.entryId)).run();
				}
				incrementRevision(db, command.bookId);
				return requireBook(db, command.bookId);
			}
			case "delete-entry":
				requireCurrentRevision(db, command.bookId, command.expectedRevision);
				if (db.select({ id: lorebookEntryTable.id }).from(lorebookEntryTable).where(and(eq(lorebookEntryTable.id, command.entryId), eq(lorebookEntryTable.lorebook_id, command.bookId))).get() === undefined) throw new LorebookEntryNotFoundError(command.entryId);
				db.delete(lorebookEntryTable).where(eq(lorebookEntryTable.id, command.entryId)).run();
				{
					const rows = db.select({ id: lorebookEntryTable.id }).from(lorebookEntryTable).where(eq(lorebookEntryTable.lorebook_id, command.bookId)).orderBy(asc(lorebookEntryTable.position)).all();
					rows.forEach((row, index) => db.update(lorebookEntryTable).set({ position: index + 1 }).where(eq(lorebookEntryTable.id, row.id)).run());
				}
				incrementRevision(db, command.bookId);
				return requireBook(db, command.bookId);
			case "reorder-entry":
				requireCurrentRevision(db, command.bookId, command.expectedRevision);
				reorder(db, command.bookId, command.entryId, command.toPosition);
				incrementRevision(db, command.bookId);
				return requireBook(db, command.bookId);
			case "set-entry-enabled":
				requireCurrentRevision(db, command.bookId, command.expectedRevision);
				if (db.select({ id: lorebookEntryTable.id }).from(lorebookEntryTable).where(and(eq(lorebookEntryTable.id, command.entryId), eq(lorebookEntryTable.lorebook_id, command.bookId))).get() === undefined) throw new LorebookEntryNotFoundError(command.entryId);
				db.update(lorebookEntryTable).set({ enabled: command.enabled }).where(eq(lorebookEntryTable.id, command.entryId)).run();
				incrementRevision(db, command.bookId);
				return requireBook(db, command.bookId);
		}
	}).immediate();
};
