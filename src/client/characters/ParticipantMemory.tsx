import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationSummary } from "../conversation";
import { memoryIdentityLabel } from "../../shared/memory-identity";
import { MemoryIdentityDialog } from "../workspace/MemoryIdentityDialog";
import { useConversationMemories } from "../workspace/useConversationMemories";

export function ParticipantMemory({ conversation, participant }: { conversation: ConversationSummary; participant: ConversationSummary["cast"][number] }) {
	const { memories, status, refresh, identitySaved } = useConversationMemories(conversation.id, conversation.revision);
	const [open, setOpen] = useState(false);
	return <section className="flex items-center justify-between gap-3" aria-label="Memory">
		<div className="grid gap-1"><h3 className="text-xs font-medium text-muted-foreground">Memory</h3><p className="text-sm">{memories ? memoryIdentityLabel(memories.identities[participant.id]) : status === "failed" ? "Could not load Memory settings" : "Loading…"}</p></div>
		{status === "failed" ? <Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button> : <Button type="button" size="xs" variant="outline" disabled={!memories} onClick={() => setOpen(true)}>Change…</Button>}
		{open && memories && <MemoryIdentityDialog conversationId={conversation.id} participant={participant} cast={conversation.cast} memories={memories} onClose={() => setOpen(false)} onSaved={(updated) => { void identitySaved(updated); setOpen(false); }} />}
	</section>;
}
