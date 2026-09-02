import { describe, expect, test } from "bun:test";
import {
	ModelClientTransportError,
	toModelClientTransportError,
} from "./errors";

describe("Model Client transport errors", () => {
	test("preserves a non-Error thrown value as the cause", () => {
		const thrown = { source: "test transport" };
		const error = toModelClientTransportError(thrown);

		expect(error).toBeInstanceOf(ModelClientTransportError);
		expect(error.kind).toBe("transport");
		expect(error.message).toBe("The provider request failed.");
		expect(error.cause).toBe(thrown);
	});
});
