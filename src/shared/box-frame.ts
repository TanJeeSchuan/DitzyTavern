/** @approved The host route serving every Box frame's document. */
export const boxFrameRoute = "/api/box-frame";

/** @approved The app page's policy: its only frames are Box frames from the host's frame route, a backstop to each frame's own sandbox. */
export const appPagePolicy = (host: string) => `frame-src ${host}${boxFrameRoute}`;
