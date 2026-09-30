import type { Database } from "bun:sqlite";
import type { ModelFetch } from "../model-client";
import { splitByTokens } from "tokenx";
import { createTypesafeSettingsModule, jevRequest, packJev, requestJev, type TypesafeSettingsModuleOptions } from "../typesafe";
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

const sceneFits = (model: string, scene: readonly string[]) => jevRequest(model, { scene }, {}).fits;

const splitMessage = (model: string, text: string): string[] => {
	for (let size = tokenxEstimator(text); size > 0; size = Math.floor(size / 2)) {
		const pieces = splitByTokens(text, size);
		if (pieces.every((piece) => sceneFits(model, [piece]))) return pieces;
	}
	throw new Error("A scene character exceeds Jev's state token limit.");
};

const sceneChunks = (model: string, messages: readonly LoreScanMessage[]): string[][] => {
	const chunks: string[][] = [[]];
	for (const piece of messages.flatMap((message) => splitMessage(model, message.content))) {
		const current = chunks.at(-1)!;
		if (sceneFits(model, [...current, piece])) current.push(piece);
		else chunks.push([piece]);
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
	const triggerItems = triggers.map((trigger, index) => ({ id: `trigger_${index}`, question: triggerQuestion(trigger) }));
	const requestsFor = (scene: readonly string[]) => packJev(triggerItems, (batch) => jevRequest(settings.jevModel, { scene }, Object.fromEntries(batch.map(({ id, question }) => [id, question]))), "A Semantic Trigger exceeds the bounded Jev request.");
	const credential = settings.credential;
	try {
		const scores = new Map<string, number>();
		for (const { request } of sceneChunks(settings.jevModel, input.messages).flatMap(requestsFor)) for (const [id, answer] of await requestJev({ request, credential, fetch: input.fetch })) {
			if (answer.type !== "noul") throw new Error("Typesafe Jev returned a malformed Semantic Trigger answer.");
			scores.set(id, Math.max(scores.get(id) ?? 0, answer.noul));
		}
		const matches = triggers.map((trigger, index) => ({ trigger, score: scores.get(`trigger_${index}`)! }));
		return { available: true, threshold: settings.threshold, matches };
	} catch (error) {
		return { available: false, threshold: settings.threshold, fallbackReason: error instanceof Error ? error.message : "Semantic matching was unavailable." };
	}
}
