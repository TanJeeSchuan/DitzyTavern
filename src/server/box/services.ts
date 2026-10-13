import type { Database } from "bun:sqlite";
import { boxDescriptors, isDigestBoxId, type BoxId } from "../../shared/contract/box";
import { connectionSnapshotOf, createConnectionSettingsModule } from "../connection-settings";
import { decisionRequest, requestDecisions } from "../decision-model";
import { collectModelClientGeneration, createModelClient } from "../model-client";
import type { ModelFetch } from "../model-client/types";
import type { BoxContext, BoxServices } from "./contract";
import { resolveBoxDecision } from "./decision-settings";
import { embedTexts } from "./embedding";

/** @approved Every host service for Box `id`, sending its requests through `fetch` and aborting with `signal`. */
export const boxServices = (database: Database, fetch: ModelFetch | undefined, signal: AbortSignal) => (id: BoxId): BoxContext<keyof BoxServices> => ({
	signal,
	llm: (profileId) => {
		const connections = createConnectionSettingsModule(database);
		const settings = connections.get();
		const profile = settings.profiles.find((item) => item.id === profileId);
		if (profile === undefined) return undefined;
		const client = createModelClient({ profile, secrets: connections.getProfileSecrets(profileId), fetch });
		return {
			complete: ({ model, prompt, contextLimit, responseBudget, signal: limit, onContent }) => collectModelClientGeneration(client, {
				promptPlan: { blocks: [{ kind: "instruction", role: "system", content: prompt }], warnings: [], images: [] },
				modelId: model,
				generationSettings: { temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null, contextLimit, responseBudget, requestOverrides: {} },
				connection: connectionSnapshotOf(settings, profile),
				signal: limit === undefined ? signal : AbortSignal.any([signal, limit]),
			}, { onEvent: (event) => { if (event.type === "content") onContent?.(event.text); } }),
		};
	},
	decide: (state, questions) => {
		const { label } = boxDescriptors[id];
		const resolution = isDigestBoxId(id) ? resolveBoxDecision(database, id) : { kind: "off" as const };
		if (resolution.kind === "off") throw new Error(`Choose a ${label} Decision Model in Connection Settings.`);
		if (resolution.kind === "unavailable") throw new Error(`${resolution.reason} Check the ${label} Decision Model in Connection Settings.`);
		const { request, fits } = decisionRequest(resolution.decision, state, questions);
		if (!fits) throw new Error(`The state sent to the ${label} Decision Model exceeds its token limit.`);
		return requestDecisions({ request, questions, selection: resolution.decision, fetch, signal });
	},
	embed: (texts, configuration, options) => embedTexts(database, texts, configuration, { ...options, fetch, signal }),
});
