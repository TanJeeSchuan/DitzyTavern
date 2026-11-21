import { createAttemptEnvironment, type AttemptEnvironmentInput } from "../prompt-macro-engine";

export const testMacroAttempt = (overrides: Partial<AttemptEnvironmentInput> = {}) => createAttemptEnvironment({
	self: "Writer",
	other: "Maren",
	conversationId: 42,
	promptPresetId: 7,
	now: new Date("2026-01-02T15:04:05Z"),
	timeZone: "UTC",
	locale: "en-US",
	random: () => 0,
	...overrides,
});
