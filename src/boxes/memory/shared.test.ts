import { describe, expect, test } from "bun:test";
import { applyMemoryPeople } from "./shared";

const cast = [{ id: 1, names: ["Director", "Writer"] }, { id: 2, names: ["Maren"] }];

describe("Memory people under identities and label merges", () => {
	test("an excluded Participant leaves under every name, a label merged into one included", () => {
		expect(applyMemoryPeople(["Narrator", "Director", "Writer", "Maren"], cast, { 1: { kind: "excluded" } }, [{ from: "Narrator", to: "Writer" }])).toEqual(["Maren"]);
	});

	test("every name of a Participant who plays someone becomes that person, once", () => {
		expect(applyMemoryPeople(["Director", "Writer", "Tanjs", "Maren"], cast, { 1: { kind: "plays", person: "Tanjs" } }, [])).toEqual(["Tanjs", "Maren"]);
	});

	test("a played person follows a merge of that person's label", () => {
		expect(applyMemoryPeople(["Narrator", "Writer", "Tanjs"], cast, { 1: { kind: "plays", person: "Tanjs" } }, [{ from: "Narrator", to: "Writer" }, { from: "Tanjs", to: "Tan" }])).toEqual(["Tan"]);
	});
});
