import { boxReference, type BoxStates } from "../../shared/contract/box";
import type { BoxTraces } from "../../shared/contract/box-generation";
import type { PromptPlan } from "../../shared/contract/conversation-schema";
import { BoxBoundary } from "./BoxBoundary";
import { boxClients, boxPresent } from "./registry";

export function BoxTraceViews({ conversationId, boxes, traces, plan, onNavigateSource }: {
	conversationId: number;
	/** @approved The Chat's Box states: a trace view, like every Chat surface, shows only while its Box is present. */
	boxes: BoxStates;
	traces: BoxTraces;
	plan?: PromptPlan;
	onNavigateSource?: (messageId: number) => void;
}) {
	return [...boxClients()].map(([id, { TraceView }]) => {
		const reference = boxReference(id);
		const trace = traces[reference];
		if (TraceView === undefined || trace === undefined || !boxPresent({ boxes }, id)) return null;
		const displayed = plan === undefined ? trace : { ...trace, finalText: plan.blocks.find((block) => block.kind === reference)?.content ?? "" };
		return <BoxBoundary key={id} box={id}><TraceView conversationId={conversationId} trace={displayed} onNavigateSource={onNavigateSource} /></BoxBoundary>;
	});
}
