// @approved
//  What a Box's contract and shared files may use from the host. A Box file
// imports only its own folder and the SDK entries for its layer, which the
// `ditzy/no-box-boundary-imports` lint enforces.
export { imageHash } from "../shared/contract/image";
