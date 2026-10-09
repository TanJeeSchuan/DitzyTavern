import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { saveMemoryNote, type ConversationMemoryAllowance } from "../memories";

const LIMIT = 2_000;
const COUNT_AT = 1_800;

export function MemoryNoteDialog({ conversationId, settings, onClose, onSettings, onSaved }: {
	conversationId: number;
	settings: ConversationMemoryAllowance;
	onClose: () => void;
	onSettings: (settings: ConversationMemoryAllowance) => void;
	onSaved: () => void;
}) {
	const [note, setNote] = useState(settings.note);
	const [revision, setRevision] = useState(settings.revision);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const length = note.trim().length;
	const overLimit = length > LIMIT;
	const save = async () => {
		if (pending || overLimit) return;
		setPending(true); setError(null);
		try {
			const result = await saveMemoryNote(conversationId, revision, note);
			if (result.outcome === "available") { onSettings(result.value.settings); onSaved(); }
			else if (result.outcome === "conflict") {
				onSettings(result.currentSettings); setRevision(result.currentSettings.revision);
				setError(
					result.currentSettings.note === settings.note
						? "Memory settings changed elsewhere. Save again to keep this note."
						: "The note changed elsewhere. Saving again replaces it with this text.",
				);
			}
			else setError(result.outcome === "invalid" ? result.reason : "The Memory note could not be saved. Try again.");
		} catch { setError("The Memory note could not be saved. Try again."); }
		finally { setPending(false); }
	};
	const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); } };
	return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
		<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!pending}>
			<DialogHeader>
				<DialogTitle>Memory note</DialogTitle>
				<DialogDescription>Used for new extraction. Saved Memories keep their wording until you retry a Message.</DialogDescription>
			</DialogHeader>
			<form className="memory-merge-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
				<Textarea
					autoFocus
					aria-label="Memory note"
					className="memory-editor-claim"
					placeholder="Write guidance for new extraction…"
					value={note}
					onChange={(event) => setNote(event.target.value)}
					onKeyDown={onKeyDown}
					disabled={pending}
				/>
				{length >= COUNT_AT && <p className={overLimit ? "text-xs text-destructive" : "text-xs text-muted-foreground"} aria-live="polite">{length} of 2,000 characters</p>}
				{error && <p className="import-problem" role="alert">{error}</p>}
				<DialogFooter>
					<span className="text-xs text-muted-foreground sm:mr-auto">Ctrl+Enter saves · Esc cancels</span>
					<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
					<Button type="submit" disabled={pending || overLimit || note.trim() === settings.note}>{pending ? "Saving…" : "Save"}</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	</Dialog>;
}
