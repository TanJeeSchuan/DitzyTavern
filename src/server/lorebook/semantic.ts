import type { Database } from "bun:sqlite";
import type { ModelFetch } from "../model-client";
import { splitByTokens } from "tokenx";
import { decisionRequest, packDecisions, requestDecisions, tryResolveDecisionSelection, type DecisionSelectionResolution } from "../decision-model";
import { createSemanticTriggerSettingsModule } from "./semantic-settings";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import { tokenxEstimator } from "../prompt-compiler";
import type { LoreScanMessage, LoreSemanticEvaluation } from "./matching";
import type { Lorebook } from "../../shared/contract/lorebook";
import type { DecisionSelection } from "../../shared/contract/decision-model";

export type SemanticSettingsSnapshot = DecisionSelection & DecisionSelectionResolution & {
	readonly triggerThreshold: number;
};

export const captureSemanticSettings = (database: Database, options?: ConnectionSettingsModuleOptions): SemanticSettingsSnapshot => {
	const settings = createSemanticTriggerSettingsModule(database).get();
	return { ...settings, ...tryResolveDecisionSelection(database, settings, options) };
};

type SceneFits = (scene: readonly string[]) => boolean;

const splitMessage = (sceneFits: SceneFits, text: string): string[] => {
	if (sceneFits([text])) return [text];
	for (let size = tokenxEstimator(text); size > 0; size = Math.floor(size / 2)) {
		const pieces = splitByTokens(text, size);
		if (pieces.every((piece) => sceneFits([piece]))) return pieces;
	}
	throw new Error("A scene character exceeds the Decision Model state token limit.");
};

const sceneChunks = (sceneFits: SceneFits, messages: readonly LoreScanMessage[]): string[][] => {
	const chunks: string[][] = [[]];
	for (const piece of messages.flatMap((message) => splitMessage(sceneFits, message.content))) {
		const current = chunks.at(-1)!;
		if (sceneFits([...current, piece])) current.push(piece);
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
	if (triggers.length === 0) return { available: true, threshold: settings.triggerThreshold, matches: [] };
	switch (settings.kind) {
		case "off": return { available: false, threshold: settings.triggerThreshold, fallbackReason: "Semantic Triggers are turned off. Choose a Decision Model under Connections." };
		case "unavailable": return { available: false, threshold: settings.triggerThreshold, fallbackReason: settings.reason };
		case "ready": break;
	}
	const triggerItems = triggers.map((trigger, index) => ({ id: `trigger_${index}`, question: triggerQuestion(trigger) }));
	const selection = settings.decision;
	const measured = triggerItems.map((item) => {
		const text = JSON.stringify(item.question);
		return { ...item, tokens: tokenxEstimator(text), bytes: new TextEncoder().encode(JSON.stringify({ [item.id]: item.question })).byteLength };
	});
	const largestByTokens = measured.reduce((largest, item) => item.tokens > largest.tokens ? item : largest);
	const largestByBytes = measured.reduce((largest, item) => item.bytes > largest.bytes ? item : largest);
	const sizingItems = [...new Set([largestByTokens, largestByBytes])];
	const sceneFits: SceneFits = (scene) => sizingItems.every(({ id, question }) => decisionRequest(selection, { scene }, { [id]: question }).fits);
	const requestsFor = (scene: readonly string[]) => packDecisions(triggerItems, (batch) => decisionRequest(selection, { scene }, Object.fromEntries(batch.map(({ id, question }) => [id, question]))), "A Semantic Trigger exceeds the bounded Decision Model request.");
	const controller = new AbortController();
	const signal = input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]);
	try {
		const scores = new Map<string, number>();
		const requests = sceneChunks(sceneFits, input.messages).flatMap(requestsFor);
		for (let start = 0; start < requests.length; start += 2) {
			const responses = await Promise.all(requests.slice(start, start + 2).map(({ request, questions }) => requestDecisions({ request, questions, selection, fetch: input.fetch, signal })));
			for (const answers of responses) for (const [id, answer] of answers) {
				if (answer.type !== "noul") throw new Error("Decision Model returned a malformed Semantic Trigger answer.");
				scores.set(id, Math.max(scores.get(id) ?? 0, answer.noul));
			}
		}
		const matches = triggers.map((trigger, index) => ({ trigger, score: scores.get(`trigger_${index}`)! }));
		return { available: true, threshold: settings.triggerThreshold, matches };
	} catch (error) {
		controller.abort();
		input.signal?.throwIfAborted();
		return { available: false, threshold: settings.triggerThreshold, fallbackReason: error instanceof Error ? error.message : "Semantic matching was unavailable." };
	}
}
