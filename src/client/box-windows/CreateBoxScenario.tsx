import { scenarioInput, type ScenarioResult } from "../../shared/contract/authoring";
import { inputAs, type ToolEntry } from "./CreateBoxConsole";

type Turn = ScenarioResult["turns"][number];

/** @approved One turn or swipe: its Moves as history renders them, its prose, the prompt items, and the record it stored. */
function TurnRow({ label, name, turn, prose, removed, differs }: {
	label: string;
	name: string;
	turn: Turn | undefined;
	prose: string | undefined;
	removed: readonly string[];
	differs?: string;
}) {
	return <li className="create-box-turn" data-ran={turn !== undefined}>
		<span className="create-box-turn-label">{label}</span>
		<div className="create-box-turn-body">
			{turn !== undefined && turn.moves.length > 0 && <ul className="create-box-moves" aria-label={`${name} Moves`}>{turn.moves.map((move, index) => <li key={index}>{move}</li>)}</ul>}
			{prose !== undefined && <p className="create-box-prose">{prose}</p>}
			{turn === undefined ? <p className="create-box-quiet">Not run</p> : <ul className="create-box-items" aria-label={`${name} prompt items`}>
				{turn.items.map((item, index) => <li key={index}><span>{item.text}</span><span className="create-box-quiet">{item.priority}</span></li>)}
				{removed.map((text) => <li key={text}><del>{text}</del></li>)}
			</ul>}
			{turn?.record !== undefined && <p className="create-box-record">record <code>{JSON.stringify(turn.record)}</code></p>}
			{differs !== undefined && <p className="create-box-error">Differs from {differs}</p>}
		</div>
	</li>;
}

const texts = (turn: Turn | undefined) => new Set(turn?.items.map(({ text }) => text));
/** @approved The prompt items an earlier run of the same scenario gave at this turn that this run no longer gives. */
const removedFrom = (turn: Turn | undefined, before: Turn | undefined) => [...texts(before)].filter((text) => !texts(turn).has(text));
const sameOutcome = (a: Turn, b: Turn | undefined) => b !== undefined && JSON.stringify([a.items, a.record]) === JSON.stringify([b.items, b.record]);

// @approved
//  One `run_scenario` call, turn by turn, as the Box ran it: what each turn's
// Moves read as, the scripted prose, the prompt items the model would get and
// the record stored, then the folded state and the window's view. Items an
// earlier run of the identical scenario gave and this one does not are
// struck out, so a rerun after a fix shows what the fix changed. A swipe
// says so only when it gave a different outcome from the turn it replaced.
export function Scenario({ run, before }: { run: ToolEntry | undefined; before: ScenarioResult | undefined }) {
	const result = run?.scenario;
	if (run === undefined || result === undefined) return <section className="create-box-scenario" aria-label="Scenario">
		<header><h3>Scenario</h3></header>
		<p className="create-box-quiet create-box-empty">Scenario runs show here.</p>
	</section>;
	const script = inputAs(run.start, scenarioInput);
	const turns = script?.turns ?? result.turns.map(() => ({ prose: undefined }));
	return <section className="create-box-scenario" aria-label="Scenario">
		<header><h3>Scenario</h3><span className="create-box-verdict" data-ok={result.ok}>{result.ok ? "Passed" : "Failed"}</span></header>
		{result.diagnostics.length > 0 && <ul className="create-box-diagnostics" aria-label="Diagnostics">{result.diagnostics.map((line) => <li key={line}>{line}</li>)}</ul>}
		<ol className="create-box-turns">
			{turns.map(({ prose }, index) => <TurnRow key={`t${index}`} label={`t${index + 1}`} name={`Turn ${index + 1}`} turn={result.turns[index]} prose={prose}
				removed={removedFrom(result.turns[index], before?.turns[index])} />)}
			{result.swipes.map((swipe, index) => {
				const replaced = script?.swipes?.[index]?.turn;
				return <TurnRow key={`s${index}`} label={replaced === undefined ? `s${index + 1}` : `t${replaced + 1}′`} name={`Swipe ${index + 1}`} turn={swipe} prose={script?.swipes?.[index]?.prose}
					removed={removedFrom(swipe, before?.swipes[index])} differs={replaced === undefined || sameOutcome(swipe, result.turns[replaced]) ? undefined : `t${replaced + 1}`} />;
			})}
		</ol>
		{(result.state !== undefined || result.read !== undefined) && <div className="create-box-outcome">
			{result.state !== undefined && <div><h4>State</h4><pre aria-label="Folded state">{JSON.stringify(result.state, null, 2)}</pre></div>}
			{result.read !== undefined && <div><h4>Window</h4><pre aria-label="Window view">{JSON.stringify(result.read.view, null, 2)}</pre>{result.read.status ? <p>{result.read.status}</p> : null}</div>}
			{result.status ? <p>{result.status}</p> : null}
		</div>}
	</section>;
}
