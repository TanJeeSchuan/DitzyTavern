import "./client.css";
import {
	Alert, AlertDescription, BoxBlockNotice, Button, ProseEditor, useBoxSetupDraft,
	type BoxClientDefinition, type ConversationSummary,
} from "@/box-sdk/client";
import { NotebookPen } from "lucide-react";
import { authorNoteSetup } from "./contract";
import descriptor from "./shared-descriptor";

function AuthorNotePanel({ conversation, onConversationChange, disabled }: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	disabled: boolean;
}) {
	const { draft, setDraft, saved, dirty, pending, notice, save, discard } = useBoxSetupDraft("author-note", authorNoteSetup, {
		conversation, disabled, onConversationChange,
		conflict: "The Chat changed elsewhere. Your draft was kept. Review the current note before saving again.",
	});
	return <div className="panel-fill author-note-panel">
		<p className="author-note-lead">Standing guidance for every branch of this Chat.</p>
		<BoxBlockNotice conversation={conversation} box="author-note" disabled={pending || disabled} className="author-note-block" />
		<ProseEditor
			value={draft}
			onChange={setDraft}
			ariaLabel="Author Note text"
			placeholder="Write guidance for future Generations…"
			disabled={pending || disabled}
			className="prose-editor-field author-note-editor"
		/>
		{notice !== null && <Alert className="author-note-notice"><AlertDescription>
			<p>{notice}</p>
			{saved !== draft && <><p className="author-note-saved-label">Current saved note</p><pre className="author-note-saved">{saved || "Empty"}</pre></>}
		</AlertDescription></Alert>}
		<div className="author-note-actions">
			<Button variant="ghost" disabled={pending || disabled || draft === ""} onClick={() => setDraft("")}>Clear</Button>
			<Button disabled={pending || disabled || !dirty} onClick={() => void save()}>{pending ? "Saving…" : "Save Author Note"}</Button>
		</div>
		{notice !== null && <Button className="author-note-load" variant="ghost" disabled={pending} onClick={discard}>Load saved note</Button>}
	</div>;
}

export default { descriptor, icon: NotebookPen, PrimaryPanel: AuthorNotePanel } satisfies BoxClientDefinition;
