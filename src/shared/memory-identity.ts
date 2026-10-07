import type { MemoryIdentities, MemoryIdentity, MemoryLabelMerge } from "./contract/memory";

export const memoryIdentityLabel = (identity: MemoryIdentity | undefined) => identity?.kind === "excluded" ? "Not in the story" : identity?.kind === "plays" ? `Plays ${identity.person}` : "Themselves";

export const applyMemoryPeople = (people: readonly string[], cast: readonly { id: number; name: string }[], identities: MemoryIdentities, merges: readonly MemoryLabelMerge[]): string[] => {
	const rules = new Map(cast.flatMap(({ id, name }): [string, string | null][] => {
		const identity = identities[id];
		return identity?.kind === "excluded" ? [[name, null]] : identity?.kind === "plays" ? [[name, identity.person]] : [];
	}));
	for (const { id, name } of cast) if (identities[id]?.kind === "excluded") rules.set(name, null);
	const names = new Map(merges.map(({ from, to }) => [from, to]));
	return [...new Set(people.flatMap((person) => {
		const name = rules.has(person) ? person : names.get(person) ?? person;
		const identity = rules.get(name);
		if (identity === null) return [];
		const target = identity === undefined ? name : names.get(identity) ?? identity;
		return rules.get(target) === null ? [] : [target];
	}))];
};
