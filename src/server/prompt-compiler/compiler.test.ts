import { describe, expect, test } from "bun:test";
import {
	compileOpening,
	compilePrompt,
	expandText,
	type CompilePromptInput,
	type PromptPlan,
} from ".";

// The order the stored Default preset ships with, restated here so the pure
// compiler can be exercised without a database. The roles are the stored
// roles the Default starts with: the established assembly presentation.
const defaultRecipe: CompilePromptInput["recipe"] = [
	{ reference: "model-system-instruction", enabled: true, role: "system" },
	{ reference: "human-identity", enabled: true, role: "user" },
	{ reference: "model-identity", enabled: true, role: "assistant" },
	{ reference: "model-scenario", enabled: true, role: "system" },
	{ reference: "model-example-dialogue", enabled: true, role: "user" },
	{ reference: "history", enabled: true, role: null },
	{ reference: "model-post-history-instruction", enabled: true, role: "system" },
];

const source = (overrides: Partial<CompilePromptInput> = {}): CompilePromptInput => ({
	recipe: defaultRecipe,
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
		context: [
			{ kind: "message", speakerName: "Writer", content: "First history line.", role: "human" },
			{ kind: "message", speakerName: "Maren Voss", content: "Second history line.", role: "model" },
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

	test("orders the two Identities with their stored outgoing roles", () => {
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
			role: "human",
			content: "<START>\n{{user}}: Who tends the light?\n  indented line with trailing spaces  ",
		});
		expect(plan.blocks[1]).toEqual({
			kind: "post-history-instruction",
			role: "system",
			content: "\nPost with leading newline.",
		});
	});

	test("includes every selected-history entry as its own block with the speaker name", () => {
		const plan = compilePrompt(
			source({
				context: [
					{ kind: "message", speakerName: "Writer", content: "One", role: "human" },
					{ kind: "message", speakerName: null, content: "Preserved", role: null },
				],
			}),
		);
		expect(plan.blocks).toEqual([
			{ kind: "history", speakerName: "Writer", content: "One", role: "human" },
			{ kind: "history", speakerName: null, content: "Preserved", role: null },
		]);
	});

	test("does not expand macros inside selected history", () => {
		const plan = compilePrompt(
			source({
				context: [
					{ kind: "message", speakerName: "Writer", content: "{{self}} stays literal here.", role: "human" },
				],
			}),
		);
		expect(plan.blocks[0]).toEqual({
			kind: "history",
			speakerName: "Writer",
			content: "{{self}} stays literal here.",
			role: "human",
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
			{ kind: "system-instruction", role: "system", content: "Model system." },
			{ kind: "scenario", role: "system", content: "Model scenario." },
			{ kind: "example-dialogue", role: "human", content: "Model example." },
			{ kind: "post-history-instruction", role: "system", content: "Model post." },
		]);
	});
});

describe("Outgoing roles and repeated occurrences", () => {
	test("carries each slot's outgoing role onto its compiled block", () => {
		const plan = compilePrompt(
			source({
				recipe: [
					{ reference: "model-identity", enabled: true, role: "system" },
					{ reference: "model-scenario", enabled: true, role: "user" },
				],
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "I am Maren Voss.",
						scenario: "A quiet room.",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		expect(plan.blocks).toEqual([
			{ kind: "identity", role: "system", content: "I am Maren Voss." },
			{ kind: "scenario", role: "human", content: "A quiet room." },
		]);
	});

	test("renders one occurrence per recipe position, including deliberate duplicates", () => {
		const plan = compilePrompt(
			source({
				recipe: [
					{ reference: "model-scenario", enabled: true, role: "system" },
					{ reference: "history", enabled: true, role: null },
					{ reference: "model-scenario", enabled: true, role: "system" },
					{ reference: "history", enabled: true, role: null },
				],
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "",
						scenario: "A quiet room.",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
				context: [
					{ kind: "message", speakerName: "Writer", content: "First.", role: "human" },
				],
			}),
		);
		expect(plan.blocks).toEqual([
			{ kind: "scenario", role: "system", content: "A quiet room." },
			{ kind: "history", speakerName: "Writer", content: "First.", role: "human" },
			{ kind: "scenario", role: "system", content: "A quiet room." },
			{ kind: "history", speakerName: "Writer", content: "First.", role: "human" },
		]);
	});

	test("re-renders a disabled or later-omitted occurrence without touching the stored text", () => {
		const plan = compilePrompt(
			source({
				recipe: [
					{ reference: "model-identity", enabled: false, role: "assistant" },
					{ reference: "model-identity", enabled: true, role: "assistant" },
				],
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "I am Maren Voss.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		// The disabled occurrence contributes nothing; the enabled one renders
		// once. Neither renders the other's emptiness.
		expect(plan.blocks).toEqual([
			{ kind: "identity", role: "model", content: "I am Maren Voss." },
		]);
	});

	test("rejects a Definition slot without an outgoing role", () => {
		expect(() =>
			compilePrompt(
				source({
					recipe: [{ reference: "model-scenario", enabled: true, role: null }],
				}),
			),
		).toThrow("model-scenario");
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

	test("renders an escaped Prompt Comment literally without stripping or warning", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "Syntax: \\{{// draft: mention {{unfinished}} }} end.",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		// The backslash removes the comment's activity, so the whole comment
		// stays in the plan as literal text and its enclosed unknown macro
		// neither expands nor warns.
		expect(plan.blocks[0]?.content).toBe(
			"Syntax: {{// draft: mention {{unfinished}} }} end.",
		);
		expect(plan.warnings).toEqual([]);
	});

	test("a double backslash leaves a following Prompt Comment active", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "\\\\{{// note }} and {{self}}",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		// The first backslash escapes the second, so the comment that follows
		// is still an active comment and the macro after it still expands.
		expect(plan.blocks[0]?.content).toBe("\\ and Maren Voss");
	});

	test("keeps an unterminated comment open as raw text without swallowing content", () => {
		const plan = compilePrompt(
			source({
				model: {
					name: "Maren Voss",
					prompt: {
						systemInstruction: "",
						identity: "{{// oops, never closed",
						scenario: "",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
				},
			}),
		);
		// Without a balancing `}}` there is no comment, so the text renders
		// literally instead of silently swallowing the rest of the field.
		expect(plan.blocks[0]?.content).toBe("{{// oops, never closed");
		expect(plan.warnings).toEqual([]);
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
describe("Authored instruction blocks", () => {
	const instruction = (overrides: Partial<{
		enabled: boolean;
		role: "system" | "user" | "assistant";
		name: string;
		content: string;
	}>): CompilePromptInput["recipe"] =>
		[
			{
				reference: "instruction",
				enabled: true,
				role: "system",
				name: "Intro",
				content: "Write vividly.",
				...overrides,
			},
		];

	test("compiles an instruction block with its authored content and outgoing role", () => {
		const plan = compilePrompt(
			source({
				recipe: instruction({ role: "user" }),
			}),
		);
		expect(plan.blocks).toEqual([
			{ kind: "instruction", role: "human", content: "Write vividly." },
		]);
		expect(plan.warnings).toEqual([]);
	});

	test("omits a disabled or empty instruction from the rendered plan", () => {
		const disabled = compilePrompt(source({ recipe: instruction({ enabled: false }) }));
		expect(disabled.blocks).toEqual([]);

		const empty = compilePrompt(
			source({ recipe: instruction({ content: "{{// just a note }}" }) }),
		);
		// A comment-only instruction contributes no text and is omitted, exactly
		// like a Definition channel that holds nothing but a comment.
		expect(empty.blocks).toEqual([]);
		expect(empty.warnings).toEqual([]);
	});

	test("resolves {{self}} and {{other}} to the current Control pair, independent of outgoing role", () => {
		const roleCases = ["system", "user", "assistant"] as const;
		for (const role of roleCases) {
			const plan = compilePrompt(
				source({
					recipe: instruction({
						role,
						content: "{{self}} writes to {{other}}.",
					}),
					human: { name: "Rowan", prompt: emptyChannels },
					model: { name: "Sable", prompt: emptyChannels },
				}),
			);
			// The perspective never follows the outgoing role: self is always
			// the human-controlled Participant and other the model-controlled
			// one.
			expect(plan.blocks[0]).toEqual({
				kind: "instruction",
				role: role === "system" ? "system" : role === "user" ? "human" : "model",
				content: "Rowan writes to Sable.",
			});
		}
	});

	test("keeps owner-relative resolution for Definition slots beside an instruction", () => {
		const plan = compilePrompt(
			source({
				recipe: [
					{ reference: "model-identity", enabled: true, role: "assistant" },
					{ reference: "instruction", enabled: true, role: "system", name: "Intro", content: "{{self}} vs {{other}}." },
				],
				human: { name: "Rowan", prompt: emptyChannels },
				model: {
					name: "Sable",
					prompt: { ...emptyChannels, identity: "I am {{self}}, you are {{other}}." },
				},
			}),
		);
		// The model Definition keeps owner-relative meaning while the authored
		// instruction resolves to the Control pair.
		expect(plan.blocks).toEqual([
			{ kind: "identity", role: "model", content: "I am Sable, you are Rowan." },
			{ kind: "instruction", role: "system", content: "Rowan vs Sable." },
		]);
	});

	test("keeps unknown macros literal, labels warnings with the block name, and never throws", () => {
		const plan = compilePrompt(
			source({
				recipe: instruction({
					name: "Jailbreak",
					content: "{{random}} stays, but {{self}} works.",
				}),
				human: { name: "Rowan", prompt: emptyChannels },
				model: { name: "Sable", prompt: emptyChannels },
			}),
		);
		expect(plan.blocks[0]?.content).toBe("{{random}} stays, but Rowan works.");
		expect(plan.warnings).toEqual([{ block: "Jailbreak", macro: "{{random}}" }]);
	});

	test("uses the shared comment and escaping processor for instruction text", () => {
		const plan = compilePrompt(
			source({
				recipe: instruction({
					content: "A \\{{self}} literal and {{// note: {{unfinished}} }} done.",
				}),
				human: { name: "Rowan", prompt: emptyChannels },
				model: { name: "Sable", prompt: emptyChannels },
			}),
		);
		// The escaped macro renders literally and the comment is stripped whole
		// without warning about the macro inside it — the same behavior as
		// Participant-owned text.
		expect(plan.blocks[0]?.content).toBe("A {{self}} literal and  done.");
		expect(plan.warnings).toEqual([]);
	});
});

const emptyChannels = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};
