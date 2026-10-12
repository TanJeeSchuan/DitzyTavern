import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loadConversationPromptPreset, type ConversationSummary } from "./conversation";
import { ProseEditor } from "./editor/ProseEditor";
import { useBoxSetupDraft } from "./box-windows/useBoxSetupDraft";
import { addPromptPresetReference, setPromptPresetBlockEnabled } from "./prompt-preset-library";

export function AuthorNotePanel({ conversation, onConversationChange, disabled }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	disabled: boolean;
}) {
	const client = useQueryClient();
	const preset = useQuery({ queryKey: ["conversation-preset", conversation.id], queryFn: ({ signal }) => loadConversationPromptPreset(conversation.id, signal) });
	const selectedPreset = preset.data;
	const slot = selectedPreset?.slots.find((slot) => slot.reference === "box:author-note");
	const activate = useMutation({
		mutationFn: async () => {
			if (!selectedPreset || preset.isFetching || preset.isError) return;
			const outcome = slot === undefined
				? await addPromptPresetReference(selectedPreset.id, "box:author-note")
				: await setPromptPresetBlockEnabled(selectedPreset.id, slot.id, true);
			if (outcome.outcome !== "available") throw new Error(outcome.outcome === "invalid" || outcome.outcome === "unusable" ? outcome.reason : "The Author Note block could not be updated.");
		},
		onSuccess: () => client.invalidateQueries({ queryKey: ["conversation-preset"] }),
	});
	const { draft, setDraft, saved, dirty, pending, notice, save, discard } = useBoxSetupDraft("author-note", {
		conversation, disabled, onConversationChange,
		conflict: "The Chat changed elsewhere. Your draft was kept. Review the current note before saving again.",
	});
	return <div className="panel-fill overflow-y-auto p-5">
		<p className="mb-4 text-sm text-muted-foreground">Standing guidance for every branch of this Chat.</p>
		{conversation.boxSetups["author-note"].trim() !== "" && selectedPreset && !slot?.enabled && <Alert className="mb-4">
			<AlertDescription>The selected Prompt Preset has no enabled Author Note block, so this note is not sent to the model.</AlertDescription>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="mt-2 w-fit"
				disabled={pending || disabled || activate.isPending || preset.isFetching || preset.isError}
				onClick={() => activate.mutate()}
			>
				{slot === undefined ? "Add Author Note Block" : "Enable Author Note Block"}
			</Button>
		</Alert>}
		{preset.isError && <Alert variant="destructive" className="mb-3"><AlertDescription>The selected Prompt Preset could not be loaded.</AlertDescription></Alert>}
		{activate.isError && <Alert variant="destructive" className="mb-3"><AlertDescription>{activate.error.message}</AlertDescription></Alert>}
		<ProseEditor
			value={draft}
			onChange={setDraft}
			ariaLabel="Author Note text"
			placeholder="Write guidance for future Generations…"
			disabled={pending || disabled}
			className="prose-editor-field h-56"
		/>
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
