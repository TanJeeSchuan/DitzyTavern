// Live preview of the streaming animation on the app's own pieces: StoryMessageView, Prose,
// GenerationControls, useStoryViewport and the app CSS. A local timer stands in for the model.
//   bunx vite   then open   http://127.0.0.1:5173/scripts/stream-eyes/preview.html
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import type { StoryMessage } from "../../src/client/story";
import { GenerationControls } from "../../src/client/story/StoryStatus";
import { StoryMessageView } from "../../src/client/story/StoryMessageView";
import { useStoryViewport } from "../../src/client/workspace/useStoryViewport";

const PROSE = [
	'"You came back," she said, not looking up from the ledger. The candle beside her had burned down to a stub, and the wax had pooled across three weeks of unpaid accounts. Outside, the rain kept its patient rhythm against the shutters. She turned a page. Then another. He waited by the door, coat dripping, saying nothing at all.',
	'The silence stretched until it became a kind of answer. She closed the ledger at last and looked at him properly, the way one looks at weather that has been threatening all afternoon. "Sit, then. You are ruining the floor." He sat. The chair creaked under him like it remembered his weight from years ago, which perhaps it did. The fire in the grate had gone to embers hours ago, and neither of them moved to feed it. She studied the burn along his sleeve, the soot still caught in the creases of his knuckles, the way he held his left hand a little away from his body as though it belonged to someone else. He let her look. There had been a time when he would have hidden all of it, would have told some story about a lamp knocked over in a careless moment, but that time had burned down along with everything else on the waterfront.',
	'"I heard about the harbor," she said. "Everyone has. Half the town thinks you set the fire yourself, and the other half thinks you should have." She poured two cups of something dark from a kettle that had no business still being warm. "Which half should I believe?" He took the cup. He did not drink. Some questions are better answered with patience than with words.',
].join("\n\n");
const TOKEN = 4; // characters per delta, roughly one token

const message = (id: number, authorName: string, content: string): StoryMessage => ({
	id,
	position: id,
	timestamp: "2026-10-02T15:40:00.000Z",
	authorName,
	authorParticipantId: authorName === "Night Desk" ? 1 : 2,
	modelParticipantIdAtCreation: null,
	continuable: true,
	swipe: { eligible: true, reason: null },
	inCast: true,
	activeSwipe: 0,
	swipes: [{ id: id * 10, position: 1, content, empty: content === "", reasoning: "" }],
});

const history = [
	message(1, "Theodora Kline", "You arrive as she pins a third map over the first two."),
	message(2, "Night Desk", "Knock knock."),
];

function Preview() {
	const [prose, setProse] = useState(PROSE);
	const [cps, setCps] = useState(60);
	const [latency, setLatency] = useState(600);
	const [theme, setTheme] = useState<"daylight" | "evening">("daylight");
	const [run, setRun] = useState(3);
	const [streamed, setStreamed] = useState(0);
	const [paused, setPaused] = useState(false);
	const generating = streamed < prose.length;
	const reply = message(run, "Theodora Kline", prose.slice(0, streamed));
	const messages = [...history, reply];
	const viewport = useStoryViewport({ messages, conversationId: 1 });

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	useEffect(() => {
		if (!generating || paused) return;
		const timer = setTimeout(
			() => setStreamed((length) => Math.min(length + TOKEN, prose.length)),
			streamed === 0 ? latency : (1000 * TOKEN) / cps,
		);
		return () => clearTimeout(timer);
	}, [streamed, generating, paused, cps, latency, prose]);

	return (
		<div className="workspace" data-ambience="coral">
			<div className="ambient-field" aria-hidden="true" />
			<aside className="primary-panel" data-open="true" aria-label="Stream preview">
				<header className="panel-header">
					<h2>Stream preview</h2>
				</header>
				<div className="panel-body">
					<div className="field">
						<label htmlFor="cps">Speed: {cps} characters per second</label>
						<input id="cps" type="range" min={10} max={600} step={10} value={cps} onChange={(event) => setCps(+event.target.value)} />
					</div>
					<div className="field">
						<label htmlFor="latency">First token after {latency} ms</label>
						<input id="latency" type="range" min={0} max={5000} step={100} value={latency} onChange={(event) => setLatency(+event.target.value)} />
					</div>
					<div className="field">
						<label htmlFor="theme">Theme</label>
						<select id="theme" className="field-input" value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)}>
							<option value="daylight">Daylight</option>
							<option value="evening">Evening</option>
						</select>
					</div>
					<div className="field">
						<label htmlFor="prose">Reply</label>
						<textarea id="prose" rows={14} value={prose} onChange={(event) => setProse(event.target.value)} />
						<small>{streamed} of {prose.length} characters streamed</small>
					</div>
					<div className="panel-action-footer">
						<button className="primary-button" type="button" onClick={() => {
							// A fresh Message id per run, so Prose sees a new streamed Message the way the app does.
							setRun((value) => value + 1);
							setStreamed(0);
						}}>Replay</button>
						<button className="secondary-button" type="button" disabled={!generating} onClick={() => setPaused((value) => !value)}>
							{paused ? "Resume" : "Pause"}
						</button>
					</div>
				</div>
			</aside>
			<main className="story-stage" aria-label="Active Chat">
				<div />
				<div className="story-scroll" ref={viewport.storyScrollRef} onScroll={viewport.onStoryScroll}>
					<div className="story-content">
						{messages.map((entry) => (
							<StoryMessageView
								key={entry.id}
								message={entry}
								isLatest={entry.id === reply.id}
								generationActive={entry.id === reply.id && generating}
								canContinue={entry.id === reply.id && !generating}
								continueLabel="Continue as Theodora Kline"
								onContinue={() => {}}
								onMoveSwipe={() => {}}
								onEdit={() => {}}
								generationControls={entry.id === reply.id && generating && (
									<GenerationControls
										showStopAll={false}
										onStop={() => setStreamed(prose.length)}
										onStopAll={() => {}}
										onInspect={() => {}}
									/>
								)}
							/>
						))}
					</div>
				</div>
			</main>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Preview />);
