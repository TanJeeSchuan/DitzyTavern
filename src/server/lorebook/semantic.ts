import type { Database } from "bun:sqlite";
import type { ModelFetch } from "../model-client";
import { createTypesafeSettingsModule, requestJev, type TypesafeSettingsModuleOptions } from "../typesafe";
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
	const questions = Object.fromEntries(triggers.map((trigger, index) => [`trigger_${index}`, {
		type: "noul",
		instructions: { situation: trigger, question: "Does `situation` happen or get discussed in `scene`?" },
	}]));
	try {
		const answers = await requestJev({
			request: JSON.stringify({ model: settings.jevModel, state: { scene: input.messages.map((message) => message.content) }, questions }),
			questionIds: Object.keys(questions),
			credential: settings.credential,
			fetch: input.fetch,
		});
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
