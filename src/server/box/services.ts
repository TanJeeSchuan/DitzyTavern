import type { Database } from "bun:sqlite";
import { boxDescriptor, isDigestBox, type BoxId } from "../../shared/contract/box";
import { connectionSnapshotOf, createConnectionSettingsModule } from "../connection-settings";
import { decisionRequest, requestDecisions } from "../decision-model";
import { collectModelClientGeneration, createModelClient } from "../model-client";
import type { ModelFetch } from "../model-client/types";
import type { BoxContext, BoxServices } from "./contract";
import { resolveBoxDecision } from "./decision-settings";
import { embedTexts } from "./embedding";

export type BoxDecision = ReturnType<typeof resolveBoxDecision> | { readonly kind: "off" };
/** @approved The Decision Model selection Box `id`'s `decide` asks, resolved now: only a digesting Box has one. */
export const resolveDecisionOf = (database: Database, id: BoxId): BoxDecision => isDigestBox(id) ? resolveBoxDecision(database, id) : { kind: "off" };

/** @approved Every host service for Box `id`, sending its requests through `fetch` and aborting with `signal`. `decide` asks `decision`, resolved once, so a selection changed while the Box runs never splits one Generation or digest across two models. */
export const boxServices = (database: Database, fetch: ModelFetch | undefined, signal: AbortSignal) => (id: BoxId, decision = resolveDecisionOf(database, id)): BoxContext<keyof BoxServices> => ({
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
		const { label } = boxDescriptor(id);
		if (decision.kind === "off") throw new Error(`Choose a ${label} Decision Model in Connection Settings.`);
		if (decision.kind === "unavailable") throw new Error(`${decision.reason} Check the ${label} Decision Model in Connection Settings.`);
		const { request, fits } = decisionRequest(decision.decision, state, questions);
		if (!fits) throw new Error(`The state sent to the ${label} Decision Model exceeds its token limit.`);
		return requestDecisions({ request, questions, selection: decision.decision, fetch, signal });
	},
	embed: (texts, configuration, options) => embedTexts(database, texts, configuration, { ...options, fetch, signal }),
});
