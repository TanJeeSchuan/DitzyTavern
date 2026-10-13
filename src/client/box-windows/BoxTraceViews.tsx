import { boxReference } from "../../shared/contract/box";
import type { BoxTraces } from "../../shared/contract/box-generation";
import type { PromptPlan } from "../../shared/contract/conversation-schema";
import type { ConversationSummary } from "../conversation";
import { boxClients } from "./registry";

export function BoxTraceViews({ conversation, traces, plan, onNavigateSource }: {
	conversation: ConversationSummary;
	traces: BoxTraces;
	plan?: PromptPlan;
	onNavigateSource?: (messageId: number) => void;
}) {
	return [...boxClients].map(([id, { TraceView }]) => {
		const reference = boxReference(id);
		const trace = traces[reference];
		if (conversation.boxes[id] !== "enabled" || TraceView === undefined || trace === undefined) return null;
		const displayed = plan === undefined ? trace : { ...trace, finalText: plan.blocks.find((block) => block.kind === reference)?.content ?? "" };
		return <TraceView key={id} conversationId={conversation.id} trace={displayed} onNavigateSource={onNavigateSource} />;
	});
}
