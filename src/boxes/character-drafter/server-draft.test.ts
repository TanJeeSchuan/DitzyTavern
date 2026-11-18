import { expect, test } from "bun:test";
import { emptyPromptChannels } from "../../shared/definition";
import type { CharacterDraft, DraftMessages } from "./contract";
import { draftRefusal } from "./server-draft";

const messages: DraftMessages = [
	{ id: 7, index: 0, author: "Maren", authorParticipantId: 1, text: "Maren pours. \"Another round, then.\"" },
	{ id: 9, index: 1, author: "Bob", authorParticipantId: 2, text: "\"Mind the glass,\" Bob says. \"It was my mother's.\"" },
];
const draft = (quotes: CharacterDraft["quotes"], exampleDialogue: string): CharacterDraft =>
	({ name: "Bartholomew Crane", prompt: { ...emptyPromptChannels(), exampleDialogue }, quotes });

test("a draft whose example dialogue is made of quotes copied from the path is accepted", () => {
	const quotes = [{ messageId: 9, text: "\"Mind the glass,\"" }, { messageId: 9, text: "\"It was my mother's.\"" }];
	expect(draftRefusal(messages, draft(quotes, "\"Mind the glass,\"\n\n  \"It was my mother's.\"  "))).toBeUndefined();
});

test("a quote that is not word for word in its Message is refused", () => {
	expect(draftRefusal(messages, draft([{ messageId: 9, text: "\"Mind the glasses,\"" }], ""))).toBe("The quote \"\"Mind the glasses,\"\" is not in Message 9 word for word.");
});

test("a quote copied from another Message than the one it names is refused", () => {
	expect(draftRefusal(messages, draft([{ messageId: 7, text: "\"Mind the glass,\"" }], ""))).toBe("The quote \"\"Mind the glass,\"\" is not in Message 7 word for word.");
});

test("a quote naming a Message off the path is refused", () => {
	expect(draftRefusal(messages, draft([{ messageId: 8, text: "Another round" }], ""))).toBe("Message 8 is not on the story's path.");
});

test("an example dialogue line that is not one of the quotes is refused", () => {
	const refusal = draftRefusal(messages, draft([{ messageId: 9, text: "\"Mind the glass,\"" }], "\"Mind the glass,\"\n\"I never liked that glass.\""));
	expect(refusal).toBe("The exampleDialogue line \"\"I never liked that glass.\"\" is not one of the quotes; every line must be a quote's text.");
});
