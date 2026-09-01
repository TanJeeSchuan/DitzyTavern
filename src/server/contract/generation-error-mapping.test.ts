import { describe, expect, test } from "bun:test";
import {
	ConversationNotFoundError,
	StaleConversationRevisionError,
} from "../conversation";
import {
	UnexpectedGenerationStartFailure,
	generationAcceptanceResponse,
} from "./generation-error-mapping";

type Accepted = { readonly accepted: { generationId: 7; provisionalVariantId: 9 } };

const acceptedStart = async (): Promise<Accepted> => ({
	accepted: { generationId: 7, provisionalVariantId: 9 },
});

describe("generationAcceptanceResponse responder contract", () => {
	test("returns the typed acceptance body with the caller's Message id", async () => {
		const result = await generationAcceptanceResponse(42, acceptedStart, (accepted) => accepted.generationId, () => {
			throw new Error("A recognized start never asks the responder to map a response.");
		});
		expect(result).toEqual({
			outcome: "accepted",
			generationId: 7,
			conversationId: 42,
			messageId: 7,
			variantId: 9,
		});
	});

	test("returns the responder's mapped response for a recognized failure", async () => {
		const result = await generationAcceptanceResponse(
			42,
			async () => {
				throw new ConversationNotFoundError(42);
			},
			(accepted) => accepted.generationId,
			() => "mapped-404",
		);
		expect(result).toBe("mapped-404");
	});

	test("rethrows the original domain error when the responder refuses the mapping", async () => {
		const stale = new StaleConversationRevisionError(2, 3);
		const result = generationAcceptanceResponse(
			42,
			async () => {
				throw stale;
			},
			(accepted) => accepted.generationId,
			() => {
				throw new UnexpectedGenerationStartFailure();
			},
		);
		expect(result).rejects.toBe(stale);
	});

	test("rethrows errors outside the Generation acceptance contract", async () => {
		const unexpected = new Error("a domain bug outside the acceptance contract");
		const result = generationAcceptanceResponse(
			42,
			async () => {
				throw unexpected;
			},
			(accepted) => accepted.generationId,
			() => "never-mapped",
		);
		expect(result).rejects.toBe(unexpected);
	});

	test("propagates a responder crash instead of masking it as a mapped response", async () => {
		const crash = new Error("responder failure");
		const result = generationAcceptanceResponse(
			42,
			async () => {
				throw new ConversationNotFoundError(42);
			},
			(accepted) => accepted.generationId,
			() => {
				throw crash;
			},
		);
		expect(result).rejects.toBe(crash);
	});
});
