import { useQuery, type QueryClient } from "@tanstack/react-query";
import { loadConnectionSettings, type ConnectionSettings } from "./connection-settings";
import { foldNewer } from "./lib/visit";

export const connectionSettingsKey = ["connection-settings", "settings"] as const;

export const publishConnectionSettings = (client: QueryClient, settings: ConnectionSettings) =>
	foldNewer(client, connectionSettingsKey, settings, (read) => read.revision);

export function useConnectionSettingsQuery({ refreshOnOpen = false } = {}) {
	return useQuery({
		queryKey: connectionSettingsKey,
		staleTime: Infinity,
		refetchOnMount: refreshOnOpen ? "always" : true,
		queryFn: async ({ signal }) => {
			await Promise.resolve();
			signal.throwIfAborted();
			return loadConnectionSettings(signal);
		},
	});
}
