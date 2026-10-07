import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { UpdateStatus } from "../../shared/contract/updates";
import { checkUpdates, observeUpdates } from "../updates";

export function UpdateSettings() {
	const [state, setState] = useState<UpdateStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => observeUpdates((status) => { setState(status); setError(null); }, () => setError("Update status connection lost. Reconnecting…")), []);
	const check = async () => {
		try { await checkUpdates(); } catch (error) { setError(error instanceof Error ? error.message : "Update check could not be requested."); }
	};
	const result = state?.result;
	const failed = state?.attempt?.status === "failed";
	const checking = state?.attempt?.status === "checking";
	const available = result?.comparison === "update_available";
	return <section className="settings-section">
		<h3>Updates</h3>
		{state?.build.distribution === "custom" ? <p>Custom build · update checks unavailable</p> : <div className="update-settings-body">
			{state && <p className="settings-feedback">Running build {state.build.buildNumber}</p>}
			<div role="status" aria-live="polite">
				{result ? <p className="settings-feedback">{available ? `Build ${result.buildNumber} available` : result.comparison === "current" ? "Up to date" : `No newer build available · running build ${state?.build.buildNumber}, published build ${result.buildNumber}`}</p> : <p className="settings-feedback">{checking ? "Checking…" : failed ? "Couldn't check for updates" : state ? "Not checked" : "Loading update status…"}</p>}
				{result && <p className="settings-feedback">{failed || checking ? "Last successful check" : "Checked"} <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time></p>}
				{checking && result && <p className="settings-feedback">Checking…</p>}
			</div>
			{failed && <p className="settings-feedback-error" role="alert">{result ? "Last refresh failed" : "Check failed"}. {state?.attempt?.error}</p>}
			<div className="update-settings-actions">
				<Button variant="outline" size="sm" disabled={!state || checking} onClick={() => void check()}>{failed ? "Retry" : "Check now"}</Button>
				{available && <Button asChild variant="link" size="sm"><a href="https://github.com/TanJeeSchuan/DitzyTavern/blob/master/docs/docker.md#updates-and-backups" target="_blank" rel="noreferrer">Update instructions</a></Button>}
				{available && state?.build.revision !== result.revision && <Button asChild variant="link" size="sm"><a href={`https://github.com/TanJeeSchuan/DitzyTavern/compare/${state?.build.revision}...${result.revision}`} target="_blank" rel="noreferrer">View changes</a></Button>}
			</div>
		</div>}
		{error && <p className="settings-feedback-error" role="alert">{error}</p>}
	</section>;
}
