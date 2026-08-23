// Public contract of the deep Character Library seam. The module owns
// Character lifecycle, Definitions, revisions, and ordering; callers see
// only these types plus command execution outcomes.

export interface CharacterPrompt {
	readonly systemInstruction: string;
	readonly identity: string;
	readonly scenario: string;
	readonly exampleDialogue: string;
	readonly postHistoryInstruction: string;
}

// A complete reusable identity. Openings are ordered, exact, nonblank
// text entries; an empty list is valid.
export interface CharacterDefinition {
	readonly name: string;
	readonly prompt: CharacterPrompt;
	readonly openings: readonly string[];
}

// Library list entry without Definition payload.
export interface CharacterSummary {
	readonly id: number;
	readonly name: string;
	readonly revision: number;
	readonly pinned: boolean;
}

// Full authoritative state of one Character.
export interface CharacterSnapshot {
	readonly id: number;
	readonly name: string;
	readonly revision: number;
	readonly pinned: boolean;
	readonly prompt: CharacterPrompt;
	readonly openings: readonly string[];
}

export type CharacterLibraryCommand =
	| { readonly type: "create"; readonly definition: CharacterDefinition }
	| {
			readonly type: "rename";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly name: string;
	  }
	| {
			readonly type: "replace-prompt";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly prompt: CharacterPrompt;
	  }
	| {
			readonly type: "replace-openings";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly openings: readonly string[];
	  }
	| {
			readonly type: "set-pinned";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly pinned: boolean;
	  };

export interface CharacterLibraryModule {
	list(): CharacterSummary[];
	get(characterId: number): CharacterSnapshot | undefined;
	execute(command: CharacterLibraryCommand): CharacterSnapshot;
}
