import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type SaveGuard = {
	dirty: boolean;
	chatDraft?: boolean;
	saving?: boolean;
	canSave?: boolean;
	save?: () => Promise<boolean>;
	waitAfterSave?: () => Promise<void>;
	discard: () => void;
};
type RegisteredGuard = SaveGuard & { readonly scope?: string };
export const SaveGuardContext = createContext<(guard: RegisteredGuard) => () => void>(() => () => undefined);
export const SaveGuardScope = createContext<string | undefined>(undefined);
export const SaveNavigationContext = createContext<(action: () => void, scope?: string) => void>((action) => action());

const chatLeave = Symbol("chat leave");
export type CommitNavigation = (navigate: () => void) => void;
type LeaveAction = (commit: CommitNavigation) => void;
const commitNavigation: CommitNavigation = (navigate) => navigate();

const SAVE_ERROR = "The changes could not be saved. Keep editing to review them.";

// @approved
// Owns the guard protocol's navigation half: keeps the registered guards,
// tracks their saving state, and reduces navigation requests to the Unsaved
// Changes dialog. Leaving a Chat checks all guards. Unscoped navigation skips
// Chat drafts, and scoped navigation checks only guards with the matching scope.
// Discard takes effect when the approved action calls commit.
export type SaveNavigationController = {
	registerSaveGuard: (guard: RegisteredGuard) => () => void;
	requestNavigation: (action: () => void, scope?: string) => void;
	requestChatLeave: (action: LeaveAction) => void;
	dialogProps: ComponentProps<typeof UnsavedChangesDialog>;
};

export function useSaveNavigation(): SaveNavigationController {
	const guards = useRef(new Set<RegisteredGuard>());
	const [, bumpGuards] = useReducer((count: number) => count + 1, 0);
	const [leave, setLeave] = useState<{ action: LeaveAction; scope?: string | typeof chatLeave } | null>(null);
	const [leaveSaving, setLeaveSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const registerSaveGuard = useCallback((guard: RegisteredGuard) => {
		guards.current.add(guard);
		bumpGuards();
		return () => { guards.current.delete(guard); bumpGuards(); };
	}, []);

	const guardsIn = useCallback((scope?: string | typeof chatLeave) => [...guards.current].filter((guard) =>
		scope === chatLeave || (scope === undefined ? !guard.chatDraft : guard.scope === scope)
	), []);
	const requestLeave = useCallback((action: LeaveAction, scope?: string | typeof chatLeave) => {
		if (guardsIn(scope).some((guard) => guard.dirty || guard.saving)) { setError(null); setLeave({ action, scope }); }
		else action(commitNavigation);
	}, [guardsIn]);
	/** @approved A stable context value keeps stream updates from re-rendering every navigation consumer. */
	const requestNavigation = useCallback((action: () => void, scope?: string) => {
		requestLeave((commit) => commit(action), scope);
	}, [requestLeave]);

	const saveAndLeave = async () => {
		if (leave === null) return;
		const dirty = guardsIn(leave.scope).filter((guard) => guard.dirty);
		if (dirty.some((guard) => guard.save === undefined || guard.canSave === false)) return;
		if (dirty.length === 0) { setLeave(null); leave.action(commitNavigation); return; }
		setLeaveSaving(true);
		setError(null);
		try {
			for (const [index, guard] of dirty.entries()) {
				if (!(await guard.save?.())) { setError(SAVE_ERROR); return; }
				if (index < dirty.length - 1) await guard.waitAfterSave?.();
			}
			setLeave(null);
			leave.action(commitNavigation);
		} catch {
			setError(SAVE_ERROR);
		} finally { setLeaveSaving(false); }
	};

	const affected = leave === null ? [] : guardsIn(leave.scope);
	return {
		registerSaveGuard,
		requestNavigation,
		requestChatLeave: (action) => requestLeave(action, chatLeave),
		dialogProps: {
			open: leave !== null,
			saving: leaveSaving || affected.some((guard) => guard.saving),
			canSave: !affected.some((guard) => guard.dirty && guard.canSave === false),
			error,
			onSave: affected.some((guard) => guard.dirty && guard.save === undefined) ? undefined : () => void saveAndLeave(),
			onDiscard: () => {
				if (leave === null) return;
				const approved = guardsIn(leave.scope);
				setLeave(null);
				leave.action((navigate) => {
					for (const guard of approved) if (guards.current.has(guard)) guard.discard();
					commitNavigation(navigate);
				});
			},
			onKeepEditing: () => setLeave(null),
		},
	};
}

export function useSaveGuard(guard: SaveGuard, scopeOverride?: string) {
	const register = useContext(SaveGuardContext);
	const inheritedScope = useContext(SaveGuardScope);
	const scope = scopeOverride ?? inheritedScope;
	const live = useRef<RegisteredGuard>({ ...guard, scope });
	live.current = { ...guard, scope };
	const hasSave = guard.save !== undefined;
	const registered = useRef<RegisteredGuard>({
		get scope() { return live.current.scope; },
		get chatDraft() { return live.current.chatDraft; },
		get dirty() { return live.current.dirty; },
		get saving() { return live.current.saving; },
		get canSave() { return live.current.canSave; },
		get waitAfterSave() { return live.current.waitAfterSave; },
		get save() { return live.current.save; },
		discard: () => live.current.discard(),
	});
	useEffect(() => register(registered.current), [register, guard.saving, guard.canSave, hasSave]);
}

export function useNavigationRequest() {
	return useContext(SaveNavigationContext);
}

export function UnsavedChangesDialog({ open, saving, canSave, error, onSave, onDiscard, onKeepEditing }: {
	open: boolean;
	saving: boolean;
	canSave: boolean;
	error: string | null;
	onSave: (() => void) | undefined;
	onDiscard: () => void;
	onKeepEditing: () => void;
}) {
	return <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onKeepEditing(); }}>
		<DialogContent showCloseButton={false} className="sm:max-w-sm">
			<DialogHeader>
				<DialogTitle>Unsaved changes</DialogTitle>
				<DialogDescription>{onSave === undefined ? "Discard your edits and leave?" : "Save your edits before leaving?"}</DialogDescription>
			</DialogHeader>
			{error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<DialogFooter>
				<Button type="button" variant="ghost" autoFocus disabled={saving} onClick={onKeepEditing}>Keep editing</Button>
				<Button type="button" variant="destructive" disabled={saving} onClick={onDiscard}>Discard</Button>
				{onSave !== undefined && <Button type="button" disabled={saving || !canSave} onClick={onSave}>{saving ? "Saving…" : "Save and leave"}</Button>}
			</DialogFooter>
		</DialogContent>
	</Dialog>;
}
