import { describe, expect, test } from "bun:test";
import { conversationCommandPolicy } from "./execute";

// The per-command gate policy is the executed contract: it states which
// actions demand a playable Conversation and which an Active Generation
// blocks. Compose (create-message) and Swipe creation (create-variant) are
// the play actions; Control mutation joins them behind the
// Active-Generation gate; every other command stays available to incomplete
// Conversations and during a running Generation.
describe("conversation command gate policy", () => {
	test("declares the canonical gates per command", () => {
		const gates = Object.fromEntries(
			Object.entries(conversationCommandPolicy).map(([type, policy]) => [
				type,
				{
					requiresPlayable: policy.requiresPlayable,
					blockedByActiveGeneration: policy.blockedByActiveGeneration,
				},
			]),
		);
		expect(gates).toEqual({
			"create-message": { requiresPlayable: true, blockedByActiveGeneration: true },
			"create-variant": { requiresPlayable: true, blockedByActiveGeneration: true },
			"select-variant": { requiresPlayable: false, blockedByActiveGeneration: false },
			"edit-variant": { requiresPlayable: false, blockedByActiveGeneration: false },
			"delete-variant": { requiresPlayable: false, blockedByActiveGeneration: false },
			"delete-message": { requiresPlayable: false, blockedByActiveGeneration: false },
			"add-participant": { requiresPlayable: false, blockedByActiveGeneration: false },
			"rename-participant": { requiresPlayable: false, blockedByActiveGeneration: false },
			"replace-participant-prompt": { requiresPlayable: false, blockedByActiveGeneration: false },
			"replace-participant-openings": { requiresPlayable: false, blockedByActiveGeneration: false },
			"assign-control": { requiresPlayable: false, blockedByActiveGeneration: true },
			"remove-participant": { requiresPlayable: false, blockedByActiveGeneration: false },
			"put-data": { requiresPlayable: false, blockedByActiveGeneration: false },
			"delete-data": { requiresPlayable: false, blockedByActiveGeneration: false },
			"update-generation-settings": { requiresPlayable: false, blockedByActiveGeneration: false },
			"set-generation-model": { requiresPlayable: false, blockedByActiveGeneration: false },
		});
	});
});
