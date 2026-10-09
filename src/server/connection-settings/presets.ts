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
	{ id: "openrouter-decisions", label: "OpenRouter Decisions", description: "Decision Models through OpenRouter.", profile: { ...blankConnectionProfileDraft, displayName: "OpenRouter Decisions", apiFormat: "system-one", requestUrl: "https://openrouter.ai/api/v1/", modelsUrl: "https://openrouter.ai/api/v1/models?output_modalities=decisions", timeoutMs: 15_000, pinnedModels: ["typesafe/jev-1.13", "cloudflare/clef", "cloudflare/clef-flash"] } },
	{ id: "typesafe", label: "TypeSafe", description: "Jev through TypeSafe.", profile: { ...blankConnectionProfileDraft, displayName: "TypeSafe", apiFormat: "system-one", requestUrl: "https://api.typesafe.ai/v1/", timeoutMs: 15_000, pinnedModels: ["jev-1.13.0"] } },
	{ id: "system-one", label: "System One endpoint", description: "A blank System One profile for local or proxied endpoints.", profile: { ...blankConnectionProfileDraft, apiFormat: "system-one", timeoutMs: 15_000 } },
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
