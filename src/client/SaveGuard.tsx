import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SaveGuard = { dirty: boolean; saving?: boolean; save: () => Promise<boolean>; discard: () => void };
export const SaveGuardContext = createContext<(guard: SaveGuard) => () => void>(() => () => undefined);
export const SaveNavigationContext = createContext<(action: () => void) => void>((action) => action());

const SAVE_ERROR = "The changes could not be saved. Keep editing to review them.";

// @approved
// Owns the guard protocol's navigation half: keeps the registered guards,
// tracks their saving state, and reduces navigation requests to the Unsaved
// Changes dialog. Floating windows and panels can hold unsaved edits at the
// same time, so every mounted guard participates.
export type SaveNavigationController = {
	registerSaveGuard: (guard: SaveGuard) => () => void;
	requestNavigation: (action: () => void) => void;
	dialogProps: ComponentProps<typeof UnsavedChangesDialog>;
};

export function useSaveNavigation(): SaveNavigationController {
	const guards = useRef(new Set<SaveGuard>());
	const [, bumpGuards] = useReducer((count: number) => count + 1, 0);
	const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
	const [leaveSaving, setLeaveSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const registerSaveGuard = useCallback((guard: SaveGuard) => {
		guards.current.add(guard);
		bumpGuards();
		return () => { guards.current.delete(guard); bumpGuards(); };
	}, []);

	const requestNavigation = (action: () => void) => {
		if ([...guards.current].some((guard) => guard.dirty || guard.saving)) { setError(null); setLeaveAction(() => action); }
		else action();
	};

	const saveAndLeave = async () => {
		if (leaveAction === null) return;
		const dirty = [...guards.current].filter((guard) => guard.dirty);
		if (dirty.length === 0) { const action = leaveAction; setLeaveAction(null); action(); return; }
		setLeaveSaving(true);
		setError(null);
		try {
			for (const guard of dirty) if (!(await guard.save())) { setError(SAVE_ERROR); return; }
			const action = leaveAction;
			setLeaveAction(null);
			action();
		} catch {
			setError(SAVE_ERROR);
		} finally { setLeaveSaving(false); }
	};

	return {
		registerSaveGuard,
		requestNavigation,
		dialogProps: {
			open: leaveAction !== null,
			saving: leaveSaving || [...guards.current].some((guard) => guard.saving),
			error,
			onSave: () => void saveAndLeave(),
			onDiscard: () => {
				for (const guard of guards.current) guard.discard();
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
	useEffect(() => register(registered.current), [register, guard.saving]);
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
