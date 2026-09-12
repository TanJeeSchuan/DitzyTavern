import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import {
	captureModelFetch,
	completeGeneration,
	startGeneration,
	withProfile,
} from "./prompt-preset-test-fixtures";
import {
	macroVariables,
	macroVariablesAppliedResponse,
	type MacroVariablesEditBody,
} from "../../shared/contract/macro-variables";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const createChat = (database: Database) => createConversationModule(database).create({
	name: "Variables Chat",
	participants: [
		{ definition: { name: "Writer", prompt, openings: [] } },
		{ definition: { name: "Maren", prompt, openings: [] } },
	],
	control: { human: 0, model: 1 },
});

describe("Macro Variables transport", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("reads initial values, records Variant provenance, and masks inherited values on delete", async () => {
		const conversation = createChat(database);
		const app = createConversationRoutes(database);
		const edit = async (body: MacroVariablesEditBody) => app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/macro-variables`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		));

		let response = await edit({
			expectedRevision: 0,
			promptPresetId: 1,
			position: 0,
			operation: "set",
			name: "mood",
			value: "calm",
		});
		expect(response.status).toBe(200);
		// SAFETY: the route response is validated by its declared macro-variable contract.
		const initial = Value.Decode(macroVariablesAppliedResponse, await response.json());

		const module = createConversationModule(database);
		const message = module.execute({
			conversationId: conversation.id,
			expectedRevision: initial.conversation.revision,
			action: {
				type: "create-message",
				timestamp: "2026-09-12T00:00:00.000Z",
				variantContents: ["A direction."],
				authorParticipantId: conversation.cast[0]!.id,
			},
		});

		response = await edit({
			expectedRevision: message.revision,
			promptPresetId: 1,
			position: 1,
			operation: "set",
			name: "mood",
			value: "stormy\nwith rain",
		});
		expect(response.status).toBe(200);
		// SAFETY: the route response is validated by its declared macro-variable contract.
		const changed = Value.Decode(macroVariablesAppliedResponse, await response.json());
		expect(changed.variables.variables).toEqual([{
			name: "mood",
			value: "stormy\nwith rain",
			source: {
				type: "variant",
				messageId: 1,
				messagePosition: 1,
				variantId: 1,
				variantPosition: 1,
			},
		}]);

		response = await edit({
			expectedRevision: changed.conversation.revision,
			promptPresetId: 1,
			position: 1,
			operation: "delete",
			name: "mood",
		});
		expect(response.status).toBe(200);
		// SAFETY: the route response is validated by its declared macro-variable contract.
		const deleted = Value.Decode(macroVariablesAppliedResponse, await response.json());
		expect(deleted.variables.variables).toEqual([]);
	});

	test("rejects stale edits without changing Macro State", async () => {
		const conversation = createChat(database);
		const app = createConversationRoutes(database);
		const response = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/macro-variables`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: 4,
					promptPresetId: 1,
					position: 0,
					operation: "set",
					name: "ignored",
					value: "value",
				}),
			},
		));
		expect(response.status).toBe(409);
		const read = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/macro-variables`,
		));
		// SAFETY: the route response is validated by its declared macro-variable contract.
		expect(Value.Decode(macroVariables, await read.json()).variables).toEqual([]);
	});

	test("feeds an HTTP-edited selected Variant value into the next Generation", async () => {
		const conversation = createChat(database);
		database.query("UPDATE participant_prompt SET system_instruction = ? WHERE participant_id = ?")
			.run("mood={{getvar::mood}}", conversation.cast[1]!.id);
		withProfile(database);
		let captured: { messages: { role: string; content: string }[] } | undefined;
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const edit = async (body: MacroVariablesEditBody) => app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/macro-variables`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		));

		let response = await edit({
			expectedRevision: conversation.revision,
			promptPresetId: 1,
			position: 0,
			operation: "set",
			name: "mood",
			value: "calm",
		});
		// SAFETY: the route response is validated by its declared macro-variable contract.
		const initial = Value.Decode(macroVariablesAppliedResponse, await response.json());
		const message = createConversationModule(database).execute({
			conversationId: conversation.id,
			expectedRevision: initial.conversation.revision,
			action: {
				type: "create-message",
				timestamp: "2026-09-12T00:00:00.000Z",
				variantContents: ["A direction."],
				authorParticipantId: conversation.cast[0]!.id,
			},
		});
		response = await edit({
			expectedRevision: message.revision,
			promptPresetId: 1,
			position: 1,
			operation: "set",
			name: "mood",
			value: "stormy\nwith rain",
		});
		expect(response.status).toBe(200);
		const changed = Value.Decode(macroVariablesAppliedResponse, await response.json());
		const generationId = await startGeneration(app, conversation.id, changed.conversation.revision);
		await completeGeneration(app, conversation.id, generationId);
		expect(captured?.messages).toContainEqual({
			role: "system",
			content: "mood=stormy\nwith rain",
		});
	});
});
