import { describe, expect, test } from "bun:test";
import { presentDomainError } from "./domain-error";
import { InvalidConversationCommandError, StaleConversationRevisionError } from "../conversation";
import { PromptPresetDeletionImpactChangedError } from "../prompt-preset";
import { conversationConflict } from "../../shared/contract/conversation-schema";
import { promptPresetCommandConflict } from "../../shared/contract/prompt-preset";
import { notFoundOutcome } from "../../shared/contract/outcomes";

describe("domain error presentation", () => {
	test("keeps unexpected throws and undeclared outcomes outside the route contract", () => {
		const bug = new Error("Unexpected database failure");
		for (const cause of [bug, "provider failure", new InvalidConversationCommandError("invalid")]) {
			try {
				presentDomainError(cause, { 404: notFoundOutcome });
				throw new Error("Expected the original failure");
			} catch (error) {
				expect(error).toBe(cause);
			}
		}
	});

	test("presents a nested deletion-impact union with its authoritative preset", () => {
		const preset = { id: 9, name: "Changed", revision: 2, isDefault: false, conversationCount: 3 };
		const error = new PromptPresetDeletionImpactChangedError(1, preset);
		const result = presentDomainError(error, { 409: promptPresetCommandConflict });
		expect(result).toMatchObject({ code: 409, response: {
			outcome: "conflict", reason: "deletion-impact", currentPreset: preset,
		} });
		expect(Object.keys(result.response)).toEqual(["outcome", "reason", "currentPreset"]);
	});

	test("reports disappearance during stale recovery only when the route declares not-found", () => {
		const stale = new StaleConversationRevisionError(1, 2);
		expect(presentDomainError(stale, { 404: notFoundOutcome, 409: conversationConflict }, {
			currentConversation: () => undefined,
		})).toMatchObject({ code: 404, response: { outcome: "not-found" } });
		expect(() => presentDomainError(stale, { 409: conversationConflict }, {
			currentConversation: () => undefined,
		})).toThrow(stale);
	});

});
