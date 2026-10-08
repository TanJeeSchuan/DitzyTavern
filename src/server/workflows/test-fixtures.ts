import { type TestConversationSnapshot, readTestConversationSnapshot } from "../test-fixtures/conversation";
import type { Database } from "bun:sqlite";
import { ConversationNotFoundError} from "../conversation";
import { runGenerationLifecycle } from "./generate";
import type { GenerationAttemptInput } from "./generate-server-owned";

/**
 * ==[HUMAN APPROVED]== Test-fixture seam for suites that need a terminal model Message without a
 * user Send. It composes the production Continuation lifecycle — acceptance
 * followed by resolution — instead of a parallel commit path, so fixtures
 * exercise the same Active Generation persistence, Author Stamp capture, and
 * terminal rules every server-owned Generation uses. It is therefore absent
 * from the public workflow barrel and every HTTP route. Product code must
 * use the server-owned Send, Continue, or Sibling starts.
 */
export async function generateTerminalTailFixture(
	database: Database,
	input: GenerationAttemptInput,
): Promise<TestConversationSnapshot> {
	const snapshot = readTestConversationSnapshot(database, input.conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(input.conversationId);
	}
	await runGenerationLifecycle(database, {target: { kind: "continuation" },
		...input,
		expectedRevision: snapshot.revision,
	});
	const committed = readTestConversationSnapshot(database, input.conversationId);
	if (committed === undefined) {
		throw new ConversationNotFoundError(input.conversationId);
	}
	return committed;
}
