// @approved
//  What a Box's contract and shared files may use from the host. A Box file
// imports only its own folder and the SDK entries for its layer, which the
// `ditzy/no-box-boundary-imports` lint enforces.
export { automaticStatus, boxCatchUp, boxSlotStatus, isStale, type DigestStatus, type SlotStatus } from "../shared/contract/box-digest";
export { boxMovesOf, boxSetupOf } from "../shared/contract/box-value";
export type { DecisionAnswer } from "../shared/contract/decision-model";
export { boxSdkVersion, describeMoves, describeSetup, type BoxDescriptor } from "../shared/contract/box-descriptor";
export { invalidOutcome } from "../shared/contract/outcomes";
export { numericWire } from "../shared/contract/wire";
export { projectImageAnchors } from "../shared/image-reference";
export { MessageId, VariantId, ParticipantId, ParticipantKey } from "../shared/contract/box-row-reference";
