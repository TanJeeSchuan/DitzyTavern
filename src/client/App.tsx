import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/eden";

type Character = {
	id: number;
	name: string;
};

type CharacterState =
	| { status: "loading" }
	| { status: "ready"; character: Character }
	| { status: "not-found" }
	| { status: "error" };

function getCharacterId() {
	const pathId = window.location.pathname.match(/\/characters\/(\d+)\/?$/)?.[1];
	const queryId = new URLSearchParams(window.location.search).get("id");
	const candidate = pathId ?? queryId;
	if (!candidate) {
		return null;
	}

	const characterId = Number(candidate);

	return Number.isSafeInteger(characterId) && characterId > 0
		? characterId
		: null;
}

export function App() {
	const characterId = getCharacterId();
	const [state, setState] = useState<CharacterState>({ status: "loading" });

	const loadCharacter = useCallback(async () => {
		if (characterId === null) {
			setState({ status: "not-found" });
			return;
		}

		setState({ status: "loading" });

		try {
			const { data, error } = await api.api.characters({ id: characterId }).get();

			if (error?.status === 404) {
				setState({ status: "not-found" });
				return;
			}

			if (error || !data) {
				setState({ status: "error" });
				return;
			}

			setState({ status: "ready", character: data });
		} catch {
			setState({ status: "error" });
		}
	}, [characterId]);

	useEffect(() => {
		void loadCharacter();
	}, [loadCharacter]);

	return (
		<main className="character-page">
			<div className="character-ambient" aria-hidden="true" />
			<section className="character-surface" aria-label="Character profile">
				<header className="character-header">
					<p>DitzyTavern</p>
					<span>Character</span>
				</header>

				{state.status === "loading" && <CharacterLoading />}
				{state.status === "ready" && (
					<CharacterDisplay character={state.character} />
				)}
				{state.status === "not-found" && (
					<CharacterMessage
						title="Character not found"
						body="This character is not available."
					/>
				)}
				{state.status === "error" && (
					<CharacterMessage
						title="Character unavailable"
						body="The character could not be loaded."
						onRetry={() => void loadCharacter()}
					/>
				)}
			</section>
		</main>
	);
}

function CharacterDisplay({ character }: { character: Character }) {
	const initial = character.name.trim().charAt(0).toLocaleUpperCase() || "?";

	return (
		<div className="character-content">
			<div className="character-mark" aria-hidden="true">
				{initial}
			</div>
			<div className="character-identity">
				<p className="character-label">Character profile</p>
				<h1 id="character-title">{character.name}</h1>
				<dl className="character-record">
					<div>
						<dt>Record</dt>
						<dd>#{character.id}</dd>
					</div>
				</dl>
			</div>
		</div>
	);
}

function CharacterLoading() {
	return (
		<div className="character-content" aria-live="polite" aria-busy="true">
			<span className="sr-only">Loading character</span>
			<div className="character-mark character-skeleton" aria-hidden="true" />
			<div className="character-identity" aria-hidden="true">
				<div className="skeleton-line skeleton-label" />
				<div className="skeleton-line skeleton-name" />
				<div className="skeleton-line skeleton-record" />
			</div>
		</div>
	);
}

function CharacterMessage({
	title,
	body,
	onRetry,
}: {
	title: string;
	body: string;
	onRetry?: () => void;
}) {
	return (
		<div className="character-message" role="status">
			<p className="character-label">Character profile</p>
			<h1 id="character-title">{title}</h1>
			<p>{body}</p>
			{onRetry && (
				<button type="button" onClick={onRetry}>
					Try again
				</button>
			)}
		</div>
	);
}
