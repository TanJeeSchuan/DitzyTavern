import { expect, test } from "bun:test";
import { blankConnectionProfileDraft, connectionPresetsResponse } from "../../shared/contract/connection-settings";
import { decodeWirePayload } from "./wire-decode";

const preset = { id: "openai", label: "OpenAI", description: "", profile: blankConnectionProfileDraft };

test("a response field the client does not know is dropped instead of failing the strict schema", () => {
	expect(decodeWirePayload(connectionPresetsResponse, { presets: [{ ...preset, profile: { ...blankConnectionProfileDraft, added: true } }] }))
		.toEqual({ presets: [preset] });
});

test("a known field of the wrong type still fails the response", () => {
	expect(decodeWirePayload(connectionPresetsResponse, { presets: [{ ...preset, profile: { ...blankConnectionProfileDraft, timeoutMs: "120000" } }] }))
		.toBeNull();
});
