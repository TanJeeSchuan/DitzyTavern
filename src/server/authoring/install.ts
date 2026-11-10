import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioInput } from "../../shared/contract/authoring";
import { assertFreeTags, boxAt, builtInBoxes, checkSandboxedFolder, installVersion, serverBoxes, unversionedBoxIds, type CheckedSandboxedBox } from "../box/registry";
import { sandboxedFolder } from "../box/sandboxed-folder";
import { createVersion, isVersioned, passedCheck, readLatest, versionFolder, versionHash, writeLatest } from "../box/versions";
import { refusedUpgrade } from "../conversation";
import type { Candidate } from "./candidate";
import { replayRefusals } from "./scenario";

// @approved
//  Whether Chats on `latest` could Update to the candidate, judged on the
// data the session's saved scenarios leave when each is replayed on
// `latest`: one refusal per scenario that leaves data the candidate
// refuses, each reading as the writer's Update would. A Chat holding data
// no scenario reached is still guarded by the Update check itself.
const latestRefusals = async (home: string, latest: string, candidate: CheckedSandboxedBox, scenarios: readonly ScenarioInput[]) => {
	const { id } = candidate.descriptor;
	const earlier = await checkSandboxedFolder(versionFolder(home, latest), id, unversionedBoxIds());
	try {
		const unique = [...new Map(scenarios.map((input) => [JSON.stringify({ ...input, from: undefined }), input])).values()];
		const refused: string[] = [];
		for (const [index, input] of unique.entries()) {
			const refusals = await replayRefusals(id, earlier, candidate, input);
			if (refusals.length > 0) refused.push(`Saved scenario ${index + 1}: ${refusedUpgrade(earlier.descriptor.label, refusals)}`);
		}
		return refused;
	} finally {
		earlier.dispose();
	}
};

// @approved
//  Installs a candidate, a writer's action: holding the candidate, it creates
// a version of the Box from the candidate's files and moves `latest` to it,
// so the catalog and new insertions run it while every Chat already holding
// the Box stays on the version it pins. Only a version a scenario passed on
// installs: the cached check is looked up by the candidate's exact hash
// before anything is built, and the built version must keep that hash. An id
// a built-in or unversioned Box uses, or an id folder without `versions/`
// (a trusted plugin, or a sandboxed folder made by hand), refuses Install.
// A version that drops `decision` while `latest` digests is refused too:
// Chats pinned to a digesting version keep needing its Decision Model
// settings, which the catalog lists only while `latest` digests, so once a
// Box digests every later `latest` must; dropping it means a new Box, so
// that outcome is `incompatible` too. So is a version that drops `delegate`,
// or renames its tag, once `latest` delegates: the requests written in Chats
// on earlier versions name that tag, and its delegate setting is listed from
// the catalog. A tag another loaded Box already takes refuses Install, as it
// refuses a plugin at load. Installs of one Box run one at a time. When
// the session's saved `scenarios`, replayed on `latest`, leave data the
// candidate's Update check refuses, `latest` stays and the outcome is
// `incompatible`, which the panel answers with Install as a new Box.
export const installCandidate = (candidate: Candidate, plugins: string, scenarios: readonly ScenarioInput[]) => candidate.check(() => serially(join(plugins, candidate.id), async () => {
	const { id } = candidate;
	const refused = (reason: string, diagnostics: readonly string[] = []) => ({ outcome: "refused" as const, reason, diagnostics: [...diagnostics] });
	const home = join(plugins, id);
	if (unversionedBoxIds().has(id) || existsSync(join(builtInBoxes, id)) || (existsSync(home) && !isVersioned(home))) return refused(`A Box folder already uses the id ${id}.`);
	const version = versionHash(await sandboxedFolder(candidate.folder, id));
	if (!await passedCheck(home, version)) return refused("Run a scenario that passes on the Box as it is now, then install it.");
	const latest = await readLatest(home);
	let created: Awaited<ReturnType<typeof createVersion>>;
	try {
		created = await createVersion(home, candidate.folder, id, unversionedBoxIds());
	} catch (error) {
		return refused("The Box did not pass the loader's check.", [error instanceof Error ? error.message : String(error)]);
	}
	const { checked } = created;
	let release = () => {};
	try {
		if (created.version !== version) {
			checked.dispose();
			return refused("The Box changed while it was built. Run a scenario on it again, then install it.");
		}
		const tag = checked.descriptor.delegate?.tag;
		const claimant = tag === undefined ? undefined : claiming.get(tag);
		try {
			assertFreeTags(checked.descriptor, [...serverBoxes().values()].map(({ descriptor }) => descriptor));
			if (claimant !== undefined && claimant !== id) throw new Error(`Its tag ${tag} is being installed for the ${claimant} Box.`);
		} catch (error) {
			checked.dispose();
			return refused("The Box did not pass the loader's check.", [error instanceof Error ? error.message : String(error)]);
		}
		if (tag !== undefined && claimant === undefined) claiming.set(tag, id);
		release = () => { if (tag !== undefined && claimant === undefined) claiming.delete(tag); };
		const delegated = boxAt(id, undefined)?.descriptor.delegate;
		if (delegated !== undefined && checked.descriptor.delegate?.tag !== delegated.tag) {
			checked.dispose();
			return { outcome: "incompatible" as const, reason: `Chats on this Box's earlier versions hold requests written as <${delegated.tag}>, so a later version must keep its delegate and that tag. Install it as a new Box to drop or rename it, or ask the agent to keep \`delegate\` with the tag ${delegated.tag}.`, diagnostics: [] };
		}
		if (boxAt(id, undefined)?.descriptor.decision !== undefined && checked.descriptor.decision === undefined) {
			checked.dispose();
			return { outcome: "incompatible" as const, reason: "This Box digests passages in Chats on its earlier versions, so a later version must keep its Decision Model setting (`decision`). Install it as a new Box to drop it, or ask the agent to keep `decision`.", diagnostics: [] };
		}
		const incompatible = latest === undefined || latest === version ? [] : await latestRefusals(home, latest, checked, scenarios);
		if (incompatible.length > 0) {
			checked.dispose();
			return { outcome: "incompatible" as const, reason: `Chats on the installed ${checked.descriptor.label} could not Update to this version. Install it as a new Box, so those Chats keep the old one, or ask the agent to keep the old records readable.`, diagnostics: incompatible };
		}
		await writeLatest(home, version);
		installVersion(id, home, version, checked);
	} catch (error) {
		checked.dispose();
		throw error;
	} finally {
		release();
	}
	return { outcome: "installed" as const, id, label: checked.descriptor.label };
}));

// @approved
//  Installs of one Box run one at a time, from reading `latest` to the
// catalog listing the new version, whichever sessions they come from: each
// candidate's own lock holds only its folder, and two sessions may target
// one Box, so each must check `decision` and `delegate` against the
// `latest` the other just published.
const installs = new Map<string, Promise<void>>();
const serially = <T>(home: string, run: () => Promise<T>): Promise<T> => {
	const ran = (installs.get(home) ?? Promise.resolve()).then(run);
	const settled = ran.then(() => undefined, () => undefined);
	installs.set(home, settled);
	void settled.then(() => { if (installs.get(home) === settled) installs.delete(home); });
	return ran;
};

// @approved
//  A delegate tag is claimed from an Install's tag check until the catalog
// lists its version, since another Install's check reads the catalog while
// this one still awaits its replay and its `latest` write.
const claiming = new Map<string, string>();
