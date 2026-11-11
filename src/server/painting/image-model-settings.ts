import { createModelSelectionSettings } from "../model-selection-settings";

export const { read: readImageModelSettings, apply: applyImageModelSettings } = createModelSelectionSettings({ namespace: "painting", key: "image-model", apiFormat: "images", label: "Image Model" });
