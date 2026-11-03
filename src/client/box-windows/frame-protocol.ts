// @approved
//  What the app sends a Box frame over its port: the guest's code and
// stylesheet once; then each read with the view beside it (this Box's staged
// Moves, null while it is not enabled; whether controls are disabled;
// whether the read is from an earlier revision; and the snapshot its commits
// name); the reply to each commit or upload the guest asked for; and the
// window's save and discard requests.
export type AppToFrame =
	| { readonly type: "start"; readonly ui: string; readonly css: string }
	| { readonly type: "read"; readonly read: unknown; readonly view: { readonly moves: readonly unknown[] | null; readonly disabled: boolean; readonly stale: boolean; readonly snapshot: number } }
	| { readonly type: "reply"; readonly id: number; readonly result: unknown }
	| { readonly type: "save"; readonly id: number }
	| { readonly type: "discard" };

// @approved
//  What a Box frame sends the app, all of it as the guest posted it: Moves it
// stages, a failure of its Worker, a commit or an upload it asks for, whether
// it holds unsaved work, and its answer to a save request.
export type FrameToApp =
	| { readonly type: "stage"; readonly moves: unknown }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "commit"; readonly id: unknown; readonly commit: unknown }
	| { readonly type: "upload"; readonly id: unknown; readonly file: unknown }
	| { readonly type: "dirty"; readonly dirty: unknown }
	| { readonly type: "saved"; readonly id: unknown; readonly saved: unknown };
