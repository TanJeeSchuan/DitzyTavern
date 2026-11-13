// @approved
//  Waits for Box code that may never settle, and stops waiting once `ms`
// passes or `stopping` aborts; it cannot stop the Box's own work, only the
// host's wait for it. Work `aborted` before it starts never starts. Once
// started, an abort of `aborted` alone keeps the wait, so a delegate job holds
// its Chat and Box's lane until its reducer is done; pass the same signal as
// `stopping` to stop waiting on abort instead. The run starts in the same turn
// as the checks, so no abort lands between them. A late result or rejection is
// dropped, and the wait removes its listener when it ends, either way.
export const settledWithin = <T>(run: () => T | Promise<T>, { aborted, stopping, ms }: { readonly aborted: AbortSignal; readonly stopping: AbortSignal; readonly ms: number }, reason: string): Promise<T> => new Promise((resolve, reject) => {
	if (aborted.aborted) return reject(aborted.reason);
	if (stopping.aborted) return reject(new Error(reason));
	const end = () => {
		clearTimeout(timer);
		stopping.removeEventListener("abort", fail);
	};
	const fail = () => {
		end();
		reject(new Error(reason));
	};
	const timer = setTimeout(fail, ms);
	stopping.addEventListener("abort", fail, { once: true });
	new Promise<T>((settle) => settle(run())).then(resolve, reject).finally(end);
});

/** @approved How long the host waits for a trusted Box's `advance.run` or digest, well past one Decision Model request. */
export const BOX_HOOK_MS = 120_000;
/** @approved How long the host waits for a trusted Box's module to import. */
export const BOX_IMPORT_MS = 10_000;
