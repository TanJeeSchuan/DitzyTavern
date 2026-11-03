/** @approved What the app sends a Box frame over its port: the guest's code and stylesheet once, then each read with the Box's staged Moves (null while it is not enabled) and whether controls are disabled. */
export type AppToFrame =
	| { readonly type: "start"; readonly ui: string; readonly css: string }
	| { readonly type: "read"; readonly read: unknown; readonly moves: readonly unknown[] | null; readonly disabled: boolean };

/** @approved What a Box frame sends the app: Moves the guest stages, and a failure of the guest's Worker. */
export type FrameToApp = { readonly type: "stage"; readonly moves: unknown } | { readonly type: "error"; readonly message: string };
