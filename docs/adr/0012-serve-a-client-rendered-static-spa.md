# Serve a client-rendered static React SPA

The browser interface will be built as static client-rendered assets and served by Elysia with SPA fallback routing. Version one will not use SSR, React Server Components, or HTML-over-the-wire rendering; server authority is expressed through HTTP commands, snapshots, and SSE rather than server-owned presentation.

The SPA is built with React 19, TypeScript, and Vite. Tailwind CSS and shadcn/ui provide accessible component primitives. React is chosen over Vue because the maintainer wants direct React experience, and over Svelte/Solid because React has the strongest shadcn/ui, streaming-markdown, virtual-scrolling, and component-testing ecosystems for this application's client-side hard parts.

During development Vite serves the client and proxies API/SSE requests to the loopback Elysia server. In production Elysia serves the generated static assets with SPA fallback; Vite is not a second production application server. Bun remains the package manager and server runtime.

Streaming token UI updates are coalesced to animation frames or similar so the streaming text surface does not re-render once per token.

The SPA will not optimistically mutate authoritative Conversation state. It provides immediate local drafts and pending feedback, but applies Messages, Variants, Control, and other domain changes only after server acceptance or corresponding SSE events.
