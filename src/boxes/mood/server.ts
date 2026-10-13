import { moodNames, moods, NOT_CLEAR, type Mood, type MoodRecord } from "./shared";
import type { Box } from "../../box-sdk/server";

export const moodBox = {
	records: {
		initial: null,
		fold: (state, { mood }) => mood === NOT_CLEAR ? state : mood,
		digest: {
			window: 1,
			run: async ({ passage, preceding }, ctx) => {
				const answers = await ctx.decide({ passage, preceding }, {
					mood: {
						type: "choice",
						instructions: { question: "What mood does `passage` leave the scene in?" },
						criteria: { [NOT_CLEAR]: "`passage` does not settle a mood", ...Object.fromEntries(moodNames.map((mood) => [mood, moods[mood].criteria])) },
					},
				});
				const answer = answers.get("mood");
				const mood = answer?.type === "choice" ? ([NOT_CLEAR, ...moodNames] as const).find((option) => option === answer.choice) : undefined;
				if (mood === undefined) throw new Error("The Decision Model returned no mood.");
				return { mood };
			},
		},
	},
	advance: { run: async ({ state }) => ({ items: state === null ? [] : [{ text: state, priority: 100, pinned: true }] }) },
	status: (_setup, state) => state === null ? null : `${moods[state].emote} ${state}`,
} satisfies Box<undefined, undefined, never, never, MoodRecord, Mood | null>;
