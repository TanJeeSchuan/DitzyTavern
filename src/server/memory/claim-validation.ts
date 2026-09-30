export const hasValidMemoryClaimText = (claim: string, attribution: string) =>
	claim.trim().length > 0 && attribution.trim().length > 0 && claim.length + attribution.length <= 1024;

export const hasValidMemoryPeople = (people: readonly string[]) =>
	!people.some((person) => person.trim().length === 0) && new Set(people).size === people.length;
