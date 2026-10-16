import { boxReference } from "../../shared/contract/box";
import type { BoxTraces } from "../../shared/contract/box-generation";
import type { PromptPlan } from "../../shared/contract/conversation-schema";
import { BoxBoundary } from "./BoxBoundary";
import { boxClients } from "./registry";

export function BoxTraceViews({ conversationId, traces, plan, onNavigateSource }: {
	conversationId: number;
	traces: BoxTraces;
	plan?: PromptPlan;
	onNavigateSource?: (messageId: number) => void;
}) {
	return [...boxClients()].map(([id, { TraceView }]) => {
		const reference = boxReference(id);
		const trace = traces[reference];
		if (TraceView === undefined || trace === undefined) return null;
		const displayed = plan === undefined ? trace : { ...trace, finalText: plan.blocks.find((block) => block.kind === reference)?.content ?? "" };
		return <BoxBoundary key={id} box={id}><TraceView conversationId={conversationId} trace={displayed} onNavigateSource={onNavigateSource} /></BoxBoundary>;
	});
}
