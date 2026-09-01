import { createRoot } from "react-dom/client";
import "../index.css";
import { registerWireFormats } from "../shared/contract/wire-formats";
import { App } from "./App";

registerWireFormats();

// ==[HUMAN APPROVED]== Build stamp: the hashed asset name identifies the exact bundle. Snapshot
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
createRoot(root).render(<App />);
