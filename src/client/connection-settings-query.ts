import { useQuery, type QueryClient } from "@tanstack/react-query";
import { loadConnectionSettings, type ConnectionSettings } from "./connection-settings";
import { newerSettings } from "./connection-settings-state";

export const connectionSettingsKey = ["connection-settings", "settings"] as const;

export const publishConnectionSettings = (client: QueryClient, settings: ConnectionSettings) => {
	void client.cancelQueries({ queryKey: connectionSettingsKey });
	return client.setQueryData<ConnectionSettings>(connectionSettingsKey, (current) => newerSettings(current ?? null, settings));
};

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
