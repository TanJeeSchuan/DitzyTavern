import { describe, expect, test } from "bun:test";
import {
	ConversationNotFoundError,
	ConversationNotPlayableError,
	StaleConversationRevisionError,
} from "../conversation";
import {
	generationAcceptanceResponse,
	siblingGenerationAcceptanceResponse,
} from "./generation-error-mapping";

type Accepted = { readonly accepted: { generationId: 7; provisionalVariantId: 9 } };

const acceptedStart = async (): Promise<Accepted> => ({
	accepted: { generationId: 7, provisionalVariantId: 9 },
});

const failingStart = (error: Error) => async (): Promise<Accepted> => {
	throw error;
};

const messageId = (accepted: Accepted["accepted"]) => accepted.generationId;

describe("generation acceptance seams", () => {
	test("returns the typed acceptance body with the caller's Message id", async () => {
		const result = await generationAcceptanceResponse(42, acceptedStart, messageId);
		expect(result).toEqual({
			outcome: "accepted",
			generationId: 7,
			conversationId: 42,
			messageId: 7,
			variantId: 9,
		});
	});

	test("maps a recognized failure onto its status response", async () => {
		const result = await generationAcceptanceResponse(
			42,
			failingStart(new ConversationNotFoundError(42)),
			messageId,
		);
		expect(result).toMatchObject({ code: 404, response: { outcome: "not-found" } });
	});

	test("maps a stale-revision conflict for Send and Continue", async () => {
		const result = await generationAcceptanceResponse(
			42,
			failingStart(new StaleConversationRevisionError(2, 3)),
			messageId,
		);
		expect(result).toMatchObject({ code: 409, response: { outcome: "conflict" } });
	});

	test("rethrows errors outside the Generation acceptance contract", async () => {
		const unexpected = new Error("a domain bug outside the acceptance contract");
		expect(
			generationAcceptanceResponse(42, failingStart(unexpected), messageId),
		).rejects.toBe(unexpected);
	});

	test("Sibling starts present a not-playable conflict", async () => {
		const result = await siblingGenerationAcceptanceResponse(
			42,
			failingStart(new ConversationNotPlayableError(42)),
			messageId,
		);
		expect(result).toMatchObject({ code: 409, response: { outcome: "not-playable" } });
	});

	// ==[HUMAN APPROVED]== Sibling starts carry no revision input, so a stale-revision conflict
	// is outside their vocabulary and must reach the framework's 500 handling
	// as the original domain error.
	test("Sibling starts decline a stale-revision conflict", async () => {
		const stale = new StaleConversationRevisionError(2, 3);
		expect(
			siblingGenerationAcceptanceResponse(42, failingStart(stale), messageId),
		).rejects.toBe(stale);
	});
});
