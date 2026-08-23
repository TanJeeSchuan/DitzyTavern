import { describe, expect, test } from "bun:test";
import {
	compileOpening,
	compilePrompt,
	expandText,
	type CompilePromptInput,
	type PromptPlan,
} from ".";

const source = (overrides: Partial<CompilePromptInput> = {}): CompilePromptInput => ({
	human: {
		name: "Writer",
		prompt: {
			systemInstruction: "",
			identity: "",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
	},
	model: {
		name: "Maren Voss",
		prompt: {
			systemInstruction: "",
			identity: "",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
	},
	...overrides,
});

const filled = (): CompilePromptInput =>
	source({
		human: {
			name: "Writer",
			prompt: {
				systemInstruction: "",
				identity: "Human identity line.",
				scenario: "",
				exampleDialogue: "",
				postHistoryInstruction: "",
			},
		},
		model: {
			name: "Maren Voss",
			prompt: {
				systemInstruction: "System line.",
				identity: "Model identity line.",
				scenario: "Scenario line.",
				exampleDialogue: "Example line.",
				postHistoryInstruction: "Post line.",
			},
		},
		history: [
			{ speakerName: "Writer", content: "First history line." },
			{ speakerName: "Maren Voss", content: "Second history line." },
		],
	});

describe("Prompt compiler", () => {
	test("compiles blocks in the fixed deterministic order", () => {
		const plan = compilePrompt(filled());
		expect(plan.blocks.map((block) => block.kind)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"history",
			"post-history-instruction",
		]);
	});

	test("orders the two Identities as human then model", () => {
		const plan = compilePrompt(filled());
		expect(plan.blocks.filter((block) => block.kind === "identity")).toEqual([
			{ kind: "identity", role: "human", content: "Human identity line." },
			{ kind: "identity", role: "model", content: "Model identity line." },
		]);
	});

	test("omits empty Definition blocks from the rendered plan", () => {
		const plan = compilePrompt(source());
		expect(plan.blocks).toEqual([]);
		expect(plan.warnings).toEqual([]);

		const partial = compilePrompt(
			source({
				human: {
					name: "Writer",
					prompt: {
						systemInstruction: "",
						identity: "Only the human identity is filled.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(partial.blocks).toEqual([
			{ kind: "identity", role: "human", content: "Only the human identity is filled." },
		]);
	});

	test("preserves prompt text exactly, including Example Dialogue raw text", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "",
						scenario: "",
						exampleDialogue: "<START>\n{{user}}: Who tends the light?\n  indented line with trailing spaces  ",
						postHistoryInstruction: "\nPost with leading newline.",
					},
				},
			}),
		);
		expect(plan.blocks[0]).toEqual({
			kind: "example-dialogue",
			content: "<START>\n{{user}}: Who tends the light?\n  indented line with trailing spaces  ",
		});
		expect(plan.blocks[1]).toEqual({
			kind: "post-history-instruction",
			content: "\nPost with leading newline.",
		});
	});

	test("includes every selected-history entry as its own block with the speaker name", () => {
		const plan = compilePrompt(
			source({
				history: [
					{ speakerName: "Writer", content: "One" },
					{ speakerName: null, content: "Preserved" },
				],
			}),
		);
		expect(plan.blocks).toEqual([
			{ kind: "history", speakerName: "Writer", content: "One" },
			{ kind: "history", speakerName: null, content: "Preserved" },
		]);
	});

	test("does not expand macros inside selected history", () => {
		const plan = compilePrompt(
			source({
				history: [
					{ speakerName: "Writer", content: "{{self}} stays literal here." },
				],
			}),
		);
		expect(plan.blocks[0]).toEqual({
			kind: "history",
			speakerName: "Writer",
			content: "{{self}} stays literal here.",
		});
		expect(plan.warnings).toEqual([]);
	});

	test("always uses the model Definition for non-Identity Definition blocks", () => {
		const plan = compilePrompt(
			source({
				human: {
					name: "Writer",
					prompt: {
						systemInstruction: "Human system must not render.",
						identity: "",
						scenario: "Human scenario must not render.",
						exampleDialogue: "Human example must not render.",
						postHistoryInstruction: "Human post must not render.",
					},
				},
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "Model system.",
						identity: "",
						scenario: "Model scenario.",
						exampleDialogue: "Model example.",
						postHistoryInstruction: "Model post.",
					},
				},
			}),
		);
		expect(plan.blocks).toEqual([
			{ kind: "system-instruction", content: "Model system." },
			{ kind: "scenario", content: "Model scenario." },
			{ kind: "example-dialogue", content: "Model example." },
			{ kind: "post-history-instruction", content: "Model post." },
		]);
	});
});

describe("Macro expansion", () => {
	test("expands {{self}} and {{other}} relative to each Definition owner", () => {
		const plan = compilePrompt(
			source({
				human: {
					name: "Writer",
					prompt: {
						systemInstruction: "",
						identity: "I am {{self}}, you are {{other}}.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "I am {{self}}, you are {{other}}.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(plan.blocks).toEqual([
			{ kind: "identity", role: "human", content: "I am Writer, you are Maren Voss." },
			{ kind: "identity", role: "model", content: "I am Maren Voss, you are Writer." },
		]);
		expect(plan.warnings).toEqual([]);
	});

	test("is case-sensitive: {{SELF}} stays literal and warns", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "{{SELF}} and {{SELF}}.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(plan.blocks[0]?.content).toBe("{{SELF}} and {{SELF}}.");
		expect(plan.warnings).toEqual([
			{ block: "identity (model)", macro: "{{SELF}}" },
			{ block: "identity (model)", macro: "{{SELF}}" },
		]);
	});

	test("expands once and never rescans expansion output", () => {
		const plan = compilePrompt(
			source({
				human: {
					name: "X{{self}}Y",
					prompt: {
						systemInstruction: "",
						identity: "Name: {{self}}",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(plan.blocks[0]?.content).toBe("Name: X{{self}}Y");
		expect(plan.warnings).toEqual([]);
	});

	test("renders an escaped recognized macro literally without a warning", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "Use \\{{self}} and \\{{other}} literally.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(plan.blocks[0]?.content).toBe(
			"Use {{self}} and {{other}} literally.",
		);
		expect(plan.warnings).toEqual([]);
	});

	test("a backslash escapes a backslash before a macro", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "\\\\{{self}}",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		// The first backslash escapes the second, so {{self}} expands.
		expect(plan.blocks[0]?.content).toBe("\\Maren Voss");
	});

	test("keeps unknown macros literal and reports them as warnings per block", () => {
		const plan = compilePrompt(
			source({
				human: {
					name: "Writer",
					prompt: {
						systemInstruction: "",
						identity: "{{random}} stays.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "",
						scenario: "",
						exampleDialogue: "{{char}}: {{random}}",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(plan.blocks[0]?.content).toBe("{{random}} stays.");
		expect(plan.blocks[1]?.content).toBe("{{char}}: {{random}}");
		expect(plan.warnings).toEqual([
			{ block: "identity (human)", macro: "{{random}}" },
			{ block: "example-dialogue", macro: "{{char}}" },
			{ block: "example-dialogue", macro: "{{random}}" },
		]);
	});

	test("leaves unclosed braces literal without a warning", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "{{self and {also",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(plan.blocks[0]?.content).toBe("{{self and {also");
		expect(plan.warnings).toEqual([]);
	});
});

describe("Opening compilation", () => {
	test("compiles openings with the owner-relative macro context", () => {
		const first = compileOpening(
			"{{self}} greets {{other}}.",
			{ self: "Maren Voss", other: "Writer" },
			1,
		);
		expect(first.text).toBe("Maren Voss greets Writer.");
		expect(first.warnings).toEqual([]);
	});

	test("labels unknown-opening macro warnings with the ordered position", () => {
		const second = compileOpening(
			"{{random}} remains.",
			{ self: "Maren Voss", other: "Writer" },
			2,
		);
		expect(second.text).toBe("{{random}} remains.");
		expect(second.warnings).toEqual([
			{ block: "opening 2", macro: "{{random}}" },
		]);
	});

	test("escaped macros inside openings render literally", () => {
		const opening = compileOpening(
			"Say \\{{self}} plainly.",
			{ self: "Maren Voss", other: "Writer" },
			1,
		);
		expect(opening.text).toBe("Say {{self}} plainly.");
		expect(opening.warnings).toEqual([]);
	});
});

describe("expandText", () => {
	test("is a single left-to-right pass over mixed literal, escaped, and unknown text", () => {
		const result = expandText(
			"A \\{{self}} B {{self}} C {{unknown}} D \\\\{{other}} E",
			{ self: "S", other: "O" },
			"example-dialogue",
		);
		expect(result.text).toBe("A {{self}} B S C {{unknown}} D \\O E");
		expect(result.warnings).toEqual([
			{ block: "example-dialogue", macro: "{{unknown}}" },
		]);
	});

	test("produces an empty plan for fully empty Definitions", () => {
		const plan: PromptPlan = compilePrompt(source());
		expect(plan.blocks).toEqual([]);
		expect(plan.warnings).toEqual([]);
	});
});