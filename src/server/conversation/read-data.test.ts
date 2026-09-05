import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "./index";

// The narrow Conversation data read is exercised through the same public
// module interface as production callers (ADR-0013): write Conversation-
// scoped entries with the put-data command, then read them back through
// readConversationData, including the vocabulary-free namespace/key filters.
describe("readConversationData", () => {
	let database: Database;
	let conversationId: number;
	let revision: number;
	const module = () => createConversationModule(database);

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		const created = module().create({
			name: "Read Data Conversation",
			participants: [
				{
					definition: {
						name: "Writer",
						prompt: emptyPrompt(),
						openings: [],
					},
				},
				{
					definition: {
						name: "Maren",
						prompt: emptyPrompt(),
						openings: ["Greeting"],
					},
				},
			],
			control: { human: 0, model: 1 },
		});
		conversationId = created.id;
		revision = created.revision;
	});

	const writeData = (namespace: string, key: string, value: string): void => {
		const snapshot = module().execute({
			conversationId,
			expectedRevision: revision,
			action: {
				type: "put-data",
				scope: { type: "conversation" },
				namespace,
				key,
				value,
			},
		});
		revision = snapshot.revision;
	};

	const emptyPrompt = () => ({
		systemInstruction: "",
		identity: "",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	});

	afterEach(() => {
		database.close();
	});

	test("returns the Conversation name and every Conversation-scoped entry", () => {
		writeData("first.namespace", "alpha", "1");
		writeData("first.namespace", "beta", "2");
		writeData("second.namespace", "gamma", "3");

		const read = module().readConversationData(conversationId);
		expect(read).toEqual({
			name: "Read Data Conversation",
			entries: [
				{ namespace: "first.namespace", key: "alpha", value: "1" },
				{ namespace: "first.namespace", key: "beta", value: "2" },
				{ namespace: "second.namespace", key: "gamma", value: "3" },
			],
		});
	});

	test("filters entries to one namespace", () => {
		writeData("first.namespace", "alpha", "1");
		writeData("second.namespace", "gamma", "3");

		const read = module().readConversationData(conversationId, {
			namespace: "second.namespace",
		});
		expect(read?.name).toBe("Read Data Conversation");
		expect(read?.entries).toEqual([
			{ namespace: "second.namespace", key: "gamma", value: "3" },
		]);
	});

	test("filters entries to a key set within a namespace", () => {
		writeData("import.test", "reportJson", "{\"count\":2}");
		writeData("import.test", "warnings", "[]");
		writeData("import.test", "sha256", "abc");

		const read = module().readConversationData(conversationId, {
			namespace: "import.test",
			keys: ["reportJson", "warnings"],
		});
		expect(read?.entries).toEqual([
			{ namespace: "import.test", key: "reportJson", value: "{\"count\":2}" },
			{ namespace: "import.test", key: "warnings", value: "[]" },
		]);
	});

	test("a keys filter without a namespace crosses namespaces", () => {
		writeData("first.namespace", "sha256", "a");
		writeData("second.namespace", "sha256", "b");

		const read = module().readConversationData(conversationId, {
			keys: ["sha256"],
		});
		expect(read?.entries).toEqual([
			{ namespace: "first.namespace", key: "sha256", value: "a" },
			{ namespace: "second.namespace", key: "sha256", value: "b" },
		]);
	});

	test("an empty keys array reads every key", () => {
		writeData("first.namespace", "alpha", "1");
		writeData("first.namespace", "beta", "2");

		const read = module().readConversationData(conversationId, { keys: [] });
		expect(read?.entries).toHaveLength(2);
	});

	test("returns undefined for a missing Conversation", () => {
		expect(module().readConversationData(999999)).toBeUndefined();
	});

	test("returns the name and an empty entry list for a filter with no matches", () => {
		writeData("first.namespace", "alpha", "1");

		const read = module().readConversationData(conversationId, {
			namespace: "unused.namespace",
		});
		expect(read).toEqual({ name: "Read Data Conversation", entries: [] });
	});
});
