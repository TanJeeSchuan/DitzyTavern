import { describe, expect, test } from "bun:test";
import { expandMacroText, validateMacroText } from "./prompt-macro-engine";

const environment = {
	self: "Writer",
	other: "Maren",
	conversationId: 42,
	promptPresetId: 7,
	now: new Date("2026-01-02T15:04:05.000Z"),
	timeZone: "UTC",
	locale: "en-US",
};

describe("Prompt macro engine", () => {
	test("resolves case-insensitive names, nested arguments, and text utilities", () => {
		const result = expandMacroText(
			"{{SELF}} {{random::left::{{other}}}} {{space::2}}{{newline}}x{{reverse::abc}}",
			{ ...environment, random: () => 0.99 },
			"instruction",
		);
		expect(result.text).toBe("Writer Maren   \nxcba");
		expect(result.warnings).toEqual([]);
	});

	test("trims and dedents scoped content unless the hash flag preserves it", () => {
		const result = expandMacroText(
			"{{trim}}\nA\n{{if::yes}}\n    one\n    two\n{{/if}}\n{{#if::yes}}\n    three\n{{/if}}",
			environment,
			"instruction",
		);
		expect(result.text).toBe("A\none\ntwo\n\n    three\n");
	});

	test("does not execute comments and treats split braces as escaped text", () => {
		const result = expandMacroText(
			"before {{// {{setvar::hidden::value}} }}after \\{\\{self\\}\\} {{/if}}",
			environment,
			"instruction",
		);
		expect(result.text).toBe("before after {{self}} {{/if}}");
		expect(result.writes).toEqual([]);
	});

	test("threads variable writes and applies shorthand arithmetic", () => {
		const result = expandMacroText(
			"{{setvar::count::2}}{{.count++}}{{.count+=3}}{{getvar::count}}",
			{ ...environment, variables: new Map() },
			"instruction",
		);
		expect(result.text).toBe("36");
		expect(result.writes.at(-1)).toEqual({ name: "count", value: 6, operation: "set" });
	});

	test("keeps random fresh while pick stays stable for one source position", () => {
		let calls = 0;
		const input = "{{random::a::b}}/{{pick::a::b}}/{{pick::a::b}}";
		const first = expandMacroText(input, { ...environment, random: () => (calls += 1) * 0.1 }, "instruction");
		const second = expandMacroText(input, { ...environment, random: () => (calls += 1) * 0.1 }, "instruction");
		expect(first.text.slice(2)).toBe(second.text.slice(2));
		expect(calls).toBe(2);
	});

	test("uses the captured clock and client formatting context", () => {
		const result = expandMacroText(
			"{{isodate}} {{isotime}} {{datetimeformat::YYYY/MM/DD HH:mm}} {{weekday}}",
			environment,
			"instruction",
		);
		expect(result.text).toBe("2026-01-02 15:04 2026/01/02 15:04 Friday");
	});

	test("reports unknown macros without blocking expansion and keeps unmatched closes", () => {
		const result = expandMacroText("{{wat::{{other}}}} {{/wat}} {{self}}", environment, "instruction");
		expect(result.text).toBe("{{wat::Maren}} {{/wat}} Writer");
		expect(result.warnings).toEqual([{ block: "instruction", macro: "{{wat::{{other}}}} {{/wat}}" }]);
	});

	test("validates both conditional branches without sampling or writing", () => {
		let calls = 0;
		const result = validateMacroText("{{if::yes}}{{random::a}}{{wat}}{{else}}{{roll::1d6}}{{/if}}", "draft");
		expect(result.warnings).toEqual([{ block: "draft", macro: "{{wat}}" }]);
		expect(calls).toBe(0);
	});
});
