import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function UnsavedBlockEditDialog({
	open,
	count,
	kind,
	onKeepEditing,
	onDiscard,
	onSave,
}: {
	open: boolean;
	count: number;
	kind: "close" | "select";
	onKeepEditing: () => void;
	onDiscard: () => void;
	onSave: () => Promise<void>;
}) {
	const [saving, setSaving] = useState(false);
	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) onKeepEditing(); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Unsaved block edit{count === 1 ? "" : "s"}</DialogTitle>
					<DialogDescription>
						{count === 1
							? "One block has unsaved text, name or role changes."
							: `${count} blocks have unsaved text, name or role changes.`}
						{" "}Ordering and enablement are already saved.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
					<Button variant="ghost" disabled={saving} onClick={onKeepEditing}>Keep editing</Button>
					<Button variant="outline" disabled={saving} onClick={onDiscard}>Discard</Button>
					<Button
						disabled={saving}
						onClick={() => {
							setSaving(true);
							void onSave().finally(() => setSaving(false));
						}}
					>
						{kind === "select" ? "Save and switch" : "Save and close"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
