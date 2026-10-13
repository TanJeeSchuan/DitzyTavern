import { expect, test } from "bun:test";
import { stripThoughts } from "./shared";

test("stripThoughts lifts each closed thought out of the prose", () => {
	expect(stripThoughts("She smiles.\n<thought> He knows. </thought>\nShe pours the tea.<thought>Stay calm.</thought>")).toEqual([
		{ kind: "prose", text: "She smiles.\n" }, { kind: "thought", text: "He knows." }, { kind: "prose", text: "\nShe pours the tea." }, { kind: "thought", text: "Stay calm." },
	]);
});

test("stripThoughts leaves unclosed, empty, misspelled and attributed markup as prose", () => {
	for (const text of ["<thought>never closed", "stray close</thought>", "<thought>   </thought>", "<thoughts>plural</thoughts>", "<thought who=\"Ann\">aside</thought>"]) {
		expect(stripThoughts(text)).toEqual([{ kind: "prose", text }]);
	}
});

test("stripThoughts lifts only the innermost pair of nested markup", () => {
	expect(stripThoughts("<thought>outer <thought>inner</thought> tail</thought>")).toEqual([
		{ kind: "prose", text: "<thought>outer " }, { kind: "thought", text: "inner" }, { kind: "prose", text: " tail</thought>" },
	]);
});
