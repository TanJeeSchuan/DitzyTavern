// @approved
//  What a Box's client files may use from the host, beside the shared entry.
export type { BoxDataAction, MoveStaging } from "../client/box-windows/registry";
export { useBoxSetupDraft } from "../client/box-windows/useBoxSetupDraft";
export { boxDigestKey, useBoxStatus } from "../client/box-windows/PassageTimeline";
export type { BoxDataWrite } from "../shared/contract/box-actions";
export type { CastParticipant, ConversationSummary } from "../client/conversation";
export { BoxBlockNotice } from "../client/box-windows/BoxBlockNotice";
export { api, boxApi } from "../client/lib/eden";
export { foundOrNull, requestData, requestOutcome } from "../client/lib/request-outcome";
export { notFoundOutcome } from "../shared/contract/outcomes";
export { imageAccept, imageSrc, uploadImage } from "../client/lib/image";
export type { Portrait as PortraitImage } from "../shared/contract/image";
export { focalPosition, Portrait } from "../client/story/Portrait";
export { ProseEditor } from "../client/editor/ProseEditor";
export { Alert, AlertDescription } from "@/components/ui/alert";
export { Button } from "@/components/ui/button";
export { Field } from "@/components/ui/field";
export { Input } from "@/components/ui/input";
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
export { SegmentedControl } from "@/components/ui/segmented-control";
export { Slider } from "@/components/ui/slider";
export { Switch } from "@/components/ui/switch";
export { Textarea } from "@/components/ui/textarea";
