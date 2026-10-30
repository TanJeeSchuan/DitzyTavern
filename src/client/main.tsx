import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import "../index.css";
import { registerWireFormats } from "../shared/contract/wire-formats";
import { App } from "./App";
import { loadBoxClients } from "./box-windows/registry";
import { ImageDialogProvider } from "./ImageDialog";
import { followServerChanges } from "./server-changes";

registerWireFormats();

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
followServerChanges(queryClient);

// @approved
//  Build stamp: the hashed asset name identifies the exact bundle. Snapshot
// this from the console whenever "is this the current client?" comes up.
const bundle = [...document.scripts]
	.map((script) => script.src)
	.find((src) => /\/index-[A-Za-z0-9_-]+\.js/.test(src))
	?.split("/")
	.pop();
console.info("DitzyTavern client bundle:", bundle ?? "unknown");

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}
// @approved
//  The Boxes' client modules load before the first render. A Box module
// imports host chunks that may import this entry, so the entry finishes
// evaluating rather than await them, which would deadlock that cycle. A
// failed Box list leaves the Chat without Boxes.
void loadBoxClients().catch((error) => console.error("Boxes did not load:", error)).then(() => {
	createRoot(root).render(<QueryClientProvider client={queryClient}><ImageDialogProvider><App /></ImageDialogProvider></QueryClientProvider>);
});
