import { createContext, useContext, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SaveGuard = { dirty: boolean; saving?: boolean; save: () => Promise<boolean>; discard: () => void };
export const SaveGuardContext = createContext<(guard: SaveGuard | null) => void>(() => undefined);
export const SaveNavigationContext = createContext<(action: () => void) => void>((action) => action());
export const useSaveNavigation = () => useContext(SaveNavigationContext);

export function useSaveGuard(guard: SaveGuard) {
	const register = useContext(SaveGuardContext);
	const live = useRef(guard);
	live.current = guard;
	const registered = useRef<SaveGuard>({
		get dirty() { return live.current.dirty; },
		get saving() { return live.current.saving; },
		save: () => live.current.save(),
		discard: () => live.current.discard(),
	});
	useEffect(() => { register(registered.current); return () => register(null); }, [register]);
	useEffect(() => { register(registered.current); }, [register, guard.saving]);
}

export function UnsavedChangesDialog({ open, saving, error, onSave, onDiscard, onKeepEditing }: {
	open: boolean;
	saving: boolean;
	error: string | null;
	onSave: () => void;
	onDiscard: () => void;
	onKeepEditing: () => void;
}) {
	return <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onKeepEditing(); }}>
		<DialogContent showCloseButton={false} className="sm:max-w-sm">
			<DialogHeader><DialogTitle>Unsaved changes</DialogTitle><DialogDescription>Save your edits before leaving?</DialogDescription></DialogHeader>
			{error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<DialogFooter>
				<Button type="button" variant="ghost" disabled={saving} onClick={onKeepEditing}>Keep editing</Button>
				<Button type="button" variant="destructive" disabled={saving} onClick={onDiscard}>Discard</Button>
				<Button type="button" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save and leave"}</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>;
}
