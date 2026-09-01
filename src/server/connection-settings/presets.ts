import type { ConnectionPreset, ConnectionProfileDraft } from "./types";

const deepSeekProfile: ConnectionProfileDraft = {
	displayName: "DeepSeek",
	apiFormat: "chat-completions",
	requestUrl: "https://api.deepseek.com/",
	modelsUrl: "https://api.deepseek.com/models",
	modelBackend: "automatic",
	adapter: "deepseek",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120000,
	pinnedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
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
		label: "Generic OpenAI Compatible",
		description: "A blank Chat Completions profile for local or proxied endpoints.",
		profile: {
			displayName: "OpenAI Compatible",
			apiFormat: "chat-completions",
			requestUrl: "",
			modelsUrl: "",
			modelBackend: "automatic",
			adapter: "openai-compatible",
			outputTokenRepresentation: "automatic",
			timeoutMs: 120000,
			pinnedModels: [],
		},
	},
];

export function listConnectionPresets(): readonly ConnectionPreset[] {
	return presets;
}

export function cloneProfileDraft(profile: ConnectionProfileDraft): ConnectionProfileDraft {
	return {
		...profile,
		pinnedModels: [...profile.pinnedModels],
	};
}
