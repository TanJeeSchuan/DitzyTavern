import { phoneMove, type PhoneMove } from "../../shared/contract/phone";
import { renderPhoneText, type PhoneNames } from "../../shared/phone";
import type { Box } from "./contract";

// @approved
//  Texts live in the prose as `<sms>` markup, which the prompt keeps and the
//  story's lens lifts into the Phone. Without another Cast member there is
//  nobody to text, so the Phone says nothing.
export const phoneBox = {
	moves: { schema: phoneMove, render: ({ to, text }, author) => renderPhoneText({ from: author, to, text }) },
	advance: {
		run: async ({ dependencies: { human, contacts } }) => {
			const [contact] = contacts;
			if (contact === undefined) return { items: [] };
			const example = renderPhoneText({ from: contact, to: human, text: "message" });
			const text = `${human} has a phone and can text ${contacts.join(", ")}. Write each text on its own line as ${example}, with the sender in from and the recipient in to. Narrate around a text; never restate it in the prose.`;
			return { items: [{ text, priority: 0, pinned: true }] };
		},
	},
} satisfies Box<undefined, PhoneNames, never, never, never, undefined, PhoneMove>;
