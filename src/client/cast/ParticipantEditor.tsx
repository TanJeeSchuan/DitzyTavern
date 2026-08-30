import { useState } from "react";
import {
	applyConversationCommand,
	type ConversationAction,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	emptyPrompt,
	openingsFromText,
	openingsToText,
	promptFields,
} from "./definition";

// The wording this surface shows for each standard command failure; the
// runner owns when each notice is shown, the editor owns what it says.
const EDITOR_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation could not be reached.",
	unreachable: "The Conversation could not be reached.",
};

export function ParticipantEditor({
	conversationId,
	conversation,
	participantId,
	onConversationChange,
	onNotice,
}: {
	conversationId: number;
	conversation: ConversationSummary;
	participantId: number;
	onConversationChange: (conversation: ConversationSummary) => void;
	onNotice: (notice: string | null) => void;
}) {
	const participant = conversation.cast.find(
		(candidate) => candidate.id === participantId,
	);
	const [drafts, setDrafts] = useState(() => ({
		name: participant?.name ?? "",
		prompt: participant?.prompt ?? emptyPrompt(),
		openingsText: participant ? openingsToText(participant.openings) : "",
	}));
	const [pending, setPending] = useState(false);

	if (participant === undefined) {
		return <p className="panel-note">This Participant is no longer in the Cast.</p>;
	}

	const apply = async (
		action: ConversationAction,
		section: "name" | "prompt" | "openings",
	) => {
		setPending(true);
		try {
			await runConversationCommand({
				revision: () => conversation.revision,
				send: (expectedRevision) =>
					applyConversationCommand(conversationId, expectedRevision, action),
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: onNotice,
				},
				notices: EDITOR_NOTICES,
				callbacks: {
					onApplied: (applied) => {
						// Only the edited section re-syncs its draft from the
						// authoritative snapshot; the other drafts stay as typed.
						setDrafts((current) => ({
							name:
								section === "name"
									? applied.cast.find((p) => p.id === participant.id)?.name ??
										current.name
									: current.name,
							prompt:
								section === "prompt"
									? (applied.cast.find((p) => p.id === participant.id)?.prompt ??
										current.prompt)
									: current.prompt,
							openingsText:
								section === "openings"
									? openingsToText(
											applied.cast.find((p) => p.id === participant.id)?.openings ?? [],
										)
									: current.openingsText,
						}));
						onNotice(null);
					},
					// This command family cannot produce these outcomes; the
					// server's precise reason is kept instead of a flattened class.
					onNotPlayable: (reason) => onNotice(reason),
					onNotRemovable: (reason) => onNotice(reason),
				},
			});
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="participant-editor">
			<section className="editor-section">
				<h3>Name</h3>
				<div className="apply-row">
					<input
						className="field-input"
						value={drafts.name}
						onChange={(event) =>
							setDrafts((current) => ({ ...current, name: event.target.value }))
						}
						aria-label="Participant name"
					/>
					<button
						className="secondary-button"
						type="button"
						disabled={pending || drafts.name.trim() === ""}
						onClick={() =>
							void apply(
								{
									type: "rename-participant",
									participantId: participant.id,
									name: drafts.name,
								},
								"name",
							)
						}
					>
						Apply Name
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Prompt</h3>
				<div className="definition-form">
					{promptFields.map((field) => (
						<div className="field" key={field.key}>
							<label htmlFor={`participant-prompt-${participant.id}-${field.key}`}>
								{field.label}
							</label>
							<textarea
								id={`participant-prompt-${participant.id}-${field.key}`}
								rows={2}
								value={drafts.prompt[field.key]}
								onChange={(event) =>
									setDrafts((current) => ({
										...current,
										prompt: {
											...current.prompt,
											[field.key]: event.target.value,
										},
									}))
								}
							/>
						</div>
					))}
					<button
						className="primary-button"
						type="button"
						disabled={pending}
						onClick={() =>
							void apply(
								{
									type: "replace-participant-prompt",
									participantId: participant.id,
									prompt: drafts.prompt,
								},
								"prompt",
							)
						}
					>
						Apply Prompt
					</button>
				</div>
			</section>

			<section className="editor-section">
				<h3>Openings</h3>
				<div className="definition-form">
					<div className="field">
						<label htmlFor={`participant-openings-${participant.id}`}>Openings</label>
						<textarea
							id={`participant-openings-${participant.id}`}
							rows={3}
							value={drafts.openingsText}
							onChange={(event) =>
								setDrafts((current) => ({
									...current,
									openingsText: event.target.value,
								}))
							}
						/>
						<small>One Opening per line. Editing never rewrites history.</small>
					</div>
					<button
						className="primary-button"
						type="button"
						disabled={pending}
						onClick={() =>
							void apply(
								{
									type: "replace-participant-openings",
									participantId: participant.id,
									openings: openingsFromText(drafts.openingsText),
								},
								"openings",
							)
						}
					>
						Apply Openings
					</button>
				</div>
			</section>
		</div>
	);
}

