import type { ConnectionPreset, ConnectionProfileDraft } from "./types";
import {
	blankConnectionProfileDraft,
	connectionProfileDraftOf,
} from "../../shared/contract/connection-settings";

const deepSeekProfile: ConnectionProfileDraft = {
	displayName: "DeepSeek",
	apiFormat: "chat-completions",
	requestUrl: "https://api.deepseek.com/",
	modelsUrl: "https://api.deepseek.com/models",
	modelBackend: "automatic",
	adapter: "deepseek",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120000,
	pinnedModels: ["deepseek-flash", "deepseek-v4-pro"],
};

const presets: readonly ConnectionPreset[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		description: "DeepSeek Chat Completions with the official adapter.",
		profile: deepSeekProfile,
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		description: "OpenRouter Chat Completions with its official adapter.",
		profile: {
			displayName: "OpenRouter",
			apiFormat: "chat-completions",
			requestUrl: "https://openrouter.ai/api/v1/",
			modelsUrl: "https://openrouter.ai/api/v1/models",
			modelBackend: "automatic",
			adapter: "openrouter",
			outputTokenRepresentation: "automatic",
			timeoutMs: 120000,
			pinnedModels: [
				"deepseek/deepseek-v4-flash",
				"google/gemma-4-31b-it",
				"z-ai/glm-5.3",
			],
		},
	},
	{
		id: "generic-openai-compatible",
		label: "OpenAI Compatible",
		description: "A blank Chat Completions profile for local or proxied endpoints.",
		profile: connectionProfileDraftOf(blankConnectionProfileDraft),
	},
	{
		id: "openai-compatible-embeddings",
		label: "Embeddings",
		description: "An OpenAI-compatible embeddings endpoint for Memory recall.",
		profile: { ...connectionProfileDraftOf(blankConnectionProfileDraft), apiFormat: "embeddings", timeoutMs: 5000 },
	},
];

export function listConnectionPresets(): readonly ConnectionPreset[] {
	return presets;
}
