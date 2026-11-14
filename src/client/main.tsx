import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import "../index.css";
import { registerWireFormats } from "../shared/contract/wire-formats";
import { App } from "./App";
import { loadBoxClients, loadedBoxes } from "./box-windows/registry";
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
//  A tab restored from cache after a deploy runs the previous build, whose
// hashed chunks the server no longer has, so its Box modules fail to import.
// When a Box failed and this entry is gone too, the tab reloads into the
// current build; a Box that fails under the current build never reloads. A
// probe that fails or stalls past three seconds counts as current.
const entryGone = () => fetch(import.meta.url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(3000) }).then((response) => response.status === 404, () => false);
const staleBuild = async () => [...loadedBoxes().values()].some((box) => "failure" in box) && await entryGone();
void loadBoxClients().catch((error) => console.error("Boxes did not load:", error)).then(async () => {
	if (await staleBuild()) return location.reload();
	createRoot(root).render(<QueryClientProvider client={queryClient}><ImageDialogProvider><App /></ImageDialogProvider></QueryClientProvider>);
});
