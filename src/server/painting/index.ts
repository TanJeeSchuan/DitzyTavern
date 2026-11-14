import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationDataTable, messageVariantDataTable } from "../database/schema";
import { illustration, keptImage, paintingSettings, referenceSet, DEFAULT_PAINTING_ASPECT_RATIO, type Painting, type PaintingCommand, type IllustrationsRead, type ReferenceSet } from "../../shared/contract/painting";
import { ConversationNotFoundError, InvalidConversationCommandError, readConversationRevision, readChatVariantData, readChatVariantIds, readChatVariants, readConversationSummary, readPaintPresetSettings, commandPaintPreset } from "../conversation";
import { createConnectionSettingsModule, type ConnectionSettingsModuleOptions } from "../connection-settings";
import { readImageModelSettings } from "./image-model-settings";
import { paintImage, type ModelFetch } from "../model-client";
import { imageLoader, ingestImage, readImage, storeImage } from "../image";
import { announceChange } from "../database/changes";
import { processStateFor } from "../application/process-state";

import { parseImageReferences } from "../../shared/image-reference";
import { briefWithReferences, illustrationName } from "../../shared/painting-brief";
import type { GalleryRead } from "../../shared/contract/painting";

import { PAINTING_NAMESPACE } from "../../shared/variant-data-codecs";

export const createPaintingModule = (database: Database, options: ConnectionSettingsModuleOptions & { fetch?: ModelFetch } = {}) => {
	const db = drizzle(database);
	const provisional = processStateFor(database).paintings;
	const variants = (conversationId: number) => readChatVariantIds(database, conversationId);
	const requireChat = (conversationId: number) => {
		if (readConversationRevision(database, conversationId) === undefined) throw new ConversationNotFoundError(conversationId);
	};
	const chatRow = (conversationId: number, key: string) => and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, PAINTING_NAMESPACE), eq(conversationDataTable.key, key));
	const writeChatRow = (conversationId: number, key: string, value: string) => db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: PAINTING_NAMESPACE, key, value })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value } }).run();
	const referenceSets = (conversationId: number): ReferenceSet[] => {
		const sets = db.select().from(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, PAINTING_NAMESPACE), like(conversationDataTable.key, "reference-set:%"))).all()
			.map(({ key, value }) => Value.Parse(referenceSet, { ...JSON.parse(value), id: key.slice("reference-set:".length) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		return sets.length === 0 ? [{ id: "default", name: "References", references: "" }] : sets;
	};
	const read = (conversationId: number): IllustrationsRead => {
		requireChat(conversationId);
		const row = db.select().from(conversationDataTable).where(chatRow(conversationId, "aspect-ratio")).get();
		const aspectRatio = row === undefined ? DEFAULT_PAINTING_ASPECT_RATIO : Value.Parse(paintingSettings, JSON.parse(row.value)).aspectRatio;
		const variantIds = variants(conversationId);
		const stored = readChatVariantData(database, conversationId, PAINTING_NAMESPACE);
		const paintings: Painting[] = stored.map(({ key: id, variantId, value }) => ({ kind: "illustration", id, variantId, ...Value.Parse<typeof illustration>(illustration, JSON.parse(value)) }));
		for (const variantId of variantIds) for (const entry of provisional.forVariant(variantId)) paintings.push(entry.painting);
		const sets = referenceSets(conversationId);
		const selected = db.select().from(conversationDataTable).where(chatRow(conversationId, "selected-reference-set")).get();
		const referenceSetId = sets.find(({ id }) => selected !== undefined && id === JSON.parse(selected.value))?.id ?? sets[0]!.id;
		return { ...readPaintPresetSettings(database, conversationId), aspectRatio, paintings: paintings.sort((a, b) => a.id.localeCompare(b.id)), referenceSets: sets, referenceSetId };
	};
	const start = ({ variantId, brief, references, ask, aspectRatio, id = Bun.randomUUIDv7() }: Pick<Painting, "variantId" | "brief" | "references" | "ask" | "aspectRatio"> & { id?: string }) => {
		const { profileId, model } = readImageModelSettings(database);
		const connections = createConnectionSettingsModule(database, options);
		const profile = connections.get().profiles.find((profile) => profile.id === profileId);
		if (profile === undefined || profile.apiFormat !== "images" || !model) throw new InvalidConversationCommandError("Choose an Image Model in Connections before painting.");
		const secrets = connections.getProfileSecrets(profile.id);
		const controller = new AbortController();
		const painting = { kind: "painting", id, variantId, brief, references, ask, aspectRatio, imageModel: { profileId, model } } as const;
		provisional.set(variantId, id, { painting, controller });
		announceChange(database);
		void (async () => {
			try {
				const bytes = await paintImage({ profile, modelId: model, secrets, brief: briefWithReferences(brief, references), aspectRatio, loadImage: imageLoader(database), fetch: options.fetch, signal: controller.signal });
				const image = await ingestImage(bytes);
				if (controller.signal.aborted) return;
				database.transaction(() => {
					storeImage(database, image);
					db.insert(messageVariantDataTable).values({ message_variant_id: variantId, namespace: PAINTING_NAMESPACE, key: id, value: JSON.stringify({ image: `image:${image.hash}`, brief, references, ask, imageModel: painting.imageModel, aspectRatio }) }).run();
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
		if (command.type === "set-aspect-ratio") return void writeChatRow(conversationId, "aspect-ratio", JSON.stringify({ aspectRatio: command.aspectRatio }));
		if (command.type === "save-reference-set" || command.type === "rename-reference-set") {
			const set = referenceSets(conversationId).find(({ id }) => id === command.id);
			if (set === undefined) throw new InvalidConversationCommandError("This Reference Set was deleted.");
			const { name, references } = set;
			return void writeChatRow(conversationId, `reference-set:${command.id}`, JSON.stringify(command.type === "save-reference-set" ? { name, references: command.references } : { name: command.name.trim(), references }));
		}
		if (command.type === "select-reference-set") return void writeChatRow(conversationId, "selected-reference-set", JSON.stringify(command.id));
		if (command.type === "delete-reference-set") return void db.delete(conversationDataTable).where(chatRow(conversationId, `reference-set:${command.id}`)).run();
		if (command.type === "create-reference-set") {
			const id = Bun.randomUUIDv7();
			database.transaction(() => {
				writeChatRow(conversationId, `reference-set:${id}`, JSON.stringify({ name: command.name.trim(), references: command.references }));
				writeChatRow(conversationId, "selected-reference-set", JSON.stringify(id));
			}).immediate();
			return;
		}
		if (command.type === "add-to-gallery") {
			if (readImage(db, command.hash) === undefined) throw new InvalidConversationCommandError("The image is missing; upload it again.");
			db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: PAINTING_NAMESPACE, key: `gallery:${command.hash}`, value: JSON.stringify({ image: `image:${command.hash}`, name: command.name }) }).onConflictDoNothing().run();
			return;
		}
		if (command.type === "remove-from-gallery") return void db.delete(conversationDataTable).where(chatRow(conversationId, `gallery:${command.id}`)).run();
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
			.map(({ key, value }) => ({ keptId: key.slice("gallery:".length), image: Value.Parse(keptImage, JSON.parse(value)) }));
		const entry = ({ image, ask, brief, references, imageModel }: Static<typeof illustration>) =>
			({ hash: image.slice(6), name: illustrationName(ask), source: imageModel.model, painted: { brief, references, ask } });
		const images: GalleryRead = [
			...read(conversationId).paintings.flatMap((painting) => painting.kind === "illustration" ? [entry(painting)] : []),
			...kept.map(({ keptId, image }) => ({ ...("brief" in image ? entry(image) : { hash: image.image.slice(6), name: image.name, source: "Uploaded" }), keptId })),
			...readChatVariants(database, conversationId, { includeActive: true }).flatMap(({ content }) => parseImageReferences(content).map(({ hash, name }) => ({ hash, name, source: "Message" }))),
			...chat.cast.flatMap((participant) => [
				...(participant.portrait ? [{ hash: participant.portrait.hash, name: `${participant.name} Portrait` }] : []),
				...parseImageReferences(participant.prompt.appearance),
			].map(({ hash, name }) => ({ hash, name, source: participant.name }))),
		];
		const firstByHash = new Map<string, GalleryRead[number]>();
		for (const image of images) {
			const first = firstByHash.get(image.hash);
			firstByHash.set(image.hash, first === undefined ? image : { ...first, keptId: first.keptId ?? image.keptId, painted: first.painted ?? image.painted });
		}
		return [...firstByHash.values()];
	};
	return { read, command, gallery };
};
