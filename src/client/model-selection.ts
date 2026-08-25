export interface ModelSelectionInput {
	readonly query: string;
	readonly discoveryCatalog: readonly string[];
	readonly pinnedModels: readonly string[];
}

// Opening the combobox is intentionally a small curated view. Once the user
// types, the complete advisory catalog becomes searchable without turning it
// into an allowlist; pinned IDs absent from discovery remain available too.
export function modelSuggestions(input: ModelSelectionInput): string[] {
	const query = input.query.trim().toLocaleLowerCase();
	if (query.length === 0) return unique(input.pinnedModels);
	const catalog = input.discoveryCatalog.filter((model) =>
		model.toLocaleLowerCase().includes(query),
	);
	const pinnedOnly = input.pinnedModels.filter(
		(model) => !input.discoveryCatalog.includes(model) && model.toLocaleLowerCase().includes(query),
	);
	const matches = unique([...catalog, ...pinnedOnly]);
	return matches.length > 0 ? matches : [input.query.trim()];
}

export function commitModelId(value: string): string | null {
	const modelId = value.trim();
	return modelId.length === 0 ? null : modelId;
}

export function togglePinnedModel(
	pinnedModels: readonly string[],
	modelId: string,
	): string[] {
	const normalized = commitModelId(modelId);
	if (normalized === null) return [...pinnedModels];
	const existing = pinnedModels.indexOf(normalized);
	if (existing !== -1) return pinnedModels.filter((_, index) => index !== existing);
	return [...pinnedModels, normalized];
}

function unique(values: readonly string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		if (seen.has(value)) return false;
		seen.add(value);
		return true;
	});
}
