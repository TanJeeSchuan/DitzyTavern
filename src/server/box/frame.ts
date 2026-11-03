import { join } from "node:path";

const client = join(import.meta.dir, "../../client");

// @approved
//  The frame's host script and its stylesheets, built once when the first
// frame is served: the script bundles DOMPurify, and the stylesheets are the
// host's theme tokens and the frame's base styles, inlined because the frame
// loads nothing.
let parts: Promise<{ readonly script: string; readonly style: string }> | undefined;
const frameParts = () => parts ??= (async () => {
	const build = await Bun.build({ entrypoints: [join(client, "box-windows/frame.ts")], target: "browser", format: "iife", minify: true });
	if (!build.success) throw new AggregateError(build.logs, "The Box frame script did not build.");
	const [script] = build.outputs;
	if (script === undefined) throw new Error("The Box frame script built no output.");
	const styles = await Promise.all([join(client, "../styles/theme.css"), join(client, "box-windows/frame.css")].map((path) => Bun.file(path).text()));
	// @approved
	// An inline script ends at the first `</script`, so the bundle's own are escaped, which leaves every string and regex it holds the same.
	return { script: (await script.text()).replaceAll("</script", "<\\/script"), style: styles.join("\n") };
})();

// @approved
//  The frame document runs only host code: its script carries this response's
// nonce, and the guest's own code runs in a Worker the script starts from a
// blob, under the policy the Worker inherits. Nothing loads from the network;
// guest CSS is inline, images arrive with ticket 02, and only the app's own
// page may embed the frame.
export const boxFrameResponse = async (host: string) => {
	const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
	const { script, style } = await frameParts();
	const policy = ["default-src 'none'", `script-src 'nonce-${nonce}'`, "worker-src blob:", "style-src 'unsafe-inline'", "img-src 'none'", "form-action 'none'", "base-uri 'none'", `frame-ancestors ${host}`].join("; ");
	const body = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style><script nonce="${nonce}">${script}</script></head><body></body></html>`;
	return new Response(body, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store", "content-security-policy": policy } });
};
