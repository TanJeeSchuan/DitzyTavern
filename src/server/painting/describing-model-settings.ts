import { createModelSelectionSettings } from "../model-selection-settings";

export const { read: readDescribingModelSettings, apply: applyDescribingModelSettings } = createModelSelectionSettings({ namespace: "painting", key: "describing-model", apiFormat: "chat-completions", label: "describing model" });
