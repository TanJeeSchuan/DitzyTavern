import { Plus } from "lucide-react";
import { useState } from "react";
import { type CharacterSummary, listCharacters } from "./character-library";
import {
	createNativeConversation,
	emptySeatDraft,
	type SeatDraft,
} from "./new-chat";
import type { PromptChannels } from "../shared/contract/prompt-schema";
import { promptChannelFields } from "../shared/definition";
import { openingsFromText } from "./lib/openings";
import { useAsyncEffect } from "./lib/use-async";

// Native New Chat setup: the human and model seats are configured side by
// side, each either forking a library Character or authored ad hoc, and both
// Control assignments are explicit before commit. A native Conversation is
// only created once both seats are complete.

interface SeatEditorProps {
	role: "human" | "model";
	seat: SeatDraft;
	onChange: (seat: SeatDraft) => void;
	characters: CharacterSummary[];
}

function SeatEditor({ role, seat, onChange, characters }: SeatEditorProps) {
	const roleLabel = role === "human" ? "Writing as" : "Responding as";
	const seatLabel = role === "human" ? "Human" : "Model";
	const mode = seat.type;

	const switchMode = (nextMode: "character" | "adhoc") => {
		if (nextMode === mode) return;
		if (nextMode === "adhoc") {
			onChange(emptySeatDraft());
			return;
		}
		const first = characters[0];
		onChange(
			first
				? { type: "character", characterId: first.id, expectedRevision: first.revision }
				: emptySeatDraft(),
		);
	};

	return (
		<section className="seat-editor" data-seat={role}>
			<header className="seat-editor-header">
				<span className="seat-role">{roleLabel}</span>
				<strong>{seatLabel}</strong>
			</header>

			<div className="seat-mode" role="tablist" aria-label={`${seatLabel} seat source`}>
				<button
					type="button"
					data-active={mode === "character"}
					onClick={() => switchMode("character")}
					disabled={characters.length === 0}
				>
					Fork a Character
				</button>
				<button
					type="button"
					data-active={mode === "adhoc"}
					onClick={() => switchMode("adhoc")}
				>
					Ad-hoc Definition
				</button>
			</div>

			{seat.type === "character" ? (
				<label className="seat-field">
					<span>Character</span>
					<select
						value={seat.characterId}
						onChange={(event) => {
							const selected = characters.find(
								(character) => character.id === Number(event.target.value),
							);
							if (selected) {
								onChange({
									type: "character",
									characterId: selected.id,
									expectedRevision: selected.revision,
								});
							}
						}}
					>
						{characters.map((character) => (
							<option key={character.id} value={character.id}>
								{character.pinned ? "★ " : ""}
								{character.name}
							</option>
						))}
					</select>
				</label>
			) : (
				<div className="seat-adhoc">
					<label className="seat-field">
						<span>Name</span>
						<input
							value={seat.definition.name}
							placeholder={
								role === "human"
									? "e.g. Writer or your persona's name"
									: "Who responds in this Chat?"
							}
							onChange={(event) =>
								onChange({
									type: "adhoc",
									definition: {
										...seat.definition,
										name: event.target.value,
									},
								})
							}
						/>
					</label>
					<PromptFields
						prompt={seat.definition.prompt}
						onChange={(prompt) =>
							onChange({
								type: "adhoc",
								definition: { ...seat.definition, prompt },
							})
						}
					/>
					<OpeningsField
						openings={seat.definition.openings}
						onChange={(openings) =>
							onChange({
								type: "adhoc",
								definition: { ...seat.definition, openings },
							})
						}
					/>
				</div>
			)}
		</section>
	);
}

function PromptFields({
	prompt,
	onChange,
}: {
	prompt: PromptChannels;
	onChange: (prompt: PromptChannels) => void;
}) {
	return (
		<details className="seat-details">
			<summary>Prompt fields</summary>
			{promptChannelFields.map(({ key, label }) => (
				<label className="seat-field" key={key}>
					<span>{label}</span>
					<textarea
						rows={2}
						value={prompt[key]}
						onChange={(event) => onChange({ ...prompt, [key]: event.target.value })}
					/>
				</label>
			))}
		</details>
	);
}

function OpeningsField({
	openings,
	onChange,
}: {
	openings: string[];
	onChange: (openings: string[]) => void;
}) {
	return (
		<label className="seat-field">
			<span>Opening messages, one per line. The model uses one when the Chat starts.</span>
			<textarea
				rows={3}
				value={openings.join("\n")}
				onChange={(event) =>
					onChange(openingsFromText(event.target.value))
				}
			/>
		</label>
	);
}

export function NewChatPanel({
	onCreated,
}: {
	onCreated: (conversationId: number) => void;
}) {
	const [name, setName] = useState("");
	const [characters, setCharacters] = useState<CharacterSummary[]>([]);
	const [humanSeat, setHumanSeat] = useState<SeatDraft>(emptySeatDraft());
	const [modelSeat, setModelSeat] = useState<SeatDraft>(emptySeatDraft());
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	useAsyncEffect(async (isCancelled) => {
		try {
			const summaries = await listCharacters();
			if (!isCancelled()) setCharacters(summaries);
		} catch {
			if (!isCancelled()) setCharacters([]);
		}
	}, []);

	const humanReady =
		humanSeat.type === "adhoc"
			? humanSeat.definition.name.trim() !== ""
			: characters.some(
					(character) => character.id === humanSeat.characterId,
				);
	const modelReady =
		modelSeat.type === "adhoc"
			? modelSeat.definition.name.trim() !== ""
			: characters.some((character) => character.id === modelSeat.characterId);
	const ready = name.trim() !== "" && humanReady && modelReady && !pending;

	const submit = async () => {
		setPending(true);
		setProblem(null);
		try {
			const outcome = await createNativeConversation({
				name: name.trim(),
				humanSeat,
				modelSeat,
			});
			switch (outcome.status) {
				case "created":
					onCreated(outcome.conversationId);
					break;
				case "conflict":
					setProblem(
						`${outcome.currentCharacterName} changed while you were setting up. Re-select it to fork the current version.`,
					);
					break;
				case "not-found":
					setProblem("A chosen Character no longer exists. Pick another.");
					break;
				case "invalid":
					setProblem(outcome.reason);
					break;
				default:
					setProblem("The Chat could not be created. Try again.");
			}
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="panel-body new-chat-panel">
			<p className="panel-intro">
				Set up who you play and who responds. Both seats are required before the
				Chat is created.
			</p>

			<label className="seat-field conversation-name-field">
				<span>Chat name</span>
				<input
					value={name}
					placeholder="Name this Chat"
					onChange={(event) => setName(event.target.value)}
				/>
			</label>

			<div className="seats-grid">
				<SeatEditor
					role="human"
					seat={humanSeat}
					onChange={setHumanSeat}
					characters={characters}
				/>
				<SeatEditor
					role="model"
					seat={modelSeat}
					onChange={setModelSeat}
					characters={characters}
				/>
			</div>

			{problem && (
				<p className="new-chat-problem" role="alert">
					{problem}
				</p>
			)}

			<button
				className="primary-button"
				type="button"
				disabled={!ready}
				onClick={() => void submit()}
			>
				<Plus aria-hidden="true" /> Create Chat
			</button>
			<p className="panel-note">
				{ready
					? "Both Control assignments are ready."
					: "A Chat needs a name and two distinct Participants before it can begin."}
			</p>
		</div>
	);
}
