import { type PortraitImage } from "@/box-sdk/client";
import { applyMemoryPeople } from "./shared";
import { type MemoryCandidateJudgment, type ConversationMemories } from "./contract";

export type MemorySource = ConversationMemories["sources"][number];
export type MemoryClaim = MemoryCandidateJudgment;
export type MemoryPathEntry = ConversationMemories["path"][number];

/** @approved The read as the panel shows it: each claim's people under the Chat's identities and label merges, which stored claims never take. */
export const labelledMemories = (memories: ConversationMemories): ConversationMemories => ({
	...memories,
	sources: memories.sources.map((source) => source.claims === null ? source : {
		...source,
		claims: source.claims.map((claim) => ({ ...claim, people: applyMemoryPeople(claim.people, memories.cast, memories.identities, memories.labelMerges) })),
	}),
});

/** @approved One claim as the Memories panel lists it, with its source and its index among that source's claims. */
export type MemoryEntry = { claim: MemoryClaim; source: MemorySource; index: number };

export type MemoryCastMember = { id: number; name: string; portrait?: PortraitImage; names: string[] };

/** @approved Claims grouped under the labels of the people they name; `key` is the group's identity for React. */
export type PeopleGroup = { key: string; people: string[]; entries: MemoryEntry[] };

/** @approved Each Message's position on the Memory path, so the panel lists newer Messages first. */
export const memoryPositions = (path: readonly MemoryPathEntry[]): Map<number, number> =>
	new Map(path.map((entry, index) => [entry.messageId, index]));

/** @approved The Chat's Cast widened with the labels Memories use for each Participant. */
export const memoryCastMembers = (
	cast: readonly { id: number; name: string; portrait?: PortraitImage }[],
	memories: ConversationMemories | null,
): MemoryCastMember[] => cast.map((participant) => ({
	...participant,
	names: memories?.cast.find(({ id }) => id === participant.id)?.names ?? [],
}));

/** @approved
 * The claims the panel lists for `sources`: those of the focused Message only,
 * filtered by `search` over the claim, its attribution, and its people, ordered
 * by the source's position on the Memory path with the newest Message first.
 */
export const memoryEntries = (
	sources: readonly MemorySource[],
	position: ReadonlyMap<number, number>,
	focus: number | null,
	search: string,
): MemoryEntry[] => {
	const needle = search.trim().toLowerCase();
	return sources
		.filter((source) => focus === null || source.messageId === focus)
		.sort((a, b) => (position.get(b.messageId) ?? -1) - (position.get(a.messageId) ?? -1))
		.flatMap((source) => (source.claims ?? []).flatMap((claim, index) =>
			needle === "" || [claim.claim, claim.attribution, ...claim.people].some((text) => text.toLowerCase().includes(needle))
				? [{ claim, source, index }]
				: []
		));
};

/** @approved
 * Groups claims that name the same people, ordering each group's people by
 * their Cast position and the groups by their first known person, then by the
 * number of people, entry count, and group key.
 */
export const groupEntriesByPeople = (entries: readonly MemoryEntry[], cast: readonly MemoryCastMember[]): PeopleGroup[] => {
	const rank = (name: string) => cast.findIndex((participant) => participant.names.includes(name)) >>> 0;
	const groups = new Map<string, PeopleGroup>();
	for (const entry of entries) {
		const people = [...new Set(entry.claim.people)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
		const key = JSON.stringify(people);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, { key, people, entries: [entry] });
		else group.entries.push(entry);
	}
	const firstRank = ({ people }: PeopleGroup) => {
		const first = people[0];
		return first === undefined ? Infinity : rank(first);
	};
	return [...groups.values()].sort((a, b) =>
		firstRank(a) - firstRank(b)
		|| a.people.length - b.people.length
		|| b.entries.length - a.entries.length
		|| a.key.localeCompare(b.key)
	);
};
