import { useState } from "react";
import { Button } from "@/components/ui/button";
import { applyConversationCommand, type ConversationSummary } from "./conversation";
import { runConversationCommand } from "./conversation-command-runner";
import { CONVERSATION_UNREACHABLE_NOTICE } from "./lib/command-outcome";
import { ProseEditor } from "./editor/ProseEditor";
import { useSaveGuard } from "./SaveGuard";

export function AuthorNotePanel({ conversation, onConversationChange, disabled }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	disabled: boolean;
}) {
	const [draft, setDraft] = useState(conversation.authorNote);
	const [expectedRevision, setExpectedRevision] = useState(conversation.revision);
	const [saved, setSaved] = useState(conversation.authorNote);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const dirty = draft !== saved;
	const save = async (): Promise<boolean> => {
		if (pending || disabled) return false;
		setPending(true);
		setNotice(null);
		let applied = false;
		try {
			await runConversationCommand({
				revision: () => expectedRevision,
				send: (revision) => applyConversationCommand(conversation.id, revision, { type: "set-author-note", content: draft }),
				reconciliation: { adoptSnapshot: onConversationChange, showNotice: setNotice },
				notices: { conflict: "The Chat changed elsewhere. Your draft was kept. Review the current note before saving again.", notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
				callbacks: {
					onApplied: (current) => { setExpectedRevision(current.revision); setSaved(current.authorNote); applied = true; },
					onConflict: (current) => { setExpectedRevision(current.revision); setSaved(current.authorNote); },
					onNotPlayable: setNotice,
					onNotRemovable: setNotice,
				},
			});
		} finally { setPending(false); }
		return applied;
	};
	const discard = () => { setDraft(conversation.authorNote); setSaved(conversation.authorNote); setExpectedRevision(conversation.revision); setNotice(null); };
	useSaveGuard({ dirty, saving: pending, save, discard });
	return <div className="panel-fill overflow-y-auto p-5">
		<p className="mb-4 text-sm text-muted-foreground">Standing guidance for every branch of this Chat.</p>
		<ProseEditor value={draft} onChange={setDraft} ariaLabel="Author Note text" placeholder="Write guidance for future Generations…" disabled={pending || disabled} className="prose-editor-field h-56" />
		{notice !== null && <div className="mt-3 text-sm" role="alert">
			<p>{notice}</p>
			{saved !== draft && <><p className="mt-2 text-muted-foreground">Current saved note</p><pre className="mt-1 whitespace-pre-wrap font-inherit">{saved || "Empty"}</pre></>}
		</div>}
		<div className="mt-4 flex items-center justify-between gap-2">
			<Button variant="ghost" disabled={pending || disabled || draft === ""} onClick={() => setDraft("")}>Clear</Button>
			<Button disabled={pending || disabled || !dirty} onClick={() => void save()}>{pending ? "Saving…" : "Save Author Note"}</Button>
		</div>
		{notice !== null && <Button className="mt-2" variant="ghost" disabled={pending} onClick={discard}>Load saved note</Button>}
	</div>;
}
