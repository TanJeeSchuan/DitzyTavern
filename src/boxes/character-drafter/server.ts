import type { Box } from "@/box-sdk/server";
import { drafterRoutes } from "./server-routes";

// @approved
//  The drafter has no state, records or advance: its routes read the Chat
// and the other Boxes' Exports and hand the writer a draft.
const characterDrafterBox = { routes: drafterRoutes } satisfies Box<undefined>;
export default characterDrafterBox;
