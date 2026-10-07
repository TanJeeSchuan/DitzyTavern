import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { applyConversationCommand, loadConversationPromptPreset, type ConversationSummary } from "./conversation";
import { runConversationCommand } from "./conversation-command-runner";
import { CONVERSATION_UNREACHABLE_NOTICE } from "./lib/command-outcome";
import { ProseEditor } from "./editor/ProseEditor";
import { useSaveGuard } from "./SaveGuard";
import { addPromptPresetReference, setPromptPresetBlockEnabled } from "./prompt-preset-library";

export function AuthorNotePanel({ conversation, onConversationChange, disabled }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	disabled: boolean;
}) {
	const client = useQueryClient();
	const preset = useQuery({ queryKey: ["conversation-preset", conversation.id], queryFn: ({ signal }) => loadConversationPromptPreset(conversation.id, signal) });
	const selectedPreset = preset.data;
	const slot = selectedPreset?.slots.find((slot) => slot.reference === "author-note");
	const activate = useMutation({
		mutationFn: async () => {
			if (!selectedPreset || preset.isFetching || preset.isError) return;
			const outcome = slot === undefined
				? await addPromptPresetReference(selectedPreset.id, "author-note")
				: await setPromptPresetBlockEnabled(selectedPreset.id, slot.id, true);
			if (outcome.status !== "applied") throw new Error(outcome.status === "invalid" ? outcome.reason : "The Author Note block could not be updated.");
		},
		onSuccess: () => client.invalidateQueries({ queryKey: ["conversation-preset"] }),
	});
	const [draft, setDraft] = useState(conversation.authorNote);
	const [expectedRevision, setExpectedRevision] = useState(conversation.revision);
	const [saved, setSaved] = useState(conversation.authorNote);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	if (conversation.revision > expectedRevision && conversation.authorNote === saved) setExpectedRevision(conversation.revision);
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
		{conversation.authorNote.trim() !== "" && selectedPreset && !slot?.enabled && <Alert className="mb-4">
			<AlertDescription>The selected Prompt Preset has no enabled Author Note block, so this note is not sent to the model.</AlertDescription>
			<Button type="button" size="sm" variant="outline" className="mt-2 w-fit" disabled={pending || disabled || activate.isPending || preset.isFetching || preset.isError} onClick={() => activate.mutate()}>{slot === undefined ? "Add Author Note Block" : "Enable Author Note Block"}</Button>
		</Alert>}
		{preset.isError && <Alert variant="destructive" className="mb-3"><AlertDescription>The selected Prompt Preset could not be loaded.</AlertDescription></Alert>}
		{activate.isError && <Alert variant="destructive" className="mb-3"><AlertDescription>{activate.error.message}</AlertDescription></Alert>}
		<ProseEditor value={draft} onChange={setDraft} ariaLabel="Author Note text" placeholder="Write guidance for future Generations…" disabled={pending || disabled} className="prose-editor-field h-56" />
		{notice !== null && <Alert className="mt-3"><AlertDescription>
			<p>{notice}</p>
			{saved !== draft && <><p className="mt-2 text-muted-foreground">Current saved note</p><pre className="mt-1 whitespace-pre-wrap font-inherit">{saved || "Empty"}</pre></>}
		</AlertDescription></Alert>}
		<div className="mt-4 flex items-center justify-between gap-2">
			<Button variant="ghost" disabled={pending || disabled || draft === ""} onClick={() => setDraft("")}>Clear</Button>
			<Button disabled={pending || disabled || !dirty} onClick={() => void save()}>{pending ? "Saving…" : "Save Author Note"}</Button>
		</div>
		{notice !== null && <Button className="mt-2" variant="ghost" disabled={pending} onClick={discard}>Load saved note</Button>}
	</div>;
}
