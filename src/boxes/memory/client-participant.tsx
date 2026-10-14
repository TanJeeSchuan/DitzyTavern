import { Button, type CastParticipant, type ConversationSummary } from "@/box-sdk/client";
import { useState } from "react";
import { memoryIdentityLabel } from "./shared";
import { MemoryIdentityDialog } from "./client-identity-dialog";
import { useConversationMemories } from "./client-use-memories";

export function ParticipantMemory({ conversation, participant }: { conversation: ConversationSummary; participant: CastParticipant }) {
	const { memories, status, refresh, identitySaved } = useConversationMemories(conversation.id, conversation.revision);
	const [open, setOpen] = useState(false);
	return <section className="memory-participant" aria-label="Memory">
		<div className="memory-participant-text">
			<h3 className="memory-participant-title">Memory</h3>
			<p className="memory-participant-summary">
				{memories
					? memoryIdentityLabel(memories.identities[participant.id])
					: status === "failed"
						? "Could not load Memory settings"
						: "Loading…"}
			</p>
		</div>
		{status === "failed" ? (
			<Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button>
		) : (
			<Button type="button" size="xs" variant="outline" disabled={!memories} onClick={() => setOpen(true)}>Change…</Button>
		)}
		{open && memories && (
			<MemoryIdentityDialog
				conversationId={conversation.id}
				participant={participant}
				memories={memories}
				onClose={() => setOpen(false)}
				onSaved={(updated) => {
					void identitySaved(updated);
					setOpen(false);
				}}
			/>
		)}
	</section>;
}
