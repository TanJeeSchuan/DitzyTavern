import type { Database } from "bun:sqlite";
import type { ModelFetch } from "../model-client";
import { createTypesafeSettingsModule, JEV_STATE_TOKEN_LIMIT, jevRequest, requestJev, type TypesafeSettingsModuleOptions } from "../typesafe";
import { tokenxEstimator } from "../prompt-compiler";
import type { LoreScanMessage, LoreSemanticEvaluation } from "./matching";
import type { Lorebook } from "../../shared/contract/lorebook";
import type { TypesafeSettingsPayload } from "../../shared/contract/typesafe";

export interface SemanticSettingsSnapshot {
	readonly mode: TypesafeSettingsPayload["loreTriggerMode"];
	readonly threshold: number;
	readonly jevModel: string;
	readonly credential: string | null;
}

export const captureSemanticSettings = (database: Database, options?: TypesafeSettingsModuleOptions): SemanticSettingsSnapshot => {
	const typesafe = createTypesafeSettingsModule(database, options);
	const settings = typesafe.get();
	return {
		mode: settings.loreTriggerMode,
		threshold: settings.loreTriggerThreshold,
		jevModel: settings.jevModel,
		credential: settings.loreTriggerMode === "jev" ? typesafe.getCredential() : null,
	};
};

const sceneFits = (scene: readonly string[]) => tokenxEstimator(JSON.stringify({ scene })) <= JEV_STATE_TOKEN_LIMIT;

const sceneChunks = (messages: readonly LoreScanMessage[]): string[][] => {
	const chunks: string[][] = [[]];
	for (const message of messages) {
		let rest = message.content;
		while (rest.length > 0) {
			let size = rest.length;
			while (!sceneFits([rest.slice(0, size)])) size = Math.floor(size * 0.9);
			const piece = rest.slice(0, size);
			rest = rest.slice(size);
			const current = chunks.at(-1)!;
			if (sceneFits([...current, piece])) current.push(piece);
			else chunks.push([piece]);
		}
	}
	return chunks;
};

const triggerQuestion = (trigger: string) => ({
	type: "noul",
	instructions: { situation: trigger, question: "Does `situation` happen or get discussed in `scene`?" },
});

export async function evaluateSemanticLore(input: {
	readonly entries: readonly Pick<Lorebook["entries"][number], "enabled" | "semanticTriggers">[];
	readonly messages: readonly LoreScanMessage[];
	readonly settings: SemanticSettingsSnapshot;
	readonly fetch?: ModelFetch;
}): Promise<LoreSemanticEvaluation> {
	const { settings } = input;
	const triggers = [...new Set(input.entries.filter((entry) => entry.enabled).flatMap((entry) => entry.semanticTriggers).filter((text) => text.length > 0))];
	if (triggers.length === 0) return { available: true, threshold: settings.threshold, matches: [] };
	if (settings.mode === "off") return { available: false, threshold: settings.threshold, fallbackReason: "Semantic Triggers are turned off in Typesafe Jev under Connections." };
	if (settings.credential === null) return { available: false, threshold: settings.threshold, fallbackReason: "Configure the Typesafe credential in Connections to match Semantic Triggers." };
	const requestsFor = (scene: readonly string[]) => {
		const requestFor = (indexes: readonly number[]) => jevRequest(settings.jevModel, { scene }, Object.fromEntries(indexes.map((index) => [`trigger_${index}`, triggerQuestion(triggers[index]!)])));
		const batches: number[][] = [[]];
		for (const index of triggers.keys()) {
			const current = batches.at(-1)!;
			if (current.length > 0 && !requestFor([...current, index]).fits) batches.push([index]);
			else current.push(index);
		}
		return batches.map(requestFor);
	};
	const credential = settings.credential;
	try {
		const scores = new Map<string, number>();
		for (const request of sceneChunks(input.messages).flatMap(requestsFor)) for (const [id, answer] of Object.entries(await requestJev({ ...request, credential, fetch: input.fetch }))) {
			if (answer.type !== "noul") throw new Error("Typesafe Jev returned a malformed Semantic Trigger answer.");
			scores.set(id, Math.max(scores.get(id) ?? 0, answer.noul));
		}
		const matches = triggers.map((trigger, index) => ({ trigger, score: scores.get(`trigger_${index}`)! }));
		return { available: true, threshold: settings.threshold, matches };
	} catch (error) {
		return { available: false, threshold: settings.threshold, fallbackReason: error instanceof Error ? error.message : "Semantic matching was unavailable." };
	}
}
