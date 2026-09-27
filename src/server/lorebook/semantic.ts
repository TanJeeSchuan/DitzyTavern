import type { Database } from "bun:sqlite";
import type { ModelFetch } from "../model-client";
import { createTypesafeSettingsModule, JEV_STATE_TOKEN_LIMIT, jevRequest, requestJev, type TypesafeSettingsModuleOptions } from "../typesafe";
import { tokenxEstimator } from "../prompt-compiler";
import type { LoreScanMessage, LoreSemanticEvaluation } from "./matching";
import type { Lorebook } from "../../shared/contract/lorebook";
import type { JevAnswer, TypesafeSettingsPayload } from "../../shared/contract/typesafe";

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

const boundedScene = (messages: readonly LoreScanMessage[]): string[] => {
	const scene = messages.map((message) => message.content);
	const fits = () => tokenxEstimator(JSON.stringify({ scene })) <= JEV_STATE_TOKEN_LIMIT;
	while (scene.length > 1 && !fits()) scene.shift();
	while (scene.length === 1 && !fits()) scene[0] = scene[0]!.slice(Math.ceil(scene[0]!.length / 10));
	return scene;
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
	if (settings.mode === "off") return { available: false, threshold: settings.threshold, fallbackReason: "Semantic Triggers are turned off in Model Settings." };
	if (settings.credential === null) return { available: false, threshold: settings.threshold, fallbackReason: "Configure the Typesafe credential in Model Settings to match Semantic Triggers." };
	const state = { scene: boundedScene(input.messages) };
	const requestFor = (indexes: readonly number[]) => jevRequest(settings.jevModel, state, Object.fromEntries(indexes.map((index) => [`trigger_${index}`, triggerQuestion(triggers[index]!)])));
	const batches: number[][] = [[]];
	for (const index of triggers.keys()) {
		const current = batches.at(-1)!;
		if (current.length > 0 && !requestFor([...current, index]).fits) batches.push([index]);
		else current.push(index);
	}
	const credential = settings.credential;
	try {
		const answers = (await Promise.all(batches.map((batch) => requestJev({ ...requestFor(batch), credential, fetch: input.fetch }))))
			.reduce<Readonly<Record<string, JevAnswer>>>((all, part) => ({ ...all, ...part }), {});
		const matches = triggers.map((trigger, index) => {
			const answer = answers[`trigger_${index}`]!;
			if (answer.type !== "noul") throw new Error("Typesafe Jev returned a malformed Semantic Trigger answer.");
			return { trigger, score: answer.noul };
		});
		return { available: true, threshold: settings.threshold, matches };
	} catch (error) {
		return { available: false, threshold: settings.threshold, fallbackReason: error instanceof Error ? error.message : "Semantic matching was unavailable." };
	}
}
