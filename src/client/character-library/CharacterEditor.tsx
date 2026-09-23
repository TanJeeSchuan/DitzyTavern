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
	openingsToText,
	type Drafts,
} from "./definition";
import { LoreAttachmentEditor } from "../lorebook/LoreAttachmentEditor";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard, useSaveNavigation } from "../SaveGuard";

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
	onCommand: (action: string, command: CharacterCommand) => Promise<boolean>;
	onResolveConflict: (mode: "keep-draft" | "load-current") => void;
}) {
	// Deletion requires an explicit confirmation step that states whether the
	// ==[HUMAN APPROVED]== confirmed command will hard-delete or reduce the Character to a hidden
	// tombstone, derived from the reference count presented on the snapshot.
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const dirty = drafts.name !== snapshot.name || JSON.stringify(drafts.prompt) !== JSON.stringify(snapshot.prompt) || drafts.openingsText !== openingsToText(snapshot.openings);
	const navigate = useSaveNavigation();
	const save = () => onCommand("save", { type: "update-definition", characterId: snapshot.id, expectedRevision: snapshot.revision, definition: { name: drafts.name, prompt: drafts.prompt, openings: drafts.openingsText === openingsToText(snapshot.openings) ? snapshot.openings : openingsFromText(drafts.openingsText) } });
	useSaveGuard({ dirty, saving: pendingAction === "save", save, discard: () => undefined });
	const deleteCopy = deletionConfirmationCopy(
		snapshot.name,
		snapshot.deletionImpact,
	);

	return (
		<div className="editor-frame">
		<div className="panel-body">
			<button className="library-back" type="button" onClick={() => navigate(onBack)}>
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
				</div>
			</section>

			<LoreAttachmentEditor owner="character" ownerId={snapshot.id} disabled={pendingAction !== null} />

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
		<SaveFooter dirty={dirty} saving={pendingAction === "save"} valid={drafts.name.trim().length > 0 && conflict === null} error={notice} onSave={() => void save()} />
		</div>
	);
}
