import { describe, expect, test } from "bun:test";
import {
	createMacroAttemptState,
	expandMacroText as expandMacroTextWithState,
	validateMacroText,
	type MacroEnvironment,
} from "./prompt-macro-engine";

type TestMacroEnvironment = MacroEnvironment & {
	variables?: ReadonlyMap<string, import("./prompt-macro-engine").MacroValue>;
};

const expandMacroText = (
	source: string,
	environment: TestMacroEnvironment,
	blockLabel: string,
) => expandMacroTextWithState(
	source,
	environment,
	createMacroAttemptState(environment.variables),
	blockLabel,
);

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

	test("trims without consuming authored sentinel-like text", () => {
		const authored = "__DITZY_TRIM_SENTINEL__";
		const result = expandMacroText(`{{trim}}\n${authored}`, environment, "instruction");
		expect(result.text).toBe(authored);
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

	test("keeps variable names case-sensitive and supports local aliases and array addition", () => {
		const variables = new Map<string, import("./prompt-macro-engine").MacroValue>([
			["Count", 2],
			["items", ["one"]],
		]);
		const result = expandMacroText(
			"{{getvar::Count}}/{{getvar::count}}/{{addlocalvar::items::two}}{{getvar::items}}/{{.Count++}}",
			{ ...environment, variables },
			"instruction",
		);
		expect(result.text).toBe("2//[\"one\",\"two\"]/3");
		expect(result.writes).toEqual([
			{ name: "items", value: ["one", "two"], operation: "set" },
			{ name: "Count", value: 3, operation: "set" },
		]);
		const coerced = expandMacroText("{{incvar::text}}/{{addvar::text::!}}", {
			...environment,
			variables: new Map([["text", "raw"]]),
		}, "instruction");
		expect(coerced.text).toBe("raw1/");
		expect(coerced.writes).toEqual([
			{ name: "text", value: "raw1", operation: "set" },
			{ name: "text", value: "raw1!", operation: "set" },
		]);
	});

	test("does not execute global shorthand operations", () => {
		const result = expandMacroText("{{$count=3}}", environment, "instruction");
		expect(result.text).toBe("{{$count=3}}");
		expect(result.writes).toEqual([]);
		expect(result.warnings).toEqual([{ block: "instruction", macro: "{{$count=3}}" }]);
		const conditional = expandMacroText("{{if::$count}}yes{{else}}no{{/if}}", environment, "instruction");
		expect(conditional.text).toBe("{{if::$count}}yes{{else}}no{{/if}}");
		expect(conditional.writes).toEqual([]);
	});

	test("keeps malformed variable names literal instead of persisting invalid state", () => {
		const result = expandMacroText("{{setvar::::x}}/{{getvar::bad.name}}", environment, "instruction");
		expect(result.text).toBe("{{setvar::::x}}/{{getvar::bad.name}}");
		expect(result.writes).toEqual([]);
		expect(result.warnings).toHaveLength(2);
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

	test("honors fractional explicit UTC offsets", () => {
		const result = expandMacroText(
			"{{isotime::UTC+05:30}} {{isotime::UTC-04:30}} {{isotime UTC+05:30}} {{isotime:UTC-04:30}} {{datetimeformat:YYYY-MM-DD HH:mm}}",
			environment,
			"instruction",
		);
		expect(result.text).toBe("20:34 10:34 20:34 10:34 2026-01-02 15:04");
	});

	test("reports unknown macros without blocking expansion and keeps unmatched closes", () => {
		const result = expandMacroText("{{wat::{{other}}}} {{/wat}} {{self}}", environment, "instruction");
		expect(result.text).toBe("{{wat::Maren}} {{/wat}} Writer");
		expect(result.warnings).toEqual([{ block: "instruction", macro: "{{wat::{{other}}}} {{/wat}}" }]);
	});

	test("validates both conditional branches without sampling or writing", () => {
		const result = validateMacroText("{{if::yes}}{{random::a}}{{wat}}{{else}}{{roll::1d6}}{{/if}}", "draft");
		expect(result.warnings).toEqual([{ block: "draft", macro: "{{wat}}" }]);
	});

		test("evaluates nested arguments and scopes without executing the unchosen branch", () => {
		const state = createMacroAttemptState();
		const result = expandMacroText(
			"{{if::yes}}{{if::true}}{{setvar::chosen::{{self}}}}{{getvar::chosen}}{{/if}}{{else}}{{setvar::chosen::wrong}}{{/if}}",
			environment,
			state,
			"instruction",
		);
		expect(result.text).toBe("Writer");
		expect(result.writes).toEqual([{ name: "chosen", value: "Writer", operation: "set" }]);
	});
});
