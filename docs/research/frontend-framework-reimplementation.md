# Frontend framework reimplementation research

Research date: 2026-08-26

Question: should DitzyTavern adopt StyleX, Radix UI, or another frontend framework while reimplementing the interface?

No existing `docs/research` note convention was present, so this note lives at `docs/research/frontend-framework-reimplementation.md`.

## Recommendation

Continue the clean-slate frontend reimplementation, but do not restart the client or replace its styling layer with StyleX.

Keep the current Vite + React + Tailwind CSS + CSS custom properties approach. Keep Radix as the behavior primitive layer and adopt it more consistently through the local `src/components/ui` wrappers. Keep the workspace shell, story reading surface, responsive panel geometry, streaming states, and scroll anchoring as product-owned code.

Use StyleX only for a small, isolated experiment if the project later develops a measured CSS composition problem. Do not introduce it as a second styling system during the current reimplementation.

React Aria Components is the strongest alternative to evaluate if device and assistive-technology testing finds interaction gaps in Radix. Base UI is worth monitoring, but a wholesale Radix-to-Base UI migration has no clear payoff for this repository today.

This is an inference from the repository facts and the sourced framework behavior below.

## Sourced facts

### Repository and design facts

- The project has already chosen a clean-slate, focused reimplementation rather than a compatibility fork. The upstream application is behavioral reference material, not an architectural constraint. See [ADR 0001](../adr/0001-focused-reimplementation.md).
- The client is a static, client-rendered React 19 and TypeScript SPA built with Vite. The ADR explicitly excludes SSR and React Server Components. Tailwind CSS and shadcn/ui are already part of that decision. See [ADR 0012](../adr/0012-serve-a-client-rendered-static-spa.md), [package.json](../../package.json), and [vite.config.ts](../../vite.config.ts).
- The current dependency set already includes `radix-ui`, `shadcn`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `vaul`, and Lucide React. See [package.json](../../package.json).
- `components.json` is configured for a Radix-based shadcn style, Tailwind CSS v4, CSS variables, and no RSC. The repository contains local wrappers for Radix Button, Dialog, Dropdown Menu, Select, Tabs, Scroll Area, Collapsible, and related primitives. See [components.json](../../components.json), [button.tsx](../../src/components/ui/button.tsx), [dialog.tsx](../../src/components/ui/dialog.tsx), and [select.tsx](../../src/components/ui/select.tsx).
- The styling layer is already a substantial product-specific system. The root CSS imports Tailwind and shadcn utilities, then imports custom theme, workspace, story, responsive, cast, import, and connection-settings styles. See [src/index.css](../../src/index.css).
- The theme uses CSS custom properties, `prefers-color-scheme`, explicit daylight and evening overrides, OKLCH colors, two type voices, and a restrained ambient field. See [theme.css](../../src/styles/theme.css) and [workspace.css](../../src/styles/workspace.css).
- The layout is not a generic dashboard. It reserves a fixed central story column, a left navigation rail, utility bays on both sides, and full-screen nested panel layers at narrow widths. See [DESIGN.md](../../DESIGN.md), [workspace.css](../../src/styles/workspace.css), and [responsive.css](../../src/styles/responsive.css).
- The difficult interaction code is product behavior rather than styling. `ActiveWritingWorkspace` owns paginated history, streaming generation and cancellation, authoritative reloads, `IntersectionObserver` reading state, and `useLayoutEffect` scroll anchoring. See [ActiveWritingWorkspace.tsx](../../src/client/workspace/ActiveWritingWorkspace.tsx).
- Feature components currently use native controls and bespoke presentation code for several important paths, including the two Control selectors, Message editing and Swipe navigation, and new Chat setup. See [ComposerControls.tsx](../../src/client/ComposerControls.tsx), [StoryMessageView.tsx](../../src/client/story/StoryMessageView.tsx), and [NewChatPanel.tsx](../../src/client/NewChatPanel.tsx).

### StyleX

- StyleX is a JavaScript styling library. Its stated goals include colocated styles, deterministic merging, typed style contracts, and build-time optimization. For styles created and applied in one file, the compiler can remove the normal `create` and `props` runtime work. Styles passed across files retain a small runtime cost. See the [StyleX README](https://github.com/facebook/stylex/blob/main/README.md) and [StyleX design principles](https://stylexjs.com/docs/learn/thinking-in-stylex).
- StyleX relies on ahead-of-time compilation. Its raw style objects must be statically analyzable. Arbitrary function calls, most imported values, and object spreads are not allowed in those objects. Dynamic styles exist, but the documentation describes them as an advanced feature to use sparingly. See [Defining styles](https://stylexjs.com/docs/learn/styling-ui/defining-styles).
- StyleX has an official Vite + React path through `@stylexjs/unplugin`. The plugin should run before the React plugin for Fast Refresh, and a CSS entrypoint is needed so the compiled StyleX output can be added to Vite's emitted CSS. See [StyleX Vite + React setup](https://stylexjs.com/docs/learn/installation/vite/vite-react) and [`@stylexjs/unplugin`](https://stylexjs.com/docs/api/configuration/unplugin).
- StyleX can place its generated rules in CSS layers and configure those layers relative to a utility framework such as Tailwind. That makes a hybrid technically possible, but it adds another cascade-order contract to the build. See the [`@stylexjs/postcss-plugin` layer configuration](https://stylexjs.com/docs/api/configuration/postcss-plugin).
- StyleX provides typed CSS variable and theme APIs through `defineVars` and `createTheme`. The theming documentation notes that `unstable_moduleResolution` must be enabled in the StyleX Babel configuration for those APIs. See [Defining variables](https://stylexjs.com/docs/learn/theming/defining-variables) and [Creating themes](https://stylexjs.com/docs/learn/theming/creating-themes).
- The official changelog currently shows StyleX `0.19.0` as the latest release, dated 2026-06-14, while the official repository also has a roadmap issue for `v1.0.0`. This is a lifecycle signal, not by itself a reason to reject the tool. See the [StyleX changelog](https://github.com/facebook/stylex/blob/main/CHANGELOG.md) and [StyleX v1.0.0 roadmap](https://github.com/facebook/stylex/issues/1356).

### Radix UI

- Radix describes its primitives as a low-level UI library that can be used as the base of a design system or adopted incrementally. See the [Radix repository README](https://github.com/radix-ui/primitives/blob/main/README.md).
- Radix primitives are unstyled and compatible with any styling solution. Consumers own the visual and functional CSS, while stateful parts expose attributes such as `data-state`. See [Radix styling](https://www.radix-ui.com/primitives/docs/guides/styling).
- Radix handles many accessibility details for its supported patterns, including ARIA semantics, focus management, and keyboard navigation. The project says its primitives are tested across browsers, devices, and assistive technologies. See [Radix accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility) and [Radix principles](https://github.com/radix-ui/primitives/blob/main/philosophy.md).
- Radix composition uses `asChild` to attach behavior to another element. The documentation requires the composed child to spread the received props and forward refs, and leaves responsibility for the final element's accessibility and behavior with the application. See [Radix composition](https://www.radix-ui.com/primitives/docs/guides/composition).
- Radix Dialog supports controlled and uncontrolled state, modal and non-modal modes, focus trapping in modal mode, Escape-to-close, and accessible Title and Description parts. Its default modal mode makes content underneath inert. Radix Popover supports collision-aware positioning, managed focus, customizable layering, and modal or non-modal modes. See [Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) and [Popover](https://www.radix-ui.com/primitives/docs/components/popover).
- Radix's styling guide makes an important boundary clear. Functional styles such as making an overlay cover the viewport are still the consumer's responsibility. See [Radix styling](https://www.radix-ui.com/primitives/docs/guides/styling).
- Radix Themes is a separate, pre-styled library. Its own documentation says its components are relatively closed and not always easy to override, and recommends using lower-level Primitives when a project needs substantial customization. That makes Radix Themes a poor fit for DitzyTavern's custom visual language even though Radix Primitives remain a good fit. See [Radix Themes getting started](https://www.radix-ui.com/themes/docs/overview/getting-started) and [Radix Themes styling](https://www.radix-ui.com/themes/docs/overview/styling).

### React Aria Components

- React Aria Components is an unstyled component library with built-in behavior, adaptive interactions, accessibility, and internationalization. Its official site says the components work with vanilla CSS, Tailwind, CSS-in-JS, and other styling approaches. See [React Aria](https://react-aria.adobe.com/).
- React Aria exposes states such as pressed, hovered, focused, and selected through attributes and render props. It supports custom classes and state-driven class functions. See [React Aria styling](https://react-aria.adobe.com/styling).
- React Aria's official documentation emphasizes mouse, touch, keyboard, focus management, and screen-reader behavior. It also provides low-level hooks when the component API is not flexible enough. See [React Aria components](https://react-aria.adobe.com/) and [customization](https://react-aria.adobe.com/customization).
- Adobe's React Aria Components RFC describes the component API as a way to remove hook wiring and accessibility glue for common cases. The same RFC acknowledges a steep learning curve in the lower-level API and a loss of some flexibility at the higher level. See the [React Aria Components RFC](https://github.com/adobe/react-spectrum/blob/main/rfcs/2023-react-aria-components.md).

### Base UI and shadcn/ui

- Base UI is an unstyled React component library with no bundled CSS. Its docs say it works with Tailwind, CSS Modules, CSS-in-JS, plain CSS, and other styling approaches. See [Base UI](https://base-ui.com/) and [Base UI styling](https://base-ui.com/react/handbook/styling).
- Base UI's official site says its API is intentionally close to Radix's API, while offering some deeper component coverage and edge-case handling. That is the project's claim, not an independent benchmark. See [Base UI's Radix comparison](https://base-ui.com/).
- shadcn/ui describes itself as open code and a code distribution platform rather than a traditional runtime component library. It adds component source to the application so the application owns and edits it. See [shadcn/ui introduction](https://ui.shadcn.com/docs) and [project setup](https://ui.shadcn.com/docs/new).
- shadcn/ui's July 2026 update made Base UI the default for new projects but explicitly kept Radix supported and said existing production projects do not need to migrate. See [Base UI as the default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default).

## Inference and project fit

### StyleX is not the missing framework

StyleX would improve how styles are authored and merged. It would not solve the parts of DitzyTavern that are currently hardest to get right: nested mobile panel behavior, focus and dismissal, accessible selectors, long-story reading geometry, streaming output, Swipe controls, and scroll preservation.

The repository already has a coherent token system and a deliberate CSS architecture. A StyleX migration would replace many existing selectors and class strings with statically analyzable JavaScript style objects, while the application would still need CSS for some global behavior and platform selectors. During a gradual migration, both systems would coexist. That is a large change in authoring model without evidence of a current performance or specificity failure.

The StyleX Vite integration is viable, but it would add a compiler plugin, StyleX runtime dependency, StyleX's ESLint-based lint rules alongside this repository's oxlint setup, and a second set of conventions. The typed theme APIs are attractive, but the project already has a theme preference plus semantic product tokens expressed as CSS custom properties and already switches themes through the document root. The likely return is lower than the migration cost.

Verdict: do not reimplement the frontend in StyleX. If CSS composition becomes a real problem, test StyleX in one new local primitive and measure build output, hot reload, linting, and visual parity before considering more.

### Radix is worth keeping, but only at the behavior seams

Radix matches the repository's design direction because it supplies behavior without imposing a visual system. The local wrappers and existing dependency make incremental adoption cheap compared with changing the whole styling stack.

The best candidates are controls where native HTML is not enough or where accessibility behavior is easy to get subtly wrong:

- `Select` or a Radix Popover for the two Composer Control selectors, while the atomic swap and server-authoritative pending state remain in application code.
- `DropdownMenu` or `Popover` for advanced Message actions and provenance controls.
- `Dialog` or `AlertDialog` for destructive confirmation and other genuinely focus-contained tasks.
- `Tooltip` for compact rail labels if the existing hover and focus labels need a shared implementation.

The desktop utility bays should remain product-owned layout. They are persistent side surfaces that preserve the story column's geometry, not ordinary modal dialogs. On mobile, a Radix Dialog can be appropriate when a panel becomes a true modal layer, but its inertness, focus return, portal, and overlay behavior must be tested against the design requirement to preserve story position and nesting context.

The story scroll container should not be replaced with a custom Scroll Area just because a wrapper exists. Its `scrollTop`, `scrollHeight`, IntersectionObserver, and prepend anchoring are part of the current reading behavior. A custom scrollbar can be evaluated later, after visual and scroll tests prove it does not change that contract.

Verdict: keep Radix and increase adoption selectively. It is the only option in this review that is already aligned with the codebase and already paid for in dependency and wrapper setup.

### React Aria is a credible alternative, not a second library to add

React Aria is especially relevant to the design's requirements for full mobile authoring parity, touch alternatives to hover, visible keyboard focus, and assistive-technology support. Its state model and render props could also fit the repository's need to expose partial and full Message metadata states.

The cost is overlap. Adding React Aria beside Radix would give the application two ways to implement menus, popovers, selects, dialogs, focus, and state styling. That makes the local design system harder to reason about. If real accessibility testing shows a Radix gap, evaluate React Aria as a replacement for a defined group of primitives, not as an extra general-purpose dependency.

Verdict: keep it as a fallback spike with a clear acceptance test, not as the default migration target.

### Base UI is a future option, not a reason to migrate now

Base UI deserves attention because it is unstyled, React-focused, close to Radix in API shape, and now the default base in new shadcn projects. But the shadcn team's own update says existing Radix projects do not need to move. The repository has no reported Radix defect, and switching would still require retesting focus, portals, menu behavior, controlled state, CSS selectors, and custom wrappers.

Verdict: do not run a Radix-to-Base UI migration as part of this reimplementation. Revisit only when a concrete missing component or reproducible behavior issue justifies it.

## Trade-offs

| Option | What it would improve | What it would cost here | Fit |
| --- | --- | --- | --- |
| Keep Tailwind + custom CSS + CSS variables | Preserves the existing visual language, token system, responsive geometry, and fast incremental work | Requires discipline around global selectors and local component boundaries | High |
| Adopt Radix incrementally | Focus, keyboard, ARIA, collision, menu, select, popover, and dialog behavior | Visual and layout CSS remains application-owned; composition requires careful prop and ref forwarding | High |
| Migrate styling to StyleX | Typed colocated styles, deterministic composition, build-time atomic CSS | Broad authoring-model migration, new compiler/lint path, static-analysis constraints, and temporary dual styling systems | Low now |
| Replace Radix with React Aria Components | Strong adaptive interaction model, state-driven styling, and low-level hooks | Overlapping component layer and a new API/learning curve | Medium only if testing finds gaps |
| Replace Radix with Base UI | Similar headless model and potentially broader component coverage | Migration and regression testing with no current problem to solve | Low now |
| Move to a full app framework such as Next.js | Server routing or SSR capabilities | Conflicts with the static SPA and server boundary already chosen in [ADR 0012](../adr/0012-serve-a-client-rendered-static-spa.md) | Low |

The ratings are inferences based on the repository facts above, not framework benchmarks.

## Adoption plan

1. Keep the application architecture fixed. Do not move away from Vite, the static SPA, or the server-owned HTTP and SSE contracts.
2. Write a short local primitive policy. Use native HTML for buttons, text fields, textareas, `select`, and `details` when their semantics meet the need. Use the local Radix wrappers for non-native behavior, overlays, menus, and composite selectors.
3. Pilot Radix in three bounded paths: the Composer Control selectors, import cancellation confirmation, and one advanced Message action menu. Preserve all current application reducers, revision checks, server acceptance rules, and error states.
4. Keep layout and reading behavior in the existing product-owned components and CSS. Do not make Dialog, Drawer, Popover, or Scroll Area responsible for the fixed desktop grid or story scroll anchoring.
5. Validate each pilot at desktop and mobile widths with keyboard navigation, focus return, touch interaction, reduced motion, long generated Messages, multiple Swipes, streaming, editing, and errors. Use the existing [Playwright tooling](../../package.json) and screenshot script where useful.
6. Only run a React Aria spike if the Radix pilots expose a reproducible accessibility or touch behavior gap. Only run a StyleX spike if a measured CSS maintenance or performance problem appears. A spike should be isolated, built, linted, and visually compared before it becomes a project convention.

## Decision gate

The frontend reimplementation is worth continuing because it is the product's chosen boundary and is necessary to realize the custom writing-studio composition described in [DESIGN.md](../../DESIGN.md). A framework rewrite is not worth doing merely to make the code look more framework-driven.

Adopt more Radix when it removes hand-written interaction behavior without changing the story geometry. Reconsider the primitive library only after a failing accessibility or interaction test. Reconsider StyleX only after a measured problem that its typed, deterministic styling model can solve better than the current CSS variables and local wrappers.
