"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("localContent", {
  getState: () => invoke("library:state"),
  chooseFolder: () => invoke("library:chooseFolder"),
  chooseRecycleBin: () => invoke("settings:chooseRecycleBin"),
  clearRecycleBin: () => invoke("settings:clearRecycleBin"),
  scan: () => invoke("library:scan"),
  onLibraryProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("library:progress", listener);
    return () => ipcRenderer.removeListener("library:progress", listener);
  },
  scanDuplicates: (method, sensitivity, concurrency) =>
    invoke("deduplication:scan", method, sensitivity, concurrency),
  cancelDeduplication: () => invoke("deduplication:cancel"),
  recycleDuplicates: (planId, choices) =>
    invoke("deduplication:recycle", planId, choices),
  onDeduplicationProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("deduplication:progress", listener);
    return () => ipcRenderer.removeListener("deduplication:progress", listener);
  },
  updateMetadata: (assetId, patch) => invoke("metadata:update", assetId, patch),
  assignCategory: (assetId, category, description) =>
    invoke("categories:assign", assetId, category, description),
  updateCategoryDescription: (category, description) =>
    invoke("categories:updateDescription", category, description),
  recommendCategory: (assetId) => invoke("categories:recommend", assetId),
  precomputeCategoryRecommendations: (assetIds, force = false) =>
    invoke("categories:precompute", assetIds, force),
  draftCategoryDescription: (assetId, category) =>
    invoke("categories:draftDescription", assetId, category),
  deleteAsset: (assetId) => invoke("library:delete", assetId),
  reveal: (assetId) => invoke("library:reveal", assetId),
  createPlan: (goal) => invoke("organizer:plan", goal),
  cancelPlan: () => invoke("organizer:cancel"),
  applyPlan: (planId, selectedItemIds) => invoke("organizer:apply", planId, selectedItemIds),
  listVisionModels: () => invoke("vision:models"),
  setVisionModel: (modelId) => invoke("vision:setModel", modelId),
  setVisionConcurrency: (value) => invoke("vision:setConcurrency", value),
  onOrganizerProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("organizer:progress", listener);
    return () => ipcRenderer.removeListener("organizer:progress", listener);
  },
  onCategoryRecommendation: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("categories:recommendation", listener);
    return () => ipcRenderer.removeListener("categories:recommendation", listener);
  },
});
