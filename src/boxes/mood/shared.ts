import { Type, type Static } from "@sinclair/typebox";

export const NOT_CLEAR = "not clear";
export const moodNames = ["calm", "warm", "playful", "tense", "sad", "eerie"] as const;
export type Mood = typeof moodNames[number];

// @approved
//  The emote the dock shows for each mood, and the criteria the Decision
//  Model reads it by.
export const moods = {
	calm: { emote: "😌", criteria: "Quiet, settled or at ease" },
	warm: { emote: "🥰", criteria: "Affectionate, tender or comforting" },
	playful: { emote: "😜", criteria: "Teasing, light-hearted or fun" },
	tense: { emote: "😬", criteria: "Strained, anxious or on edge" },
	sad: { emote: "😢", criteria: "Grieving, lonely or downcast" },
	eerie: { emote: "👻", criteria: "Unsettling, uncanny or ominous" },
} as const satisfies Record<Mood, { emote: string; criteria: string }>;

const option = <Name extends Mood>(mood: Name) => Type.Literal(mood, { title: `${moods[mood].emote} ${mood.charAt(0).toUpperCase()}${mood.slice(1)}` });

/** @approved One passage's answer; "not clear" keeps the mood the scene already had. */
export const moodRecord = Type.Object({
	mood: Type.Union([
		Type.Literal(NOT_CLEAR, { title: "❔ Not clear" }),
		option("calm"), option("warm"), option("playful"), option("tense"), option("sad"), option("eerie"),
	], { title: "Mood" }),
});
export type MoodRecord = Static<typeof moodRecord>;
