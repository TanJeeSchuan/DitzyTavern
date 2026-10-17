import { describe, expect, test } from "bun:test";
import { describePhoneTexts, renderPhoneText, stripPhoneTexts } from "./shared";

const names = { human: "Kai", contacts: ["Elara", "Bram"] };
const strip = (text: string) => stripPhoneTexts(text, names);

describe("describePhoneTexts", () => {
	const text = (from: string, to: string) => ({ from, to, text: "hi" });
	test("one text names its sender and recipient, a run names its people and count", () => {
		expect([
			describePhoneTexts([text("Elara", "Kai")]),
			describePhoneTexts([text("Elara", "Kai"), text("Elara", "Kai"), text("Elara", "Kai")]),
			describePhoneTexts([text("Elara", "Kai"), text("Kai", "Elara")]),
			describePhoneTexts([text("Elara", "Kai"), text("Bram", "Kai")]),
		]).toEqual(["Elara texted Kai", "3 texts from Elara to Kai", "2 texts between Elara and Kai", "2 texts"]);
	});
});

describe("stripPhoneTexts", () => {
	test("lifts a text between the human and a Cast member out of the prose, in either direction", () => {
		expect(strip("She types.\n<sms from=\"Elara\" to=\"Kai\">u still up?</sms>\nThen waits.")).toEqual([
			{ kind: "prose", text: "She types.\n" }, { kind: "sms", text: { from: "Elara", to: "Kai", text: "u still up?" } }, { kind: "prose", text: "\nThen waits." },
		]);
		expect(strip("<sms from=\"kai\" to=\" elara \">yeah</sms>")).toEqual([{ kind: "sms", text: { from: "Kai", to: "Elara", text: "yeah" } }]);
	});

	test("leaves unknown names, Cast-to-Cast texts and texts to oneself as raw text", () => {
		for (const text of [
			"<sms from=\"Mara\" to=\"Kai\">hi</sms>",
			"<sms from=\"Elara\" to=\"Bram\">hi</sms>",
			"<sms from=\"Kai\" to=\"Kai\">note to self</sms>",
		]) expect(strip(text)).toEqual([{ kind: "prose", text }]);
	});

	test("leaves malformed markup as raw text", () => {
		for (const text of [
			"<sms from=\"Elara\" to=\"Kai\">never closed",
			"<sms to=\"Kai\" from=\"Elara\">attributes swapped</sms>",
			"<sms from=\"Elara\">no recipient</sms>",
			"<sms from=Elara to=Kai>unquoted</sms>",
			"<sms from=\"Elara\" to=\"Kai\">   </sms>",
		]) expect(strip(text)).toEqual([{ kind: "prose", text }]);
	});

	test("in nested markup, lifts only the innermost text and keeps the outer tags raw", () => {
		expect(strip("<sms from=\"Elara\" to=\"Kai\">outer <sms from=\"Kai\" to=\"Elara\">inner</sms> tail</sms>")).toEqual([
			{ kind: "prose", text: "<sms from=\"Elara\" to=\"Kai\">outer " },
			{ kind: "sms", text: { from: "Kai", to: "Elara", text: "inner" } },
			{ kind: "prose", text: " tail</sms>" },
		]);
	});

	test("a rendered text round-trips names and bodies that would break the markup, and stays readable", () => {
		const quoted = { human: "Kai", contacts: ["Elara \"Ellie\"", "<Bram> & co"] };
		for (const sms of [
			{ from: "Kai", to: "Elara \"Ellie\"", text: "meet me at </sms> or <sms from=\"x\" to=\"y\">" },
			{ from: "<Bram> & co", to: "Kai", text: "literally &quot; and &amp;lt; <3" },
		]) expect(stripPhoneTexts(renderPhoneText(sms), quoted)).toEqual([{ kind: "sms", text: sms }]);
		expect(renderPhoneText({ from: "Kai", to: "Elara", text: "Tom & Jerry \"tonight\" <3" })).toBe("<sms from=\"Kai\" to=\"Elara\">Tom & Jerry \"tonight\" <3</sms>");
	});
});
