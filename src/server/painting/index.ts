import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationDataTable, messageVariantDataTable } from "../database/schema";
import { illustration, paintingSettings, DEFAULT_PAINTING_ASPECT_RATIO, type Painting, type PaintingCommand, type IllustrationsRead } from "../../shared/contract/painting";
import { ConversationNotFoundError, InvalidConversationCommandError, readConversationRevision, readChatVariantIds, readPaintPresetSettings, commandPaintPreset } from "../conversation";
import { createConnectionSettingsModule, type ConnectionSettingsModuleOptions } from "../connection-settings";
import { readImageModelSettings } from "./image-model-settings";
import { paintImage, type ModelFetch } from "../model-client";
import { imageLoader, ingestImage, storeImage } from "../image";
import { announceChange } from "../database/changes";
import { processStateFor } from "../application/process-state";


const NAMESPACE = "painting";

export const createPaintingModule = (database: Database, options: ConnectionSettingsModuleOptions & { fetch?: ModelFetch } = {}) => {
	const db = drizzle(database);
	const provisional = processStateFor(database).paintings;
	const variants = (conversationId: number) => readChatVariantIds(database, conversationId);
	const requireChat = (conversationId: number) => {
		if (readConversationRevision(database, conversationId) === undefined) throw new ConversationNotFoundError(conversationId);
	};
	const read = (conversationId: number): IllustrationsRead => {
		requireChat(conversationId);
		const row = db.select().from(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, NAMESPACE), eq(conversationDataTable.key, "aspect-ratio"))).get();
		const aspectRatio = row === undefined ? DEFAULT_PAINTING_ASPECT_RATIO : Value.Parse(paintingSettings, JSON.parse(row.value)).aspectRatio;
		const variantIds = variants(conversationId);
		const stored = variantIds.length === 0 ? [] : db.select({ id: messageVariantDataTable.key, variantId: messageVariantDataTable.message_variant_id, value: messageVariantDataTable.value }).from(messageVariantDataTable)
			.where(and(inArray(messageVariantDataTable.message_variant_id, variantIds), eq(messageVariantDataTable.namespace, NAMESPACE))).all();
		const paintings: Painting[] = stored.map(({ id, variantId, value }) => ({ kind: "illustration", id, variantId, ...Value.Parse<typeof illustration>(illustration, JSON.parse(value)) }));
		for (const variantId of variantIds) for (const entry of provisional.forVariant(variantId)) paintings.push(entry.painting);
		return { ...readPaintPresetSettings(database, conversationId), aspectRatio, paintings: paintings.sort((a, b) => a.id.localeCompare(b.id)) };
	};
	const start = (variantId: number, brief: string, aspectRatio: IllustrationsRead["aspectRatio"], id: string = Bun.randomUUIDv7()) => {
		const { profileId, model } = readImageModelSettings(database);
		const connections = createConnectionSettingsModule(database, options);
		const profile = connections.get().profiles.find((profile) => profile.id === profileId);
		if (profile === undefined || profile.apiFormat !== "images" || !model) throw new InvalidConversationCommandError("Choose an Image Model in Connections before painting.");
		const secrets = connections.getProfileSecrets(profile.id);
		const controller = new AbortController();
		const painting = { kind: "painting", id, variantId, brief, aspectRatio, imageModel: { profileId, model } } as const;
		provisional.set(variantId, id, { painting, controller });
		announceChange(database);
		void (async () => {
			try {
				const bytes = await paintImage({ profile, modelId: model, secrets, brief, aspectRatio, loadImage: imageLoader(database), fetch: options.fetch, signal: controller.signal });
				const image = await ingestImage(bytes);
				if (controller.signal.aborted) return;
				database.transaction(() => {
					storeImage(database, image);
					db.insert(messageVariantDataTable).values({ message_variant_id: variantId, namespace: NAMESPACE, key: id, value: JSON.stringify({ image: `image:${image.hash}`, brief, imageModel: painting.imageModel, aspectRatio }) }).run();
				}).immediate();
				provisional.remove(variantId, id);
			} catch (error) {
				if (controller.signal.aborted) return;
				provisional.set(variantId, id, { controller, painting: { ...painting, kind: "failed", message: error instanceof Error ? error.message : "Painting failed." } });
			}
			if (!controller.signal.aborted) announceChange(database);
		})();
	};
	const command = (conversationId: number, command: PaintingCommand) => {
		requireChat(conversationId);
		if (command.type === "select-paint-preset" || command.type === "set-brief-message-count") return commandPaintPreset(database, conversationId, command);
		if (command.type === "set-aspect-ratio") {
			db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: NAMESPACE, key: "aspect-ratio", value: JSON.stringify({ aspectRatio: command.aspectRatio }) })
				.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: JSON.stringify({ aspectRatio: command.aspectRatio }) } }).run();
			return;
		}
		if (!variants(conversationId).includes(command.variantId)) throw new InvalidConversationCommandError("The Variant is no longer available.");
		if (command.type === "delete") {
			db.delete(messageVariantDataTable).where(and(eq(messageVariantDataTable.message_variant_id, command.variantId), eq(messageVariantDataTable.namespace, NAMESPACE), eq(messageVariantDataTable.key, command.id))).run();
			return;
		}
		if (command.type === "paint") {
			if (!command.brief.trim()) throw new InvalidConversationCommandError("Write a Brief before painting.");
			start(command.variantId, command.brief, command.aspectRatio);
			return;
		}
		const failed = provisional.get(command.variantId, command.id)?.painting;
		if (failed?.kind !== "failed") throw new InvalidConversationCommandError("The failed painting is no longer available.");
		if (command.type === "retry") start(failed.variantId, failed.brief, failed.aspectRatio, failed.id);
		else {
			provisional.remove(command.variantId, command.id);
			announceChange(database);
		}
	};
	return { read, command };
};
