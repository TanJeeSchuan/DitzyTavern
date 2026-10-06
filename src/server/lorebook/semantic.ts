import type { Database } from "bun:sqlite";
import type { ModelFetch } from "../model-client";
import { splitByTokens } from "tokenx";
import { decisionRequest, packDecisions, requestDecisions, resolveDecisionSelection, type ResolvedDecisionModel } from "../decision-model";
import { createSemanticTriggerSettingsModule } from "./semantic-settings";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import { tokenxEstimator } from "../prompt-compiler";
import type { LoreScanMessage, LoreSemanticEvaluation } from "./matching";
import type { Lorebook } from "../../shared/contract/lorebook";
import type { DecisionSelection } from "../../shared/contract/decision-model";

export interface SemanticSettingsSnapshot extends DecisionSelection {
	readonly threshold: number;
	readonly connection: ResolvedDecisionModel | null;
	readonly unavailableReason?: string;
}

export const captureSemanticSettings = (database: Database, options?: ConnectionSettingsModuleOptions): SemanticSettingsSnapshot => {
	const settings = createSemanticTriggerSettingsModule(database).get();
	try { return { ...settings, threshold: settings.triggerThreshold, connection: resolveDecisionSelection(database, settings, options) }; }
	catch (error) { return { ...settings, threshold: settings.triggerThreshold, connection: null, unavailableReason: error instanceof Error ? error.message : "The Decision Model is unavailable." }; }
};

const sceneFits = (selection: ResolvedDecisionModel, scene: readonly string[]) => decisionRequest(selection, { scene }, {}).fits;

const splitMessage = (selection: ResolvedDecisionModel, text: string): string[] => {
	if (sceneFits(selection, [text])) return [text];
	for (let size = tokenxEstimator(text); size > 0; size = Math.floor(size / 2)) {
		const pieces = splitByTokens(text, size);
		if (pieces.every((piece) => sceneFits(selection, [piece]))) return pieces;
	}
	throw new Error("A scene character exceeds the Decision Model state token limit.");
};

const sceneChunks = (selection: ResolvedDecisionModel, messages: readonly LoreScanMessage[]): string[][] => {
	const chunks: string[][] = [[]];
	for (const piece of messages.flatMap((message) => splitMessage(selection, message.content))) {
		const current = chunks.at(-1)!;
		if (sceneFits(selection, [...current, piece])) current.push(piece);
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
	readonly signal?: AbortSignal;
}): Promise<LoreSemanticEvaluation> {
	const { settings } = input;
	const triggers = [...new Set(input.entries.filter((entry) => entry.enabled).flatMap((entry) => entry.semanticTriggers).filter((text) => text.length > 0))];
	if (triggers.length === 0) return { available: true, threshold: settings.threshold, matches: [] };
	if (settings.connection === null) return { available: false, threshold: settings.threshold, fallbackReason: settings.unavailableReason ?? "Semantic Triggers are turned off in Semantic Triggers under Connections." };
	const triggerItems = triggers.map((trigger, index) => ({ id: `trigger_${index}`, question: triggerQuestion(trigger) }));
	const selection = settings.connection;
	const requestsFor = (scene: readonly string[]) => packDecisions(triggerItems, (batch) => decisionRequest(selection, { scene }, Object.fromEntries(batch.map(({ id, question }) => [id, question]))), "A Semantic Trigger exceeds the bounded Decision Model request.");
	const controller = new AbortController();
	const signal = input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]);
	try {
		const scores = new Map<string, number>();
		const requests = sceneChunks(selection, input.messages).flatMap(requestsFor);
		for (let start = 0; start < requests.length; start += 2) {
			const responses = await Promise.all(requests.slice(start, start + 2).map(({ request }) => requestDecisions({ request, selection, fetch: input.fetch, signal })));
			for (const answers of responses) for (const [id, answer] of answers) {
				if (answer.type !== "noul") throw new Error("Decision Model returned a malformed Semantic Trigger answer.");
				scores.set(id, Math.max(scores.get(id) ?? 0, answer.noul));
			}
		}
		const matches = triggers.map((trigger, index) => ({ trigger, score: scores.get(`trigger_${index}`)! }));
		return { available: true, threshold: settings.threshold, matches };
	} catch (error) {
		controller.abort();
		input.signal?.throwIfAborted();
		return { available: false, threshold: settings.threshold, fallbackReason: error instanceof Error ? error.message : "Semantic matching was unavailable." };
	}
}
