import { and, eq, inArray, like, or } from "drizzle-orm";
import { messageVariantDataTable } from "../database/schema";
import { variantDataCodecs, type VariantDataName } from "../../shared/variant-data-codecs";
import type { GenerationProvenance } from "../../shared/generation-provenance";
import type { LoreActivationRecord } from "../../shared/contract/lore-activation";
import type { MemoryActivationRecord } from "../../shared/contract/memory-recall";
import type { MacroVariableWrite } from "../../shared/contract/macro-variable-write";
import type { ConversationDatabase } from "./internal";
import { loadVariantDataRows } from "./message-rows";

export interface VariantDataRecords {
	reasoning?: string;
	provenance?: GenerationProvenance | null;
	loreActivation?: LoreActivationRecord | null;
	memoryActivation?: MemoryActivationRecord | null;
	macroWrites?: { key: string; writes: MacroVariableWrite[] }[];
}

export function readVariantData(db: ConversationDatabase, variantIds: readonly number[], names: readonly (keyof VariantDataRecords)[]): Map<number, VariantDataRecords> {
	if (names.length === 0) return new Map();
	const conditions = names.map((name) => {
		const codec = variantDataCodecs[name];
		return and(eq(messageVariantDataTable.namespace, codec.namespace), name === "macroWrites"
			? like(messageVariantDataTable.key, `${variantDataCodecs.macroWrites.keyPrefix}%`) : inArray(messageVariantDataTable.key, [...codec.keys]));
	});
	const rows = loadVariantDataRows(db, variantIds, or(...conditions));
	const records = new Map<number, VariantDataRecords>();
	for (const [id, entries] of rows) {
		const record: VariantDataRecords = {};
		const find = (name: Exclude<VariantDataName, "macroWrites">) => {
			const codec = variantDataCodecs[name];
			return entries.find((entry) => entry.namespace === codec.namespace && entry.key === codec.key);
		};
		if (names.includes("reasoning")) { const entry = find("reasoning"); if (entry) record.reasoning = variantDataCodecs.reasoning.decode(entry.value); }
		if (names.includes("provenance")) record.provenance = variantDataCodecs.provenance.read(entries);
		if (names.includes("loreActivation")) { const entry = find("loreActivation"); if (entry) record.loreActivation = variantDataCodecs.loreActivation.decode(entry.value); }
		if (names.includes("memoryActivation")) { const entry = find("memoryActivation"); if (entry) record.memoryActivation = variantDataCodecs.memoryActivation.decode(entry.value); }
		if (names.includes("macroWrites")) record.macroWrites = entries.filter((entry) => entry.namespace === variantDataCodecs.macroWrites.namespace)
			.map((entry) => ({ key: entry.key, writes: variantDataCodecs.macroWrites.decodeOptional(entry.value) ?? [] }));
		records.set(id, record);
	}
	return records;
}
