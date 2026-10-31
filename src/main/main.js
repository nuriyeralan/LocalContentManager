"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  session,
  shell,
} = require("electron");

const { MediaLibrary, isWithin } = require("./media-library");
const { MetadataStore } = require("./metadata-store");
const {
  createOrganizationPlan,
  createVisualOrganizationPlan,
  parseVisualRequest,
  selectPriorityCategory,
} = require("./organizer");
const { SettingsStore } = require("./settings-store");
const { VisionAnalyzer } = require("./vision-analyzer");
const { MODEL_REVISION } = require("./vision-constants");
const { requestKey, VisionStore } = require("./vision-store");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: "local-thumb",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

let mainWindow;
let settings;
let metadata;
let library;
let activePlan;
let activeScan;
let activeAnalysis = false;
let analysisCancelled = false;
let visionAnalyzer;
let visionStore;
const thumbnailCache = new Map();
const thumbnailJobs = new Map();
const MAX_CACHED_THUMBNAILS = 250;
const APP_TITLE = `LocalContentManager (${app.getVersion()})`;

function clearThumbnailCache() {
  thumbnailCache.clear();
  thumbnailJobs.clear();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function thumbnailFor(assetId) {
  const cached = thumbnailCache.get(assetId);
  if (cached) {
    thumbnailCache.delete(assetId);
    thumbnailCache.set(assetId, cached);
    return cached;
  }

  const pending = thumbnailJobs.get(assetId);
  if (pending) return pending;

  const assetPath = library.resolveAsset(assetId);
  if (!assetPath) return null;
  const job = nativeImage
    .createThumbnailFromPath(assetPath, { width: 480, height: 360 })
    .then((image) => {
      if (image.isEmpty()) return null;
      const thumbnail = image.toJPEG(82);
      thumbnailCache.set(assetId, thumbnail);
      if (thumbnailCache.size > MAX_CACHED_THUMBNAILS) {
        thumbnailCache.delete(thumbnailCache.keys().next().value);
      }
      return thumbnail;
    })
    .finally(() => thumbnailJobs.delete(assetId));
  thumbnailJobs.set(assetId, job);
  return job;
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url ?? "";
  if (!senderUrl.startsWith("file://")) throw new Error("Untrusted IPC sender.");
}

function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedSender(event);
      return { ok: true, data: await action(...args) };
    } catch (error) {
      console.error(`[ipc] ${channel} failed:`, error);
      return { ok: false, error: error instanceof Error ? error.message : "The operation failed." };
    }
  });
}

function libraryState() {
  const snapshot = library.publicSnapshot();
  return {
    ...snapshot,
    metadata: snapshot.rootPath ? metadata.list(snapshot.rootPath) : {},
    recycleBinRoot: settings.get().recycleBinRoot,
  };
}

function assertSeparateFolders(mediaRoot, recycleBinRoot) {
  if (!mediaRoot || !recycleBinRoot) return;
  if (isWithin(mediaRoot, recycleBinRoot) || isWithin(recycleBinRoot, mediaRoot)) {
    throw new Error("The recycling bin must be separate from the media library.");
  }
}

async function prepareVisionImage(asset) {
  const image = await nativeImage.createThumbnailFromPath(asset.absolutePath, {
    width: 512,
    height: 512,
  });
  if (image.isEmpty()) throw new Error(`Windows could not decode ${asset.name}.`);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  if (bitmap.length !== width * height * 4) {
    throw new Error(`Windows returned an unexpected pixel format for ${asset.name}.`);
  }

  const pixels = new Uint8Array(bitmap.length);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    pixels[offset] = bitmap[offset + 2];
    pixels[offset + 1] = bitmap[offset + 1];
    pixels[offset + 2] = bitmap[offset];
    pixels[offset + 3] = bitmap[offset + 3];
  }
  return { pixels, width, height };
}

async function createVisualPlan(request) {
  const assets = library.assetsByType("image");
  if (assets.length === 0) throw new Error("There are no images in the current library.");
  const analysisKey = requestKey(MODEL_REVISION, request.labels);
  const classified = [];
  let failed = 0;
  let processed = 0;
  let cached = 0;
  const batchSize = 4;

  send("organizer:progress", {
    phase: "starting",
    current: 0,
    total: assets.length,
    message: "Preparing private on-device visual analysis…",
  });

  for (let start = 0; start < assets.length; start += batchSize) {
    if (analysisCancelled) throw new Error("Visual analysis was cancelled. No plan was created.");
    const batch = assets.slice(start, start + batchSize);
    const pending = [];

    for (const asset of batch) {
      const cachedScores = visionStore.get(library.rootPath, asset, analysisKey);
      if (cachedScores) {
        cached += 1;
        const selection = selectPriorityCategory(cachedScores, request.categories.length);
        if (selection) classified.push({ asset, ...selection });
        continue;
      }

      try {
        pending.push({ asset, image: await prepareVisionImage(asset) });
      } catch (error) {
        failed += 1;
        console.error(`[vision] ${asset.relativePath} could not be decoded:`, error);
      }
    }

    if (pending.length > 0) {
      const scoreBatches = await visionAnalyzer.classify(
        pending.map(({ image }) => image),
        request.labels,
        (progress) => {
          const percent = progress.progress == null ? null : Math.round(progress.progress);
          send("organizer:progress", {
            phase: "model",
            current: processed,
            total: assets.length,
            message:
              percent == null
                ? "Loading the pinned local vision model…"
                : `Downloading the pinned local vision model… ${percent}%`,
          });
        },
      );
      if (analysisCancelled) throw new Error("Visual analysis was cancelled. No plan was created.");
      pending.forEach(({ asset }, index) => {
        const scores = scoreBatches[index];
        visionStore.set(library.rootPath, asset, analysisKey, scores);
        const selection = selectPriorityCategory(scores, request.categories.length);
        if (selection) classified.push({ asset, ...selection });
      });
      await visionStore.flush();
    }

    processed += batch.length;
    send("organizer:progress", {
      phase: "classifying",
      current: processed,
      total: assets.length,
      message: `Analyzed ${processed.toLocaleString()} of ${assets.length.toLocaleString()} images${cached ? ` (${cached.toLocaleString()} cached)` : ""}…`,
    });
  }

  return createVisualOrganizationPlan(request, classified, {
    total: assets.length,
    failed,
  });
}

async function scanConfiguredRoot() {
  const { mediaRoot } = settings.get();
  if (!mediaRoot) return libraryState();
  if (activeScan?.rootPath === mediaRoot) return activeScan.promise;
  if (activeScan) {
    try {
      await activeScan.promise;
    } catch (error) {
      console.error("[scan] Previous media root scan failed:", error);
    }
  }

  const scan = {
    rootPath: mediaRoot,
    promise: null,
  };
  scan.promise = (async () => {
    await library.scan(mediaRoot);
    clearThumbnailCache();
    activePlan = null;
    return libraryState();
  })();
  activeScan = scan;
  try {
    return await scan.promise;
  } finally {
    if (activeScan === scan) activeScan = null;
  }
}

function registerIpc() {
  handle("library:state", async () => {
    if (settings.get().mediaRoot && !library.rootPath) return scanConfiguredRoot();
    return libraryState();
  });
  handle("library:chooseFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose your media library",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const mediaRoot = await fs.realpath(result.filePaths[0]);
    assertSeparateFolders(mediaRoot, settings.get().recycleBinRoot);
    await settings.setMediaRoot(mediaRoot);
    return scanConfiguredRoot();
  });
  handle("settings:chooseRecycleBin", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a recycling bin folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const recycleBinRoot = await fs.realpath(result.filePaths[0]);
    assertSeparateFolders(library.rootPath ?? settings.get().mediaRoot, recycleBinRoot);
    await settings.setRecycleBinRoot(recycleBinRoot);
    return libraryState();
  });
  handle("settings:clearRecycleBin", async () => {
    await settings.setRecycleBinRoot(null);
    return libraryState();
  });
  handle("library:scan", scanConfiguredRoot);
  handle("library:reveal", async (assetId) => {
    const asset = library.getAsset(assetId);
    if (!asset) throw new Error("The media item is no longer available.");
    shell.showItemInFolder(asset.absolutePath);
    return true;
  });
  handle("metadata:update", async (assetId, patch) => {
    const asset = library.getAsset(assetId);
    if (!asset || !library.rootPath) throw new Error("The media item is no longer available.");
    return metadata.update(library.rootPath, asset.relativePath, patch);
  });
  handle("library:delete", async (assetId) => {
    const asset = library.getAsset(assetId);
    if (!asset || !library.rootPath) throw new Error("The media item is no longer available.");
    const mediaRoot = library.rootPath;
    const result = await library.deleteAsset(assetId, settings.get().recycleBinRoot);
    await metadata.remove(mediaRoot, asset.relativePath);
    visionStore.remove(mediaRoot, asset.relativePath);
    await visionStore.flush();
    thumbnailCache.delete(assetId);
    activePlan = null;
    return { ...result, state: libraryState() };
  });
  handle("organizer:plan", async (goal) => {
    if (!library.rootPath) throw new Error("Choose and scan a media folder first.");
    activePlan = null;
    const visualRequest = parseVisualRequest(goal);
    if (visualRequest) {
      if (activeAnalysis) throw new Error("Visual analysis is already running.");
      activeAnalysis = true;
      analysisCancelled = false;
      try {
        activePlan = await createVisualPlan(visualRequest);
        return activePlan;
      } finally {
        activeAnalysis = false;
        analysisCancelled = false;
      }
    }
    activePlan = createOrganizationPlan(
      goal,
      library.publicSnapshot().assets,
      metadata.list(library.rootPath),
    );
    return activePlan;
  });
  handle("organizer:cancel", () => {
    analysisCancelled = true;
    return true;
  });
  handle("organizer:apply", async (planId, selectedItemIds) => {
    if (
      !activePlan ||
      typeof planId !== "string" ||
      planId !== activePlan.id ||
      !Array.isArray(selectedItemIds)
    ) {
      throw new Error("This organization plan is no longer current.");
    }

    const selected = new Set(selectedItemIds);
    const permittedIds = new Set(activePlan.items.map((item) => item.id));
    if (selected.size === 0 || [...selected].some((id) => !permittedIds.has(id))) {
      throw new Error("Select at least one valid move from the current plan.");
    }

    const results = [];
    for (const item of activePlan.items) {
      if (!selected.has(item.id)) continue;
      const finalRelative = await library.moveAsset(
        item.assetId,
        item.sourceRelative,
        item.targetRelative,
      );
      await metadata.move(library.rootPath, item.sourceRelative, finalRelative);
      visionStore.move(library.rootPath, item.sourceRelative, finalRelative);
      results.push({ name: item.name, targetRelative: finalRelative });
    }

    await visionStore.flush();
    await library.scan(library.rootPath);
    clearThumbnailCache();
    activePlan = null;
    return { moved: results, state: libraryState() };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    title: APP_TITLE,
    backgroundColor: "#f4f6f3",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow.setTitle(APP_TITLE);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.localcontentmanager.app");
    settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
    metadata = new MetadataStore(path.join(app.getPath("userData"), "metadata.json"));
    visionStore = new VisionStore(path.join(app.getPath("userData"), "vision-analysis.json"));
    visionAnalyzer = new VisionAnalyzer(path.join(app.getPath("userData"), "vision-models"));
    library = new MediaLibrary();
    await Promise.all([settings.load(), metadata.load(), visionStore.load()]);

    protocol.handle("local-media", (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "asset") return new Response("Not found", { status: 404 });
      const id = url.pathname.slice(1);
      const assetPath = library.resolveAsset(id);
      if (!assetPath) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(assetPath).toString(), {
        headers: request.headers,
      });
    });
    protocol.handle("local-thumb", async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "asset") return new Response("Not found", { status: 404 });
      const thumbnail = await thumbnailFor(url.pathname.slice(1));
      if (!thumbnail) return new Response("Not found", { status: 404 });
      return new Response(thumbnail, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, max-age=3600",
        },
      });
    });

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    registerIpc();
    createWindow();

    const configuredRoot = settings.get().mediaRoot;
    if (configuredRoot) {
      try {
        await scanConfiguredRoot();
      } catch (error) {
        console.error("[startup] Could not scan the configured media folder:", error);
      }
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", async () => {
  analysisCancelled = true;
  await visionAnalyzer?.dispose();
  if (process.platform !== "darwin") app.quit();
});
