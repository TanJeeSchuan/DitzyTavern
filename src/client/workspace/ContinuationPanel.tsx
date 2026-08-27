import { useEffect, useState } from "react";
import {
	applyConversationCommand,
	loadConversationGenerationSettings,
	type ContinuationPrefillSuffix,
	type ConversationGenerationSettings,
	type ConversationSummary,
} from "../conversation";

function continuationStrategyValue(
	value: string,
): ConversationGenerationSettings["continuationStrategy"] {
	return value === "assistant-prefill" ? value : "instruction";
}

function continuationPrefillSuffixValue(value: string): ContinuationPrefillSuffix {
	return value === " " || value === "\n" || value === "\n\n" ? value : "";
}

export function ContinuationPanel({
	conversation,
	onConversationChange,
}: {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
}) {
	if (conversation === null) {
		return (
			<div className="panel-body">
				<p className="panel-note">Open a Chat to edit its Continuation settings.</p>
			</div>
		);
	}
	return (
		<ContinuationSettings
			conversation={conversation}
			onConversationChange={(next) => onConversationChange(next)}
		/>
	);
}

function ContinuationSettings({
	conversation,
	onConversationChange,
}: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const [settings, setSettings] = useState<ConversationGenerationSettings | null>(null);
	const [instruction, setInstruction] = useState("");
	const [strategy, setStrategy] = useState<ConversationGenerationSettings["continuationStrategy"]>("instruction");
	const [prefillSuffix, setPrefillSuffix] = useState<ContinuationPrefillSuffix>("");
	const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");

	useEffect(() => {
		let cancelled = false;
		setStatus("loading");
		void loadConversationGenerationSettings(conversation.id)
			.then((loaded) => {
				if (cancelled) return;
				setSettings(loaded);
				setInstruction(loaded.continuationInstruction);
				setStrategy(loaded.continuationStrategy);
				setPrefillSuffix(loaded.continuationPrefillSuffix);
				setStatus("ready");
			})
			.catch(() => {
				if (!cancelled) setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [conversation.id]);

	const saveInstruction = async () => {
		if (settings === null || instruction.trim() === "") return;
		setStatus("saving");
		const next = {
			...settings,
			continuationStrategy: strategy,
			continuationInstruction: instruction,
			continuationPrefillSuffix: prefillSuffix,
		};
		const outcome = await applyConversationCommand(conversation.id, conversation.revision, {
			type: "update-generation-settings",
			settings: next,
		});
		if (outcome.status === "applied") {
			setSettings(next);
			setStrategy(next.continuationStrategy);
			setPrefillSuffix(next.continuationPrefillSuffix);
			onConversationChange(outcome.conversation);
			setStatus("ready");
			return;
		}
		setStatus("error");
	};

	return (
		<div className="panel-body settings-panel-body">
			<section aria-labelledby="continuation-settings-title">
				<h3 id="continuation-settings-title">Continuation</h3>
				<p>How the next model Message continues after a length limit.</p>
				{status === "loading" && <p className="panel-note">Loading Continuation settings…</p>}
				{status === "error" && <p className="import-problem" role="alert">Continuation settings could not be saved.</p>}
				{settings !== null && status !== "loading" && (
					<div className="definition-form">
						<div className="field">
							<label htmlFor="continuation-strategy">Strategy</label>
							<select
								id="continuation-strategy"
								className="field-input"
								value={strategy}
								onChange={(event) => setStrategy(continuationStrategyValue(event.target.value))}
							>
								<option value="instruction">Instruction</option>
								<option value="assistant-prefill">Assistant prefill</option>
							</select>
						</div>
						{strategy === "assistant-prefill" && (
							<div className="field">
								<label htmlFor="continuation-prefill-suffix">Prefill suffix</label>
								<select
									id="continuation-prefill-suffix"
									className="field-input"
									value={prefillSuffix}
									onChange={(event) => setPrefillSuffix(continuationPrefillSuffixValue(event.target.value))}
								>
									<option value="">None</option>
									<option value=" ">Space</option>
									<option value="\n">Newline</option>
									<option value="\n\n">Double newline</option>
								</select>
							</div>
						)}
						<div className="field">
							<label htmlFor="continuation-instruction">Continuation instruction</label>
							<textarea
								id="continuation-instruction"
								value={instruction}
								onChange={(event) => setInstruction(event.target.value)}
								rows={3}
							/>
							{strategy === "assistant-prefill" && (
								<small>Ignored while the Assistant prefill strategy is active.</small>
							)}
						</div>
						<button
							className="primary-button"
							type="button"
							disabled={status === "saving" || instruction.trim() === ""}
							onClick={() => void saveInstruction()}
						>
							{status === "saving" ? "Saving…" : "Save Continuation settings"}
						</button>
					</div>
				)}
			</section>
		</div>
	);
}
