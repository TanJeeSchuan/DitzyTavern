import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/select";
import {
	editMacroVariable,
	loadMacroVariables,
	type ConversationSummary,
	type MacroVariable,
	type MacroVariables,
} from "./conversation";
import { isMacroValue } from "../shared/contract/macro-variables";
import type { MacroValue } from "../shared/contract/macro-variables";
import { useAsyncEffect } from "./lib/use-async";
import { ProseEditor } from "./editor/ProseEditor";
import { projectImageAnchors } from "../shared/image-reference";
import { PanelHeader } from "./PanelHeader";

type PanelState =
	| { status: "loading" }
	| { status: "ready"; variables: MacroVariables }
	| { status: "error"; message: string };

const errorText = (outcome: "not-found" | "network" | "invalid") =>
	outcome === "not-found"
		? "Macro Variables are no longer available for this Chat."
		: outcome === "invalid"
			? "This history position is not available."
			: "Macro Variables could not be loaded.";

const isStringMacroValue = (value: MacroValue): value is string => typeof value === "string";

const displayValue = (value: MacroVariable["value"]): string =>
	isStringMacroValue(value) ? value : JSON.stringify(value) ?? "";

const sourceLabel = (variable: MacroVariable): string =>
	variable.source.type === "initial"
		? "Initial value"
		: `Message ${variable.source.messagePosition} · Variant ${variable.source.variantPosition}`;

type MutationOutcome = Awaited<ReturnType<typeof editMacroVariable>>;

export function handleMacroVariableOutcome(
	outcome: MutationOutcome,
	callbacks: {
		onApplied: (variables: MacroVariables, conversation: ConversationSummary) => void;
		onConflict: (conversation: ConversationSummary) => void;
		onNotice: (notice: string) => void;
	},
): boolean {
	if (outcome.outcome === "available") {
		callbacks.onApplied(outcome.value.variables, outcome.value.conversation);
		return true;
	}
	if (outcome.outcome === "conflict") callbacks.onConflict(outcome.currentConversation);
	callbacks.onNotice(
		outcome.outcome === "invalid"
			? outcome.reason
			: outcome.outcome === "conflict"
				? "The Conversation changed elsewhere; reopen this panel to continue."
				: outcome.outcome === "not-found"
					? "Macro Variables are no longer available for this Chat."
					: "Macro Variables could not be changed.",
	);
	return false;
}

export function MacroVariablesPanel({
	conversationId,
	conversation,
	historyPositions,
	onConversationChange,
	onClose,
}: {
	conversationId: number;
	conversation: ConversationSummary;
	historyPositions: readonly number[];
	onConversationChange: (conversation: ConversationSummary | null) => void;
	onClose: () => void;
}) {
	const availablePositions = useMemo(
		() => [...new Set([0, ...historyPositions])].sort((left, right) => left - right),
		[historyPositions],
	);
	const [position, setPosition] = useState(() => Math.max(0, ...historyPositions));
	const [state, setState] = useState<PanelState>({ status: "loading" });
	const [notice, setNotice] = useState<string | null>(null);

	useAsyncEffect((isCancelled) => {
		setState({ status: "loading" });
		setNotice(null);
		void loadMacroVariables(conversationId, { position }).then((outcome) => {
			if (isCancelled()) return;
			if (outcome.outcome === "available") {
				setState({ status: "ready", variables: outcome.value });
				return;
			}
			setState({ status: "error", message: errorText(outcome.outcome) });
		});
	}, [conversationId, position]);

	return (
		<aside className="details-panel macro-variables-panel" data-open="true" aria-label="Macro Variables">
			<PanelHeader title="Macro Variables" onClose={onClose} />
			<div className="panel-body macro-variables-body">
				{state.status === "loading" && <p className="panel-note" role="status">Loading Macro Variables…</p>}
				{state.status === "error" && <p className="import-problem" role="alert">{state.message}</p>}
				{state.status === "ready" && (
					<MacroVariablesReadyView
						conversationId={conversationId}
						conversation={conversation}
						variables={state.variables}
						position={position}
						availablePositions={availablePositions}
						onPositionChange={setPosition}
						onConversationChange={onConversationChange}
						onVariablesChange={(variables) => setState({ status: "ready", variables })}
						onNotice={setNotice}
					/>
				)}
				{notice !== null && <p className="import-problem" role="alert">{notice}</p>}
			</div>
		</aside>
	);
}

export function MacroVariablesReadyView({
	conversationId,
	conversation,
	variables,
	position,
	availablePositions,
	onPositionChange,
	onConversationChange,
	onVariablesChange,
	onNotice,
}: {
	conversationId: number;
	conversation: ConversationSummary;
	variables: MacroVariables;
	position: number;
	availablePositions: readonly number[];
	onPositionChange: (position: number) => void;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	onVariablesChange: (variables: MacroVariables) => void;
	onNotice: (notice: string | null) => void;
}) {
	const [draftName, setDraftName] = useState("");
	const [nameError, setNameError] = useState(false);
	const [draftValue, setDraftValue] = useState("");
	const [editing, setEditing] = useState<MacroVariable | null>(null);
	const [saving, setSaving] = useState(false);

	const beginAdd = () => {
		setEditing(null);
		setDraftName("");
		setNameError(false);
		setDraftValue("");
		onNotice(null);
	};

	useEffect(() => {
		setEditing(null);
		setDraftName("");
		setNameError(false);
		setDraftValue("");
		onNotice(null);
	}, [position, variables.promptPresetId]);

	const beginEdit = (variable: MacroVariable) => {
		setEditing(variable);
		setDraftName(variable.name);
		setNameError(false);
		setDraftValue(displayValue(variable.value));
		onNotice(null);
	};

	const settle = (outcome: MutationOutcome) => handleMacroVariableOutcome(outcome, {
		onApplied: (nextVariables, nextConversation) => {
			onConversationChange(nextConversation);
			onVariablesChange(nextVariables);
		},
		onConflict: onConversationChange,
		onNotice,
	});

	const save = async () => {
		const name = draftName.trim();
		if (name === "") {
			setNameError(true);
			return;
		}
		setSaving(true);
		onNotice(null);
		const original = editing;
		let value: MacroValue = draftValue;
		if (original !== null && !isStringMacroValue(original.value)) {
			try {
				const parsed: unknown = JSON.parse(draftValue);
				if (!isMacroValue(parsed)) throw new Error("invalid macro value");
				value = parsed;
			} catch {
				setSaving(false);
				onNotice("This value must remain valid JSON.");
				return;
			}
		}
		const outcome = await editMacroVariable(conversationId, {
			expectedRevision: conversation.revision,
			promptPresetId: variables.promptPresetId,
			position,
			operation: "set",
			name,
			value,
		});
		setSaving(false);
		if (settle(outcome)) beginAdd();
	};

	const remove = async (variable: MacroVariable) => {
		if (!window.confirm(`Delete Macro Variable “${variable.name}” at this history position?`)) return;
		setSaving(true);
		onNotice(null);
		const outcome = await editMacroVariable(conversationId, {
			expectedRevision: conversation.revision,
			promptPresetId: variables.promptPresetId,
			position,
			operation: "delete",
			name: variable.name,
		});
		setSaving(false);
		if (settle(outcome) && editing?.name === variable.name) beginAdd();
	};

	return (
		<>
			<p className="panel-note macro-variables-intro">
				{variables.promptPresetName} · {position === 0 ? "before the first Message" : `after Message ${position}`}
			</p>
			<label className="macro-position-field">
				<span>History position</span>
				<AppSelect
					value={position}
					onValueChange={(value) => onPositionChange(Number(value))}
					disabled={saving}
					options={availablePositions.map((value) => ({
						value,
						label: value === 0 ? "Before first Message" : `After Message ${value}`,
					}))}
				/>
			</label>
			<section className="macro-variable-list" aria-label="Effective Macro Variables">
				{variables.variables.length === 0 && <p className="panel-note">No effective variables at this position.</p>}
				{variables.variables.map((variable) => (
					<article className="macro-variable-row" key={variable.name}>
						<div className="macro-variable-heading">
							<strong>{variable.name}</strong>
							<span>{sourceLabel(variable)}</span>
						</div>
						<pre>{projectImageAnchors(displayValue(variable.value))}</pre>
						<div className="macro-variable-actions">
							<button className="edit-action" type="button" onClick={() => beginEdit(variable)} disabled={saving}><Save aria-hidden="true" /> Edit</button>
							<button className="edit-action" type="button" onClick={() => void remove(variable)} disabled={saving}><Trash2 aria-hidden="true" /> Delete</button>
						</div>
					</article>
				))}
			</section>
			<form className="macro-variable-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
				<div className="macro-editor-heading">
					<h3>{editing === null ? "Add Variable" : `Edit ${editing.name}`}</h3>
					{editing !== null && <button className="edit-action" type="button" onClick={beginAdd} disabled={saving}>Cancel</button>}
				</div>
				<label>
					<span>Name</span>
					<input
						value={draftName}
						onChange={(event) => {
							setDraftName(event.target.value);
							setNameError(false);
						}}
						aria-invalid={nameError}
						aria-describedby={nameError ? "macro-name-error" : undefined}
						disabled={saving}
						readOnly={editing !== null}
						placeholder="variableName"
					/>
					{nameError && (
						<small id="macro-name-error" className="field-error" role="alert">Enter a Macro Variable name.</small>
					)}
				</label>
				<div className="macro-value-field">
					<span>Value</span>
					<ProseEditor
						className="macro-value-editor"
						ariaLabel="Value"
						value={draftValue}
						onChange={setDraftValue}
						disabled={saving}
						placeholder="A long multiline value is supported."
					/>
				</div>
				<button className="primary-button" type="submit" disabled={saving}><Plus aria-hidden="true" /> {saving ? "Saving…" : editing === null ? "Add Variable" : "Save Variable"}</button>
			</form>
			<p className="panel-note macro-variables-help">
				Edits apply only while this Variant is selected. To change a sibling's incoming state, edit the position before its target Message.
			</p>
		</>
	);
}
