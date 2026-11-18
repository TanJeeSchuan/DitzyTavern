import { Button, openDefinitionDraft, type CastParticipant, type ConversationSummary } from "@/box-sdk/client";
import { ActivityFeed } from "./client-activity";
import { useDrafterRead, useDraftRun } from "./client-api";
import { DraftStatus } from "./client-window";
import descriptor from "./shared-descriptor";

// @approved
//  "Draft from story" in the Participant editor: drafts who this Cast member
// has become and opens the draft offering to replace their Definition.
export function DraftFromStory({ conversation, participant }: { conversation: ConversationSummary; participant: CastParticipant }) {
	const read = useDrafterRead(conversation);
	const { run, start, cancel } = useDraftRun((draft) => openDefinitionDraft(draft, { conversationId: conversation.id, replaces: participant.id }));
	const enabled = conversation.boxes[descriptor.id] === "enabled";
	const unavailable = enabled ? read.data?.unavailable ?? null : "The Character Drafter is off in this Chat.";
	return <section className="character-drafter-participant" aria-label="Character Drafter">
		<div className="character-drafter-participant-row">
			<div className="character-drafter-participant-text">
				<h3 className="character-drafter-participant-title">Character Drafter</h3>
				<p className="character-drafter-participant-summary">Drafts who {participant.duplicateLabel} has become from the story.</p>
			</div>
			{run.status === "running"
				? <Button type="button" size="xs" variant="outline" onClick={cancel}>Cancel</Button>
				: <Button type="button" size="xs" variant="outline" disabled={unavailable !== null}
					onClick={() => void start({ conversationId: conversation.id, person: participant.name, participantId: participant.id })}>Draft from story</Button>}
		</div>
		<DraftStatus run={run} unavailable={unavailable} />
		{run.status !== "idle" && <ActivityFeed activities={run.activities} />}
	</section>;
}
