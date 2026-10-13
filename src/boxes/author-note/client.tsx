import {
	Alert, AlertDescription, BoxBlockNotice, Button, ProseEditor, useBoxSetupDraft,
	type ConversationSummary,
} from "@/box-sdk/client";
import { authorNoteSetup } from "./contract";

export function AuthorNotePanel({ conversation, onConversationChange, disabled }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	disabled: boolean;
}) {
	const { draft, setDraft, saved, dirty, pending, notice, save, discard } = useBoxSetupDraft("author-note", authorNoteSetup, {
		conversation, disabled, onConversationChange,
		conflict: "The Chat changed elsewhere. Your draft was kept. Review the current note before saving again.",
	});
	return <div className="panel-fill overflow-y-auto p-5">
		<p className="mb-4 text-sm text-muted-foreground">Standing guidance for every branch of this Chat.</p>
		<BoxBlockNotice conversation={conversation} box="author-note" disabled={pending || disabled} className="mb-4" />
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
