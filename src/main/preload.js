"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("localContent", {
  getState: () => invoke("library:state"),
  chooseFolder: () => invoke("library:chooseFolder"),
  chooseRecycleBin: () => invoke("settings:chooseRecycleBin"),
  clearRecycleBin: () => invoke("settings:clearRecycleBin"),
  scan: () => invoke("library:scan"),
  updateMetadata: (assetId, patch) => invoke("metadata:update", assetId, patch),
  deleteAsset: (assetId) => invoke("library:delete", assetId),
  reveal: (assetId) => invoke("library:reveal", assetId),
  createPlan: (goal) => invoke("organizer:plan", goal),
  cancelPlan: () => invoke("organizer:cancel"),
  applyPlan: (planId, selectedItemIds) => invoke("organizer:apply", planId, selectedItemIds),
  onOrganizerProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("organizer:progress", listener);
    return () => ipcRenderer.removeListener("organizer:progress", listener);
  },
});
