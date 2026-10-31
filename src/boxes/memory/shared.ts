import type { MemoryRecallCandidateRecord, MemoryIdentities, MemoryIdentity, MemoryLabelMerge } from "./contract";

export const renderMemoryClaim = (claim: { claim: string; attribution: string }): string =>
	`${claim.claim} (attribution: ${claim.attribution})`;

export const memoryIdentityLabel = (identity: MemoryIdentity | undefined) => identity?.kind === "excluded" ? "Not in the story" : identity?.kind === "plays" ? `Plays ${identity.person}` : "Themselves";

export const applyMemoryPeople = (people: readonly string[], cast: readonly { id: number; names: readonly string[] }[], identities: MemoryIdentities, merges: readonly MemoryLabelMerge[]): string[] => {
	const rules = new Map(cast.flatMap(({ id, names }): [string, string | null][] => {
		const identity = identities[id];
		return identity?.kind === "excluded" ? names.map((name) => [name, null]) : identity?.kind === "plays" ? names.map((name) => [name, identity.person]) : [];
	}));
	for (const { id, names } of cast) if (identities[id]?.kind === "excluded") for (const name of names) rules.set(name, null);
	const names = new Map(merges.map(({ from, to }) => [from, to]));
	return [...new Set(people.flatMap((person) => {
		const name = rules.has(person) ? person : names.get(person) ?? person;
		const identity = rules.get(name);
		if (identity === null) return [];
		const target = identity === undefined ? name : names.get(identity) ?? identity;
		return rules.get(target) === null ? [] : [target];
	}))];
};

export const compareMemoryCandidates = (left: MemoryRecallCandidateRecord, right: MemoryRecallCandidateRecord) =>
	(right.relevanceScore ?? -1) - (left.relevanceScore ?? -1) || right.sourcePosition - left.sourcePosition || left.identity.localeCompare(right.identity);
