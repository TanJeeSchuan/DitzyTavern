import type { DecisionAnswer } from "@/box-sdk/shared";

const NOT_CLEAR = "not clear";
const moodNames = ["calm", "warm", "playful", "tense", "sad", "eerie"] as const;
type Mood = typeof moodNames[number];

// @approved
//  The emote the dock shows for each mood, and the criteria the Decision
//  Model reads it by. `descriptor.json` lists the same moods as the record's
//  options.
const moods = {
	calm: { emote: "😌", criteria: "Quiet, settled or at ease" },
	warm: { emote: "🥰", criteria: "Affectionate, tender or comforting" },
	playful: { emote: "😜", criteria: "Teasing, light-hearted or fun" },
	tense: { emote: "😬", criteria: "Strained, anxious or on edge" },
	sad: { emote: "😢", criteria: "Grieving, lonely or downcast" },
	eerie: { emote: "👻", criteria: "Unsettling, uncanny or ominous" },
} as const satisfies Record<Mood, { emote: string; criteria: string }>;
/** @approved One passage's answer; "not clear" keeps the mood the scene already had. */
type MoodRecord = { mood: Mood | typeof NOT_CLEAR };
type Passage = { messageId: number; speaker: string | null; authorId: number | null; content: string };
type Window = { passage: Passage; preceding: Passage[] };
type Question = { type: "choice"; instructions: { question: string }; criteria: Record<string, string> };
type Decide = (state: Window, questions: { mood: Question }) => Promise<[string, DecisionAnswer][]>;

export default {
	records: {
		initial: null,
		fold: (state: Mood | null, { mood }: MoodRecord) => mood === NOT_CLEAR ? state : mood,
		digest: {
			window: 1,
			async run({ passage, preceding }: Window, { decide }: { decide: Decide }): Promise<MoodRecord> {
				const answers = new Map(await decide({ passage, preceding }, {
					mood: {
						type: "choice",
						instructions: { question: "What mood does `passage` leave the scene in?" },
						criteria: { [NOT_CLEAR]: "`passage` does not settle a mood", ...Object.fromEntries(moodNames.map((mood) => [mood, moods[mood].criteria])) },
					},
				}));
				const answer = answers.get("mood");
				const mood = answer?.type === "choice" ? ([NOT_CLEAR, ...moodNames] as const).find((option) => option === answer.choice) : undefined;
				if (mood === undefined) throw new Error("The Decision Model returned no mood.");
				return { mood };
			},
		},
	},
	advance: { run: async ({ state }: { state: Mood | null }) => ({ items: state === null ? [] : [{ text: state, priority: 100, pinned: true }] }) },
	status: (_setup: undefined, state: Mood | null) => state === null ? null : `${moods[state].emote} ${state}`,
};
