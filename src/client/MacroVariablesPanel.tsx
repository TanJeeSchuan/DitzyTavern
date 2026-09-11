import { Plus, Save, Trash2 } from "lucide-react";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useMemo, useState } from "react";
import {
	editMacroVariable,
	loadMacroVariables,
	type ConversationSummary,
	type MacroVariable,
	type MacroVariables,
} from "./conversation";
import { macroValue } from "../shared/contract/macro-variables";
import type { MacroValue } from "../shared/contract/macro-variables";

const stringValue = Type.String();
import { useAsyncEffect } from "./lib/use-async";
import { PanelHeader } from "./PanelHeader";

type PanelState =
	| { status: "loading" }
	| { status: "ready"; variables: MacroVariables }
	| { status: "error"; message: string };

const errorText = (status: "not-found" | "network" | "invalid") =>
	status === "not-found"
		? "Macro Variables are no longer available for this Chat."
		: status === "invalid"
			? "This history position is not available."
			: "Macro Variables could not be loaded.";

const displayValue = (value: MacroVariable["value"]): string =>
	Value.Check(stringValue, value) ? String(value) : JSON.stringify(value) ?? "";

const sourceLabel = (variable: MacroVariable): string =>
	variable.source.type === "initial"
		? "Initial value"
		: `Message ${variable.source.messagePosition} · Variant ${variable.source.variantPosition}`;

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
	const [draftName, setDraftName] = useState("");
	const [draftValue, setDraftValue] = useState("");
	const [editing, setEditing] = useState<MacroVariable | null>(null);
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	useAsyncEffect((isCancelled) => {
		setState({ status: "loading" });
		setNotice(null);
		void loadMacroVariables(conversationId, { position }).then((outcome) => {
			if (isCancelled()) return;
			if (outcome.status === "available") {
				setState({ status: "ready", variables: outcome.variables });
				return;
			}
			setState({ status: "error", message: errorText(outcome.status) });
		});
	}, [conversationId, position]);

	const beginAdd = () => {
		setEditing(null);
		setDraftName("");
		setDraftValue("");
		setNotice(null);
	};

	const beginEdit = (variable: MacroVariable) => {
		setEditing(variable);
		setDraftName(variable.name);
		setDraftValue(displayValue(variable.value));
		setNotice(null);
	};

	const save = async () => {
		const name = draftName.trim();
		if (name === "") {
			setNotice("Enter a Macro Variable name.");
			return;
		}
		setSaving(true);
		setNotice(null);
		const original = editing;
		let value: MacroValue = draftValue;
		if (original !== null && !Value.Check(stringValue, original.value)) {
			try {
				value = Value.Decode(macroValue, JSON.parse(draftValue));
			} catch {
				setSaving(false);
				setNotice("This value must remain valid JSON.");
				return;
			}
		}
		const outcome = await editMacroVariable(conversationId, {
			expectedRevision: conversation.revision,
			promptPresetId: state.status === "ready" ? state.variables.promptPresetId : 0,
			position,
			operation: "set",
			name,
			value,
		});
		setSaving(false);
		if (outcome.status === "applied") {
			onConversationChange(outcome.conversation);
			setState({ status: "ready", variables: outcome.variables });
			setEditing(null);
			setDraftName("");
			setDraftValue("");
			return;
		}
		if (outcome.status === "conflict") onConversationChange(outcome.currentConversation);
		if (outcome.status === "invalid") setNotice(outcome.reason);
		else if (outcome.status === "conflict") setNotice("The Conversation changed elsewhere; reopen this panel to continue.");
		else setNotice(errorText(outcome.status));
	};

	const remove = async (variable: MacroVariable) => {
		if (!window.confirm(`Delete Macro Variable “${variable.name}” at this history position?`)) return;
		if (state.status !== "ready") return;
		setSaving(true);
		setNotice(null);
		const outcome = await editMacroVariable(conversationId, {
			expectedRevision: conversation.revision,
			promptPresetId: state.variables.promptPresetId,
			position,
			operation: "delete",
			name: variable.name,
		});
		setSaving(false);
		if (outcome.status === "applied") {
			onConversationChange(outcome.conversation);
			setState({ status: "ready", variables: outcome.variables });
			if (editing?.name === variable.name) beginAdd();
			return;
		}
		if (outcome.status === "conflict") onConversationChange(outcome.currentConversation);
		if (outcome.status === "invalid") setNotice(outcome.reason);
		else if (outcome.status === "conflict") setNotice("The Conversation changed elsewhere; reopen this panel to continue.");
		else setNotice(errorText(outcome.status));
	};

	return (
		<aside className="details-panel macro-variables-panel" data-open="true" aria-label="Macro Variables">
			<PanelHeader title="Macro Variables" onClose={onClose} />
			<div className="panel-body macro-variables-body">
				{state.status === "loading" && <p className="panel-note" role="status">Loading Macro Variables…</p>}
				{state.status === "error" && <p className="import-problem" role="alert">{state.message}</p>}
				{state.status === "ready" && (
					<>
						<p className="panel-note macro-variables-intro">
							{state.variables.promptPresetName} · {position === 0 ? "before the first Message" : `after Message ${position}`}
						</p>
						<label className="macro-position-field">
							<span>History position</span>
							<select value={position} onChange={(event) => setPosition(Number(event.target.value))} disabled={saving}>
								{availablePositions.map((value) => <option key={value} value={value}>{value === 0 ? "Before first Message" : `After Message ${value}`}</option>)}
							</select>
						</label>
						<section className="macro-variable-list" aria-label="Effective Macro Variables">
							{state.variables.variables.length === 0 && <p className="panel-note">No effective variables at this position.</p>}
							{state.variables.variables.map((variable) => (
								<article className="macro-variable-row" key={variable.name}>
									<div className="macro-variable-heading">
										<strong>{variable.name}</strong>
										<span>{sourceLabel(variable)}</span>
									</div>
									<pre>{displayValue(variable.value)}</pre>
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
							<label><span>Name</span><input value={draftName} onChange={(event) => setDraftName(event.target.value)} disabled={saving} readOnly={editing !== null} placeholder="variableName" /></label>
							<label><span>Value</span><textarea value={draftValue} onChange={(event) => setDraftValue(event.target.value)} disabled={saving} rows={5} placeholder="A long multiline value is supported." /></label>
							<button className="primary-button" type="submit" disabled={saving}><Plus aria-hidden="true" /> {saving ? "Saving…" : editing === null ? "Add Variable" : "Save Variable"}</button>
						</form>
						<p className="panel-note macro-variables-help">
							Edits apply only while this Variant is selected. To change a sibling's incoming state, edit the position before its target Message.
						</p>
					</>
				)}
				{notice !== null && <p className="import-problem" role="alert">{notice}</p>}
			</div>
		</aside>
	);
}
