// @approved
//  Editable Participant-name default for blank captured author groups in a
// Chat import. The exact blank source value stays untouched in preserved
// source data; this name is the flow's proposed native Participant-name
// default. One constant serves both sides — the server import projection
// resolves every blank group to it, and the client flow shows it as the
// editable label — so the UI text can never drift from the server's
// derivation.
export const UNKNOWN_IMPORTED_AUTHOR_NAME = "Unknown imported author";
