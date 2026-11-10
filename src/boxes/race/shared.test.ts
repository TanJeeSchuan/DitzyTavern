import { expect, test } from "bun:test";
import raceBox from "./logic";
import { fillRaceField, initialRaceSetup } from "./shared-data";

const running = { ...initialRaceSetup, raceId: "race-a", phase: "running" as const, slots: fillRaceField([], [], "field") };
/** @approved The same setup with every object's keys in reverse order, as a stored setup and a draft may list them. */
const reordered = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, inner) => inner instanceof Object && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).reverse()) : inner));

test("a running race takes an Auto change whatever its keys' order, and refuses any other change", () => {
	const previous = reordered(running);
	expect(raceBox.setupError({ ...running, auto: "off" }, previous)).toBeUndefined();
	expect(raceBox.setupError({ ...running, course: { ...running.course, distance: 1600 } }, previous)).toBe("Start a new race to change the course or field.");
});
