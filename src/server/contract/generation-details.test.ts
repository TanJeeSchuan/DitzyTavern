import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import {
	cleanupRetainedGenerationInspections,
	createConversationModule,
	GENERATION_REPLAY_RETENTION_MS,
} from "../conversation";
import { createConversationRoutes } from "./conversation";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

describe("Generation detail transport", () => {
	let database: Database;

	beforeEach(() => { database = openDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("exposes exact active inspection and only compact safe terminal provenance", () => {
		const conversation = createConversationModule(database).create({
			name: "Details Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		const accepted = module.acceptTailGeneration({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			timestamp: "2026-08-27T10:00:00Z",
			humanContent: "Guide the scene.",
			humanParticipantId: conversation.cast[0]!.id,
			modelParticipantId: conversation.cast[1]!.id,
			capturedHumanName: "Writer",
			capturedModelName: "Maren",
			promptPlan: {
				blocks: [{
					kind: "history",
					speakerName: "Writer",
					content: "Guide the scene.",
					role: "human",
				}],
				warnings: [],
			},
			promptInspection: {
				tokenEstimate: 19,
				responseBudget: 64,
				safetyAllowance: 5,
				contextLimit: 128,
				totalRequiredTokens: 88,
				omittedContext: [{ kind: "message", speakerName: "Older", content: "Omitted.", role: "human" }],
			},
			promptContext: [{ kind: "message", speakerName: "Writer", content: "Hello", role: "human" }],
			generationSettings: {
				modelId: "details-model",
				temperature: 0.2,
				contextLimit: 128,
				responseBudget: 64,
				safetyAllowance: 5,
				requestOverrides: { headers: "do-not-expose" },
			},
			connection: {
				profileId: 3,
				settingsRevision: 4,
				backend: "ai-sdk",
				adapter: "deepseek",
				requestUrl: "https://secret.invalid/endpoint",
				credential: "credential-do-not-expose",
			},
			provenance: {
				namespace: "generation",
				key: "provenance",
				value: JSON.stringify({
					connectionProfileId: 3,
					connectionSettingsRevision: 4,
					modelBackend: "ai-sdk",
					adapter: "deepseek",
					modelId: "details-model",
					generationSettings: {
						responseBudget: 64,
						requestOverrides: { credential: "credential-do-not-expose" },
					},
				},),
			},
		});
		const app = createConversationRoutes(database);

		return app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/inspection`,
		)).then(async (inspection) => {
			expect(inspection.status).toBe(200);
			const body = await inspection.text();
			expect(body).toContain("details-model");
			expect(body).toContain('"tokenEstimate":19');
			expect(body).toContain("Omitted.");
			expect(body).not.toContain("secret.invalid");
			expect(body).not.toContain("credential-do-not-expose");

			module.resolveGeneration({
				conversationId: conversation.id,
				generationId: accepted.generationId,
				timestamp: "2026-08-27T10:00:01Z",
				content: "The scene shifts.",
				data: [
					{ namespace: "generation", key: "outcome", value: "length-limited" },
					{ namespace: "generation", key: "finish", value: JSON.stringify({ reason: "length", raw: "raw-provider-body-do-not-expose" }) },
					{ namespace: "generation", key: "usage", value: JSON.stringify({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }) },
				],
			});
			const terminalInspection = await app.handle(new Request(
				`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/inspection`,
			));
			expect(terminalInspection.status).toBe(200);
			const terminalInspectionBody = await terminalInspection.text();
			expect(terminalInspectionBody).toContain('"status":"length-limited"');
			expect(terminalInspectionBody).toContain("Guide the scene.");
			expect(terminalInspectionBody).toContain("Omitted.");
			expect(terminalInspectionBody).not.toContain("credential-do-not-expose");
			const message = module.getSnapshot(conversation.id)?.messages.at(-1);
			const variant = message?.variants.at(-1);
			if (variant === undefined || message === undefined) throw new Error("Variant missing.");
			const details = await app.handle(new Request(
				`http://localhost/api/conversations/${conversation.id}/messages/${message.id}/variants/${variant.id}/details`,
			));
			expect(details.status).toBe(200);
			const detailsBody = await details.text();
			expect(detailsBody).toContain('"connectionProfileId":3');
			expect(detailsBody).toContain('"connectionSettingsRevision":4');
			expect(detailsBody).toContain('"modelBackend":"ai-sdk"');
			expect(detailsBody).toContain('"adapter":"deepseek"');
			expect(detailsBody).toContain('"modelId":"details-model"');
			expect(detailsBody).toContain('"responseBudget":64');
			expect(detailsBody).toContain('"status":"length-limited"');
			expect(detailsBody).toContain('"finishReason":"length"');
			expect(detailsBody).toContain('"interruptionCause":null');
			expect(detailsBody).toContain('"inputTokens":10');
			expect(detailsBody).not.toContain("credential-do-not-expose");
			expect(detailsBody).not.toContain("requestOverrides");
			expect(detailsBody).not.toContain("raw-provider-body-do-not-expose");

			cleanupRetainedGenerationInspections(
				database,
				new Date(Date.now() + GENERATION_REPLAY_RETENTION_MS + 1),
			);
			expect(module.readActiveGenerationDetails(conversation.id, accepted.generationId)).toBeUndefined();
			const expiredInspection = await app.handle(new Request(
				`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/inspection`,
			));
			expect(expiredInspection.status).toBe(404);
			expect(module.readVariantDetails(conversation.id, message.id, variant.id)?.provenance?.status)
				.toBe("length-limited");
		});
	});
});
