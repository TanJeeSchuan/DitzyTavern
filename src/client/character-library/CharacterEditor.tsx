import { ArrowLeft, Check, Pin } from "lucide-react";
import { useState } from "react";
import type {
	CharacterCommand,
	CharacterSnapshot,
} from "../character-library";
import { deletionConfirmationCopy } from "../character-delete";
import {
	OpeningsField,
	PromptFields,
} from "./DefinitionFields";
import {
	openingsFromText,
	type Drafts,
} from "./definition";

export function CharacterEditor({
	snapshot,
	drafts,
	conflict,
	notice,
	pendingAction,
	onDraftChange,
	onBack,
	onCommand,
	onResolveConflict,
}: {
	snapshot: CharacterSnapshot;
	drafts: Drafts;
	conflict: CharacterSnapshot | null;
	notice: string | null;
	pendingAction: string | null;
	onDraftChange: (drafts: Drafts) => void;
	onBack: () => void;
	onCommand: (action: string, command: CharacterCommand) => Promise<void>;
	onResolveConflict: (mode: "keep-draft" | "load-current") => void;
}) {
	// Deletion requires an explicit confirmation step that states whether the
	// ==[HUMAN APPROVED]== confirmed command will hard-delete or reduce the Character to a hidden
	// tombstone, derived from the reference count presented on the snapshot.
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const deleteCopy = deletionConfirmationCopy(
		snapshot.name,
		snapshot.deletionImpact,
	);

	return (
		<div className="panel-body">
			<button className="library-back" type="button" onClick={onBack}>
				<ArrowLeft aria-hidden="true" />
				All Characters
			</button>

			{conflict !== null && (
				<div className="conflict-banner" role="alert">
					<p>
						This Character changed elsewhere after you opened it. Your edits
						were not saved and are still here.
					</p>
					<div>
						<button
							className="primary-button"
							type="button"
							onClick={() => onResolveConflict("keep-draft")}
						>
							Keep my edits
						</button>
						<button
							className="secondary-button"
							type="button"
							onClick={() => onResolveConflict("load-current")}
						>
							Load saved version
						</button>
					</div>
				</div>
			)}

			<section className="editor-section">
				<h3>Name</h3>
				<div className="apply-row">
					<input
						className="field-input"
						value={drafts.name}
						onChange={(event) =>
							onDraftChange({ ...drafts, name: event.target.value })
						}
						aria-label="Character name"
					/>
					<button
						className="secondary-button"
						type="button"
						disabled={pendingAction !== null || drafts.name.trim() === ""}
						onClick={() =>
							void onCommand("rename", {
								type: "rename",
								characterId: snapshot.id,
								expectedRevision: snapshot.revision,
								name: drafts.name,
							})
						}
					>
						Apply Name
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Presence</h3>
				<button
					className="secondary-button"
					type="button"
					disabled={pendingAction !== null}
					onClick={() =>
						void onCommand("pin", {
							type: "set-pinned",
							characterId: snapshot.id,
							expectedRevision: snapshot.revision,
							pinned: !snapshot.pinned,
						})
					}
				>
					{snapshot.pinned ? (
						<>
							<Check aria-hidden="true" /> Pinned
						</>
					) : (
						<>
							<Pin aria-hidden="true" /> Pin this Character
						</>
					)}
				</button>
			</section>

			<section className="editor-section">
				<h3>Prompt</h3>
				<div className="definition-form">
					<PromptFields
						prompt={drafts.prompt}
						onChange={(prompt) => onDraftChange({ ...drafts, prompt })}
					/>
					<button
						className="primary-button"
						type="button"
						disabled={pendingAction !== null}
						onClick={() =>
							void onCommand("prompt", {
								type: "replace-prompt",
								characterId: snapshot.id,
								expectedRevision: snapshot.revision,
								prompt: drafts.prompt,
							})
						}
					>
						Apply Prompt
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Openings</h3>
				<div className="definition-form">
					<OpeningsField
						value={drafts.openingsText}
						onChange={(openingsText) =>
							onDraftChange({ ...drafts, openingsText })
						}
					/>
					<button
						className="primary-button"
						type="button"
						disabled={pendingAction !== null}
						onClick={() =>
							void onCommand("openings", {
								type: "replace-openings",
								characterId: snapshot.id,
								expectedRevision: snapshot.revision,
								openings: openingsFromText(drafts.openingsText),
							})
						}
					>
						Apply Openings
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Delete</h3>
				<p className="panel-note">{deleteCopy.impact}</p>
				{confirmingDelete ? (
					<div className="confirm-delete-row">
						<button
							className="danger-button"
							type="button"
							disabled={pendingAction !== null}
							onClick={() => {
								setConfirmingDelete(false);
								void onCommand("delete", {
									type: "delete",
									characterId: snapshot.id,
									expectedRevision: snapshot.revision,
								});
							}}
						>
							{deleteCopy.confirmLabel}
						</button>
						<button
							className="secondary-button"
							type="button"
							disabled={pendingAction !== null}
							onClick={() => setConfirmingDelete(false)}
						>
							Cancel
						</button>
					</div>
				) : (
					<button
						className="danger-button"
						type="button"
						disabled={pendingAction !== null}
						onClick={() => setConfirmingDelete(true)}
					>
						Delete Character
					</button>
				)}
			</section>

			{notice !== null && (
				<p className="panel-note" role="status">
					{notice}
				</p>
			)}
		</div>
	);
}

