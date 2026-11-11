import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "../conversation";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule, type ConnectionSettingsModuleOptions } from "../connection-settings";
import { DESCRIBE_INSTRUCTION, type DescribeRequest } from "../../shared/contract/describe";
import { formatImageReference, projectImageAnchors } from "../../shared/image-reference";
import { InvalidSettingsError } from "../revisioned-settings";
import { imageLoader, imageLookup } from "../image";
import { resolvePromptImages } from "../prompt-compiler/images";
import { collectModelClientGeneration, createModelClient, type ModelFetch } from "../model-client";
import { readDescribingModelSettings } from "./describing-model-settings";

export const describeImages = async (database: Database, { hashes, ask }: DescribeRequest, options: ConnectionSettingsModuleOptions & { fetch?: ModelFetch }, signal: AbortSignal) => {
	const { profileId, model } = readDescribingModelSettings(database);
	const connections = createConnectionSettingsModule(database, options);
	const profile = connections.get().profiles.find((profile) => profile.id === profileId);
	if (profile?.apiFormat !== "chat-completions" || !model) throw new InvalidSettingsError("Choose a describing model in Connection Settings.");
	if (profile.textOnlyModels.includes(model)) throw new InvalidSettingsError("Choose a describing model that accepts Images");
	const lookup = imageLookup(database);
	if (hashes.some((hash) => lookup(hash) === undefined)) throw new InvalidSettingsError("An Image is no longer available.");
	const promptPlan = resolvePromptImages({ blocks: [
		{ kind: "instruction", role: "system", content: DESCRIBE_INSTRUCTION },
		{ kind: "instruction", role: "human", content: [...hashes.map((hash, index) => formatImageReference(`Picture ${index + 1}`, hash)), projectImageAnchors(ask ?? "")].filter(Boolean).join("\n\n") },
	], warnings: [] }, { lookup, sendImages: true, placement: "every" });
	const client = createModelClient({ profile, secrets: connections.getProfileSecrets(profile.id), loadImage: imageLoader(database), fetch: options.fetch });
	const result = await collectModelClientGeneration(client, { promptPlan, modelId: model, signal, generationSettings: {
		...DEFAULT_CONVERSATION_GENERATION_SETTINGS, requestOverrides: {},
	} });
	return { text: result.content };
};
