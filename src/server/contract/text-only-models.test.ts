import { openObservedDatabase } from "../conversation/test-fixtures";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createGenerationCoordinator } from "../application/generation-coordinator";
import { createConversationRoutes } from "./conversation";
import { createConnectionSettingsRoutes } from "./connection-settings";
import { pngFixture } from "../image/image-fixtures";
import { uploadImage } from "../image";
import { formatImageReference } from "../../shared/image-reference";

const key = new Uint8Array(32).fill(29);
const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const profile = {
	displayName: "Vision",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43127/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "openai-compatible" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: [],
};

const stream = () => new Response([
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Seen." }, finish_reason: null }] })}\n\n`,
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
	"data: [DONE]\n\n",
].join(""), { headers: { "content-type": "text/event-stream" } });

type Wire = { model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };

describe("Text-only Models", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => { database.close(); });

	const settings = () => createConnectionSettingsModule(database, { masterKey: key });
	const createProfile = () => {
		settings().createProfile({ expectedRevision: 0, profile, credential: "secret" });
		return settings().get().profiles[0]!;
	};

	const mark = (profileId: number, modelId: string, textOnly: boolean) =>
		createConnectionSettingsRoutes(database, { masterKey: key }).handle(new Request("http://localhost/api/connection-settings/text-only-model", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ profileId, modelId, textOnly }),
		}));

	const chat = (modelId: string) => {
		const conversation = createConversationModule(database).create({
			name: "Chat",
			participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Maren", prompt, openings: [] } }],
			control: { human: 0, model: 1 },
		});
		const conversations = createConversationModule(database);
		conversations.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "update-generation-settings",
				settings: { ...conversations.getGenerationSettings(conversation.id)!, modelId },
			},
		});
		return conversation.id;
	};

	const sendPicture = async (conversationId: number, hash: string) => {
		const requests: Wire[] = [];
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async (_url, init) => {
				// SAFETY: the controlled fake receives the adapter's JSON request body.
				requests.push(JSON.parse(String(init?.body)) as Wire);
				return stream();
			},
		});
		const revision = createConversationModule(database).getRevision(conversationId) ?? 0;
		const response = await app.handle(new Request(`http://localhost/api/conversations/${conversationId}/generations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "send",  expectedRevision: revision, content: `Look ${formatImageReference("map", hash)}` }),
		}));
		expect(response.status).toBe(200);
		// SAFETY: the route's accepted response is this typed shape.
		const accepted = await response.json() as { generationId: number };
		await (await app.handle(new Request(`http://localhost/api/conversations/${conversationId}/generations/${accepted.generationId}/events`))).text();
		return requests;
	};

	const picture = async () => {
		const { hash } = await uploadImage(database, pngFixture({ width: 4 }));
		return { hash };
	};

	const imageParts = (requests: Wire[]) =>
		requests.flatMap((request) => request.messages).flatMap(({ content }) => Array.isArray(content) ? content.filter((part) => part.type === "image_url") : []);

	test("a mark set once applies to every Chat using the Profile and only to that model", async () => {
		const created = createProfile();
		const first = chat("vision-model");
		const second = chat("vision-model");
		const other = chat("other-model");
		const art = await picture();

		expect(imageParts(await sendPicture(first, art.hash))).toHaveLength(1);

		const marked = await mark(created.id, "vision-model", true);
		expect(marked.status).toBe(200);
		expect((await marked.json()).settings.profiles[0].textOnlyModels).toEqual(["vision-model"]);

		const afterMark = await sendPicture(second, art.hash);
		expect(imageParts(afterMark)).toHaveLength(0);
		expect(JSON.stringify(afterMark)).toContain("[Image: map]");
		expect(imageParts(await sendPicture(other, art.hash))).toHaveLength(1);

		await mark(created.id, "vision-model", false);
		expect(imageParts(await sendPicture(first, art.hash))).toHaveLength(1);
	});

	test("a Generation that fails before output with Images offers the model it sent them to", async () => {
		const created = createProfile();
		const conversationId = chat("vision-model");
		const art = await picture();
		const failures = async (conversationId: number, content: string) => {
			const app = createConversationRoutes(database, {
				masterKey: key,
				fetch: async () => new Response(JSON.stringify({ error: { message: "no vision" } }), { status: 400 }),
			});
			const revision = createConversationModule(database).getRevision(conversationId) ?? 0;
			const response = await app.handle(new Request(`http://localhost/api/conversations/${conversationId}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send",  expectedRevision: revision, content }),
			}));
			// SAFETY: the route's accepted response is this typed shape.
			const accepted = await response.json() as { generationId: number };
			return (await app.handle(new Request(`http://localhost/api/conversations/${conversationId}/generations/${accepted.generationId}/events`))).text();
		};

		const withImage = await failures(conversationId, `Look ${formatImageReference("map", art.hash)}`);
		expect(withImage).toContain(`"imageModel":{"connectionProfileId":${created.id},"modelId":"vision-model"}`);

		const plain = await failures(chat("vision-model"), "Just words");
		expect(plain).toContain("event: error");
		expect(plain).not.toContain("imageModel");
		const missing = await failures(chat("vision-model"), formatImageReference("missing", "f".repeat(64)));
		expect(missing).not.toContain("imageModel");
		await mark(created.id, "vision-model", true);
		const textOnly = await failures(chat("vision-model"), formatImageReference("map", art.hash));
		expect(textOnly).not.toContain("imageModel");
	});

	test("a cancelled image request offers no model when Stop releases terminal ownership", async () => {
		createProfile();
		const conversationId = chat("vision-model");
		const art = await picture();
		const requested = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const coordinator = createGenerationCoordinator(database, {
			masterKey: key,
			fetch: () => { requested.resolve(); return response.promise; },
		});
		const started = await coordinator.startGeneration({
			conversationId,
			expectedRevision: createConversationModule(database).getRevision(conversationId)!,
			target: { kind: "send", content: formatImageReference("map", art.hash) },
		});
		await requested.promise;
		started.runtime.stop();
		started.runtime.releaseStopRequest();
		response.resolve(stream());
		await expect(started.result).rejects.toMatchObject({ kind: "cancelled" });
		expect(started.runtime.state.status).toBe("failed");
		expect(started.runtime.state.imageModel).toBeUndefined();
	});

	test("a prefill refused for its Image offers no model, since no request was sent", async () => {
		createProfile();
		const conversationId = chat("vision-model");
		const art = await picture();
		const conversations = createConversationModule(database);
		const snapshot = conversations.getSnapshot(conversationId)!;
		const withMessage = conversations.execute({
			conversationId,
			expectedRevision: snapshot.revision,
			action: {
				type: "create-message",
				timestamp: "2026-10-05T00:00:00Z",
				variantContents: [`Here ${formatImageReference("map", art.hash)}`],
				authorParticipantId: snapshot.cast[1]!.id,
			},
		});
		const configured = conversations.execute({
			conversationId,
			expectedRevision: withMessage.revision,
			action: {
				type: "update-generation-settings",
				settings: { ...conversations.getGenerationSettings(conversationId)!, continuationStrategy: "assistant-prefill" },
			},
		});
		let requests = 0;
		const started = await createGenerationCoordinator(database, {
			masterKey: key,
			fetch: async () => { requests += 1; return stream(); },
		}).startGeneration({target: { kind: "continuation" }, conversationId, expectedRevision: configured.revision });
		await expect(started.result).rejects.toMatchObject({ kind: "protocol" });
		expect(requests).toBe(0);
		expect(started.runtime.state.imageModel).toBeUndefined();
	});

	test("a mark never advances the settings revision and survives Profile edits", async () => {
		const created = createProfile();
		const revision = settings().get().revision;
		await mark(created.id, "vision-model", true);
		await mark(created.id, "vision-model", true);
		expect(settings().get().revision).toBe(revision);

		settings().applyProfile({
			expectedRevision: revision,
			profileId: created.id,
			profile: { ...profile, displayName: "Renamed", pinnedModels: ["vision-model"] },
		});
		expect(settings().get().profiles[0]?.textOnlyModels).toEqual(["vision-model"]);
	});

	test("refuses a mark for an unknown Profile or a blank model", async () => {
		const created = createProfile();
		expect((await mark(created.id + 1, "vision-model", true)).status).toBe(404);
		expect((await mark(created.id, "  ", true)).status).toBe(422);
		expect(settings().get().profiles[0]?.textOnlyModels).toEqual([]);
	});

	test("deleting a Profile removes its marks", async () => {
		const created = createProfile();
		await mark(created.id, "vision-model", true);
		settings().deleteProfile({ expectedRevision: settings().get().revision, profileId: created.id });
		expect(database.query("SELECT 1 FROM connection_profile_text_only_model").all()).toEqual([]);
	});
});
