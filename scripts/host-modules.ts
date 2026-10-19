// @approved
//  The modules a Box client shares with the host, each specifier to the
// stable host chunk the host build emits it as. The page's import map
// resolves a Box client's imports of them to those chunks, and a Box client's
// build leaves them as imports.
export const hostModules = {
	react: "/host/react.js",
	"react/jsx-runtime": "/host/react-jsx-runtime.js",
	"react-dom": "/host/react-dom.js",
	"@tanstack/react-query": "/host/react-query.js",
	"@sinclair/typebox": "/host/typebox.js",
	"@sinclair/typebox/value": "/host/typebox-value.js",
	"@/box-sdk/client": "/host/box-sdk-client.js",
	"@/box-sdk/shared": "/host/box-sdk-shared.js",
};
