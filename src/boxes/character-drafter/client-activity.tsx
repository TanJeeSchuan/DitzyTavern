import { useState } from "react";
import { CodeView } from "@/box-sdk/client";
import type { CodeAgentActivity } from "@/box-sdk/shared";

/** @approved One step the agent ran: its one-line summary, opened to the code it ran and what came back, built only once opened. */
function Step({ activity, index }: { activity: CodeAgentActivity; index: number }) {
	const [open, setOpen] = useState(false);
	return <details className="character-drafter-step" onToggle={(event) => setOpen(event.currentTarget.open)}>
		<summary>{activity.summary}</summary>
		{open && <div className="character-drafter-step-body">
			<h4>Code</h4>
			<CodeView text={activity.code} language="javascript" label={`Step ${index + 1} code`} />
			<h4>Output</h4>
			<CodeView text={activity.output} language="text" label={`Step ${index + 1} output`} />
		</div>}
	</details>;
}

/** @approved The agent's steps, oldest first, one line each. */
export function ActivityFeed({ activities }: { activities: readonly CodeAgentActivity[] }) {
	if (activities.length === 0) return null;
	return <ol className="character-drafter-activity" aria-label="Agent steps" aria-live="polite">
		{activities.map((activity, index) => <li key={index}><Step activity={activity} index={index} /></li>)}
	</ol>;
}
