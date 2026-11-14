import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationDataTable, messageVariantDataTable } from "../database/schema";
import { illustration, paintingSettings, DEFAULT_PAINTING_ASPECT_RATIO, type Painting, type PaintingCommand, type IllustrationsRead } from "../../shared/contract/painting";
import { ConversationNotFoundError, InvalidConversationCommandError, readConversationRevision, readChatVariantData, readChatVariantIds, readChatVariants, readConversationSummary, readPaintPresetSettings, commandPaintPreset } from "../conversation";
import { createConnectionSettingsModule, type ConnectionSettingsModuleOptions } from "../connection-settings";
import { readImageModelSettings } from "./image-model-settings";
import { paintImage, type ModelFetch } from "../model-client";
import { imageLoader, ingestImage, storeImage } from "../image";
import { announceChange } from "../database/changes";
import { processStateFor } from "../application/process-state";

import { parseImageReferences } from "../../shared/image-reference";
import { illustrationName } from "../../shared/painting-brief";
import type { GalleryRead } from "../../shared/contract/painting";

import { PAINTING_NAMESPACE } from "../../shared/variant-data-codecs";

export const createPaintingModule = (database: Database, options: ConnectionSettingsModuleOptions & { fetch?: ModelFetch } = {}) => {
	const db = drizzle(database);
	const provisional = processStateFor(database).paintings;
	const variants = (conversationId: number) => readChatVariantIds(database, conversationId);
	const requireChat = (conversationId: number) => {
		if (readConversationRevision(database, conversationId) === undefined) throw new ConversationNotFoundError(conversationId);
	};
	const read = (conversationId: number): IllustrationsRead => {
		requireChat(conversationId);
		const row = db.select().from(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, PAINTING_NAMESPACE), eq(conversationDataTable.key, "aspect-ratio"))).get();
		const aspectRatio = row === undefined ? DEFAULT_PAINTING_ASPECT_RATIO : Value.Parse(paintingSettings, JSON.parse(row.value)).aspectRatio;
		const variantIds = variants(conversationId);
		const stored = readChatVariantData(database, conversationId, PAINTING_NAMESPACE);
		const paintings: Painting[] = stored.map(({ key: id, variantId, value }) => ({ kind: "illustration", id, variantId, ...Value.Parse<typeof illustration>(illustration, JSON.parse(value)) }));
		for (const variantId of variantIds) for (const entry of provisional.forVariant(variantId)) paintings.push(entry.painting);
		return { ...readPaintPresetSettings(database, conversationId), aspectRatio, paintings: paintings.sort((a, b) => a.id.localeCompare(b.id)) };
	};
	const start = ({ variantId, brief, ask, aspectRatio, id = Bun.randomUUIDv7() }: Pick<Painting, "variantId" | "brief" | "ask" | "aspectRatio"> & { id?: string }) => {
		const { profileId, model } = readImageModelSettings(database);
		const connections = createConnectionSettingsModule(database, options);
		const profile = connections.get().profiles.find((profile) => profile.id === profileId);
		if (profile === undefined || profile.apiFormat !== "images" || !model) throw new InvalidConversationCommandError("Choose an Image Model in Connections before painting.");
		const secrets = connections.getProfileSecrets(profile.id);
		const controller = new AbortController();
		const painting = { kind: "painting", id, variantId, brief, ask, aspectRatio, imageModel: { profileId, model } } as const;
		provisional.set(variantId, id, { painting, controller });
		announceChange(database);
		void (async () => {
			try {
				const bytes = await paintImage({ profile, modelId: model, secrets, brief, aspectRatio, loadImage: imageLoader(database), fetch: options.fetch, signal: controller.signal });
				const image = await ingestImage(bytes);
				if (controller.signal.aborted) return;
				database.transaction(() => {
					storeImage(database, image);
					db.insert(messageVariantDataTable).values({ message_variant_id: variantId, namespace: PAINTING_NAMESPACE, key: id, value: JSON.stringify({ image: `image:${image.hash}`, brief, ask, imageModel: painting.imageModel, aspectRatio }) }).run();
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
			db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: PAINTING_NAMESPACE, key: "aspect-ratio", value: JSON.stringify({ aspectRatio: command.aspectRatio }) })
				.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: JSON.stringify({ aspectRatio: command.aspectRatio }) } }).run();
			return;
		}
		if (command.type === "remove-from-gallery") {
			const { conversation_id, namespace, key } = conversationDataTable;
			db.delete(conversationDataTable).where(and(eq(conversation_id, conversationId), eq(namespace, PAINTING_NAMESPACE), eq(key, `gallery:${command.id}`))).run();
			return;
		}
		if (!variants(conversationId).includes(command.variantId)) throw new InvalidConversationCommandError("This reply was deleted; reopen Paint.");
		if (command.type === "delete" || command.type === "keep-in-gallery") {
			const { message_variant_id, namespace, key } = messageVariantDataTable;
			const row = and(eq(message_variant_id, command.variantId), eq(namespace, PAINTING_NAMESPACE), eq(key, command.id));
			database.transaction(() => {
				const removed = db.delete(messageVariantDataTable).where(row).returning().get();
				if (command.type !== "keep-in-gallery" || !removed) return;
				db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: PAINTING_NAMESPACE, key: `gallery:${command.id}`, value: removed.value }).run();
			}).immediate();
			return;
		}
		if (command.type === "paint") {
			if (!command.brief.trim()) throw new InvalidConversationCommandError("Write a Brief before painting.");
			start(command);
			return;
		}
		const failed = provisional.get(command.variantId, command.id)?.painting;
		if (failed?.kind !== "failed") throw new InvalidConversationCommandError("The failed painting is no longer available.");
		if (command.type === "retry") start(failed);
		else {
			provisional.remove(command.variantId, command.id);
			announceChange(database);
		}
	};
	const gallery = (conversationId: number): GalleryRead => {
		const chat = readConversationSummary(database, conversationId);
		if (!chat) throw new ConversationNotFoundError(conversationId);
		const kept = db.select().from(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, PAINTING_NAMESPACE), like(conversationDataTable.key, "gallery:%"))).all()
			.map(({ key, value }) => ({ keptId: key.slice("gallery:".length), ...Value.Parse(illustration, JSON.parse(value)) }));
		const name = ({ image, ask }: { image: string; ask: string }) => ({ hash: image.slice(6), name: illustrationName(ask) });
		const images: GalleryRead = [
			...read(conversationId).paintings.flatMap((painting) => painting.kind === "illustration" ? [name(painting)] : []),
			...kept.map((painting) => ({ ...name(painting), keptId: painting.keptId })),
			...readChatVariants(database, conversationId, { includeActive: true }).flatMap(({ content }) => parseImageReferences(content)),
			...chat.cast.flatMap((participant) => [
				...(participant.portrait ? [{ hash: participant.portrait.hash, name: `${participant.name} Portrait` }] : []),
				...parseImageReferences(participant.prompt.appearance),
			]),
		];
		const firstByHash = new Map<string, GalleryRead[number]>();
		for (const { hash, name, keptId } of images) {
			const first = firstByHash.get(hash);
			firstByHash.set(hash, { hash, name: first?.name ?? name, keptId: first?.keptId ?? keptId });
		}
		return [...firstByHash.values()];
	};
	return { read, command, gallery };
};
