import { Button } from "@/components/ui/button";

export function SaveFooter({ dirty, saving = false, valid = true, error = null, onSave }: {
	dirty: boolean;
	saving?: boolean;
	valid?: boolean;
	error?: string | null;
	onSave: () => void;
}) {
	return <div className="save-footer">
		<span role={error ? "alert" : "status"}>{error ?? (saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved")}</span>
		<Button type="button" size="sm" disabled={!dirty || !valid || saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</Button>
	</div>;
}
