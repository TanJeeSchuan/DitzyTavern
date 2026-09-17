import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { embeddingCacheTable } from "../database/schema";
import { createEmbeddingSettingsModule } from "../embedding-settings";
import { requestEmbeddings, cosineSimilarity, type EmbeddingClientOptions } from "./embedding-client";
import { splitLoreSentences, type LoreScanMessage, type LoreSemanticEvaluation, type LoreSemanticMatch } from "./matching";
import type { Lorebook } from "../../shared/contract/lorebook";

export interface SemanticSource {
	readonly kind: "trigger" | "sentence";
	readonly text: string;
}

export interface SemanticEvaluationInput {
	readonly database: Database;
	readonly entries: readonly Lorebook["entries"][number][];
	readonly messages: readonly LoreScanMessage[];
	readonly settings?: ReturnType<typeof createEmbeddingSettingsModule>;
	readonly fetch?: import("../model-client/types").ModelFetch;
}

type Db = ReturnType<typeof drizzle>;

const connect = (database: Database): Db => drizzle(database);

/** ==[HUMAN APPROVED]==
 * Performs one complete semantic pass for all entries in an attempt. Any transport or response
 * failure returns unavailable for the complete attempt; callers must then apply the approved
 * keyword-only policy rather than mixing semantic successes with fallback results.
 */
export async function evaluateSemanticLore(input: SemanticEvaluationInput): Promise<LoreSemanticEvaluation> {
	const settings = (input.settings ?? createEmbeddingSettingsModule(input.database)).get();
	// ==[HUMAN APPROVED]== Disabled entries never contribute activation work. In particular, a disabled
	// semantic-only entry must not force an embedding request (or turn an otherwise
	// keyword-only attempt into fallback mode).
	const triggers = [...new Set(input.entries.filter((entry) => entry.enabled).flatMap((entry) => entry.semanticTriggers).filter((text) => text.length > 0))];
	const sentences = input.messages.flatMap((message) => splitLoreSentences(message.content));
	if (triggers.length === 0) return { available: true, threshold: settings.threshold, matches: [] };
	if (settings.endpoint.length === 0 || settings.model.length === 0) {
		return { available: false, threshold: settings.threshold, fallbackReason: "Semantic matching is not configured." };
	}
	try {
		const credential = input.settings?.getCredential() ?? createEmbeddingSettingsModule(input.database).getCredential();
		const deadlineAt = Date.now() + settings.deadlineMs;
		const client: EmbeddingClientOptions = {
			endpoint: settings.endpoint,
			model: settings.model,
			credential,
			timeoutMs: settings.deadlineMs,
			fetch: input.fetch,
		};
		const triggerVectors = await vectorsFor(input.database, "trigger", triggers, client, deadlineAt);
		const sentenceVectors = await vectorsFor(input.database, "sentence", sentences, client, deadlineAt);
		// ==[HUMAN APPROVED]== A provider can return individually well-shaped vectors with different
		// dimensions for the two batches.  Treat that as an unusable complete
		// result instead of turning every cross-dimension comparison into a
		// misleading zero score.
		const dimensions = triggerVectors[0]?.length ?? sentenceVectors[0]?.length ?? 0;
		if (dimensions === 0 || triggerVectors.some((vector) => vector.length !== dimensions) || sentenceVectors.some((vector) => vector.length !== dimensions)) {
			throw new Error("The embedding endpoint returned vectors with incompatible dimensions.");
		}
		const matches: LoreSemanticMatch[] = [];
		for (let triggerIndex = 0; triggerIndex < triggers.length; triggerIndex += 1) {
			const trigger = triggers[triggerIndex];
			const triggerVector = triggerVectors[triggerIndex];
			if (trigger === undefined || triggerVector === undefined) continue;
			let strongestScore = -1;
			let strongestSentence = "";
			for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
				const sentence = sentences[sentenceIndex];
				const sentenceVector = sentenceVectors[sentenceIndex];
				if (sentence === undefined || sentenceVector === undefined) continue;
				const score = cosineSimilarity(triggerVector, sentenceVector);
				if (score > strongestScore) { strongestScore = score; strongestSentence = sentence; }
			}
			if (strongestScore >= 0) matches.push({ trigger, score: strongestScore, sentence: strongestSentence });
		}
		return { available: true, threshold: settings.threshold, matches };
	} catch (error) {
		return {
			available: false,
			threshold: settings.threshold,
			fallbackReason: error instanceof Error ? error.message : "Semantic matching was unavailable.",
		};
	}
}

async function vectorsFor(
	database: Database,
	kind: SemanticSource["kind"],
	texts: readonly string[],
	client: EmbeddingClientOptions,
	deadlineAt: number,
): Promise<readonly (readonly number[])[]> {
	if (texts.length === 0) return [];
	const db = connect(database);
	const vectors: Array<readonly number[] | undefined> = Array.from({ length: texts.length });
	const missing: string[] = [];
	const missingIndexes: number[] = [];
	for (let index = 0; index < texts.length; index += 1) {
		const text = texts[index];
		if (text === undefined) continue;
		const row = db.select({ vector: embeddingCacheTable.vector_json })
			.from(embeddingCacheTable)
			.where(and(
				eq(embeddingCacheTable.endpoint, client.endpoint),
				eq(embeddingCacheTable.model, client.model),
				eq(embeddingCacheTable.source_kind, kind),
				eq(embeddingCacheTable.source_text, text),
			)).get();
		if (row === undefined) { missing.push(text); missingIndexes.push(index); continue; }
		try {
			// ==[HUMAN APPROVED]== SAFETY: the cache writer stores JSON-encoded finite vectors; isVector validates the decoded value.
			const parsed = JSON.parse(row.vector) as JsonValue;
			if (!isVector(parsed)) throw new Error("cached vector invalid");
			vectors[index] = parsed;
		} catch {
			db.delete(embeddingCacheTable).where(and(
				eq(embeddingCacheTable.endpoint, client.endpoint),
				eq(embeddingCacheTable.model, client.model),
				eq(embeddingCacheTable.source_kind, kind),
				eq(embeddingCacheTable.source_text, text),
			)).run();
			missing.push(text);
			missingIndexes.push(index);
		}
	}
	if (missing.length > 0) {
		const timeoutMs = deadlineAt - Date.now();
		if (timeoutMs <= 0) throw new Error("The embedding evaluation deadline elapsed.");
		const fetched = await requestEmbeddings(missing, { ...client, timeoutMs });
		for (let index = 0; index < missing.length; index += 1) {
			const vector = fetched[index];
			const target = missingIndexes[index];
			const text = missing[index];
			if (vector === undefined || target === undefined || text === undefined || !isVector(vector)) throw new Error("The embedding endpoint returned an unusable vector set.");
			vectors[target] = vector;
			db.insert(embeddingCacheTable).values({
				endpoint: client.endpoint,
				model: client.model,
				source_kind: kind,
				source_text: text,
				vector_json: JSON.stringify(vector),
			}).onConflictDoUpdate({
				target: [embeddingCacheTable.endpoint, embeddingCacheTable.model, embeddingCacheTable.source_kind, embeddingCacheTable.source_text],
				set: { vector_json: JSON.stringify(vector) },
			}).run();
		}
	}
	if (vectors.some((vector) => vector === undefined)) throw new Error("The embedding vector set is incomplete.");
	// ==[HUMAN APPROVED]== SAFETY: every slot is assigned from cache or the complete provider response, and the guard above rejects gaps.
	return vectors as readonly (readonly number[])[];
}

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const isVector = (value: JsonValue): value is readonly number[] =>
	Array.isArray(value) && value.length > 0 && value.every(isFiniteNumber) && value.some((component) => component !== 0);

function isFiniteNumber(value: JsonValue): value is number {
	if (Object.prototype.toString.call(value) !== "[object Number]") return false;
	// ==[HUMAN APPROVED]== SAFETY: the number tag above narrows this JSON value to a number.
	return Number.isFinite(value as number);
}
