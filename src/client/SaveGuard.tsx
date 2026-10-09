import { createContext, useCallback, useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SaveGuard = { dirty: boolean; saving?: boolean; save: () => Promise<boolean>; discard: () => void };
export const SaveGuardContext = createContext<(guard: SaveGuard | null) => void>(() => undefined);
export const SaveNavigationContext = createContext<(action: () => void) => void>((action) => action());

const SAVE_ERROR = "The changes could not be saved. Keep editing to review them.";

// Owns the guard protocol's navigation half: keeps the registered guard, tracks
// its saving state, and reduces navigation requests to the Unsaved Changes
// dialog. Guards register through SaveGuardContext; descendants request
// navigation through SaveNavigationContext.
export type SaveNavigationController = {
	registerSaveGuard: (guard: SaveGuard | null) => void;
	requestNavigation: (action: () => void) => void;
	dialogProps: ComponentProps<typeof UnsavedChangesDialog>;
};

export function useSaveNavigation(): SaveNavigationController {
	const guard = useRef<SaveGuard | null>(null);
	const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
	const [leaveSaving, setLeaveSaving] = useState(false);
	const [guardSaving, setGuardSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const registerSaveGuard = useCallback((next: SaveGuard | null) => {
		guard.current = next;
		setGuardSaving(next?.saving ?? false);
	}, []);

	const requestNavigation = (action: () => void) => {
		if (guard.current?.dirty || guard.current?.saving) { setError(null); setLeaveAction(() => action); }
		else action();
	};

	const saveAndLeave = async () => {
		const current = guard.current;
		if (current === null || leaveAction === null) return;
		if (!current.dirty) { const action = leaveAction; setLeaveAction(null); action(); return; }
		setLeaveSaving(true);
		setError(null);
		try {
			if (await current.save()) { const action = leaveAction; setLeaveAction(null); action(); }
			else setError(SAVE_ERROR);
		} catch {
			setError(SAVE_ERROR);
		} finally { setLeaveSaving(false); }
	};

	return {
		registerSaveGuard,
		requestNavigation,
		dialogProps: {
			open: leaveAction !== null,
			saving: leaveSaving || guardSaving,
			error,
			onSave: () => void saveAndLeave(),
			onDiscard: () => {
				guard.current?.discard();
				const action = leaveAction;
				setLeaveAction(null);
				action?.();
			},
			onKeepEditing: () => setLeaveAction(null),
		},
	};
}

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

export function useNavigationRequest() {
	return useContext(SaveNavigationContext);
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
