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

const { CategoryStore, validateCategoryName } = require("./category-store");
const { Deduplication } = require("./deduplication");
const { MediaLibrary, isWithin } = require("./media-library");
const { guardBrokenPipe, LocalLogger } = require("./local-logger");
const { MetadataStore } = require("./metadata-store");
const {
  createOrganizationPlan,
  createVisualOrganizationPlan,
  looksLikeVisualRequest,
  parseVisualRequest,
  selectPriorityCategory,
} = require("./organizer");
const { RecommendationStore } = require("./recommendation-store");
const { SettingsStore } = require("./settings-store");
const { normalizeConcurrency, VisionAnalyzer } = require("./vision-analyzer");
const { requestKey, VisionStore } = require("./vision-store");
const { productName } = require("../../package.json");

const logger = new LocalLogger();
guardBrokenPipe(process.stdout, logger, "stdout");
guardBrokenPipe(process.stderr, logger, "stderr");
app.setName(productName);

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
let categoryStore;
let recommendationStore;
let library;
let deduplication;
let activePlan;
let activeScan;
let activeAnalysis = false;
let analysisCancelled = false;
let visionAnalyzer;
let visionStore;
let recommendationQueue = [];
const queuedRecommendations = new Set();
let recommendationWorkers = 0;
let recommendationGeneration = 0;
const thumbnailCache = new Map();
const thumbnailJobs = new Map();
const MAX_CACHED_THUMBNAILS = 250;
const APP_TITLE = `${productName} (${app.getVersion()})`;

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
      if (deduplication?.active && [
        "library:chooseFolder", "library:scan", "library:delete",
        "categories:assign", "organizer:apply", "organizer:plan",
      ].includes(channel)) {
        throw new Error("Close deduplication before changing or rescanning the library.");
      }
      if ((deduplication?.worker || deduplication?.applying) &&
        ["settings:chooseRecycleBin", "settings:clearRecycleBin"].includes(channel)) {
        throw new Error("Wait for deduplication to finish before changing the recycling folder.");
      }
      return { ok: true, data: await action(...args) };
    } catch (error) {
      logger.error(`[ipc] ${channel} failed`, error);
      return { ok: false, error: error instanceof Error ? error.message : "The operation failed." };
    }
  });
}

function libraryState() {
  const snapshot = library.publicSnapshot();
  return {
    ...snapshot,
    configuredMediaRoot: settings.get().mediaRoot,
    categories: snapshot.rootPath ? categoryStore.list(snapshot.rootPath) : [],
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

async function prepareVisionImage(asset, maxImageSize) {
  let image = await nativeImage.createThumbnailFromPath(asset.absolutePath, {
    width: 1280,
    height: 1280,
  });
  if (image.isEmpty()) throw new Error(`Windows could not decode ${asset.name}.`);
  let jpeg = image.toJPEG(88);
  while (
    maxImageSize &&
    jpeg.length > maxImageSize &&
    Math.max(image.getSize().width, image.getSize().height) > 320
  ) {
    const size = image.getSize();
    image = image.resize({
      width: Math.max(320, Math.round(size.width * 0.75)),
      height: Math.max(320, Math.round(size.height * 0.75)),
      quality: "good",
    });
    jpeg = image.toJPEG(82);
  }
  if (maxImageSize && jpeg.length > maxImageSize) {
    throw new Error(`The resized copy of ${asset.name} exceeds the selected model's image limit.`);
  }
  return { base64: jpeg.toString("base64") };
}

function invalidateRecommendationQueue() {
  recommendationGeneration += 1;
  recommendationQueue = [];
  queuedRecommendations.clear();
}

function sendRecommendation(assetId, payload) {
  send("categories:recommendation", { assetId, ...payload });
}

async function enqueueRecommendations(assetIds, force = false) {
  if (!library.rootPath || !Array.isArray(assetIds)) return { queued: 0, cached: 0 };
  const categories = categoryStore.list(library.rootPath);
  if (categories.length === 0) return { queued: 0, cached: 0 };
  const model = await visionAnalyzer.resolveModel(settings.get().visionModel);
  const analysisKey = requestKey(
    `recommend:${model.id}`,
    categories.map((category) => `${category.name}\0${category.description}`),
  );
  const generation = recommendationGeneration;
  let queued = 0;
  let cached = 0;

  for (const assetId of assetIds.slice(0, 30)) {
    const asset = library.getAsset(assetId);
    if (!asset || asset.type !== "image") continue;
    const stored = force
      ? null
      : recommendationStore.get(library.rootPath, asset, analysisKey);
    if (stored) {
      cached += 1;
      sendRecommendation(assetId, { status: "ready", recommendation: stored });
      continue;
    }
    const queueKey = `${analysisKey}:${assetId}`;
    if (queuedRecommendations.has(queueKey)) continue;
    queuedRecommendations.add(queueKey);
    recommendationQueue.push({
      analysisKey,
      assetId,
      categories,
      generation,
      model,
      queueKey,
    });
    queued += 1;
  }
  startRecommendationWorkers();
  return { queued, cached };
}

function startRecommendationWorkers() {
  const maximum = settings.get().visionConcurrency;
  while (recommendationWorkers < maximum && recommendationQueue.length > 0) {
    runRecommendationWorker();
  }
}

async function runRecommendationWorker() {
  recommendationWorkers += 1;
  try {
    while (recommendationQueue.length > 0) {
      const job = recommendationQueue.shift();
      queuedRecommendations.delete(job.queueKey);
      if (job.generation !== recommendationGeneration) continue;
      const asset = library.getAsset(job.assetId);
      if (!asset) continue;
      sendRecommendation(job.assetId, { status: "analyzing" });
      try {
        const image = await prepareVisionImage(asset, job.model.maxImageSize);
        const recommendation = await visionAnalyzer.recommendCategory(
          image,
          job.categories,
          job.model,
        );
        if (
          job.generation !== recommendationGeneration ||
          !library.getAsset(job.assetId)
        ) {
          continue;
        }
        const result = { ...recommendation, modelName: job.model.name };
        recommendationStore.set(
          library.rootPath,
          asset,
          job.analysisKey,
          result,
        );
        await recommendationStore.flush();
        sendRecommendation(job.assetId, {
          status: "ready",
          recommendation: result,
        });
      } catch (error) {
        logger.error("[recommendation] Background category analysis failed", error);
        if (job.generation === recommendationGeneration) {
          sendRecommendation(job.assetId, {
            status: "error",
            error: error instanceof Error ? error.message : "Recommendation failed.",
          });
        }
      }
    }
  } finally {
    recommendationWorkers -= 1;
    if (recommendationQueue.length > 0) startRecommendationWorkers();
  }
}

async function createVisualPlan(request, resolvedModel = null) {
  const assets = library.assetsByType("image");
  if (assets.length === 0) throw new Error("There are no images in the current library.");
  const model =
    resolvedModel ?? (await visionAnalyzer.resolveModel(settings.get().visionModel));
  const analysisKey = requestKey(`copilot:${model.id}`, request.labels);
  const classified = [];
  let failed = 0;
  let processed = 0;
  let cached = 0;
  const batchSize = Math.max(1, Math.min(4, model.maxImages));
  const concurrency = normalizeConcurrency(
    settings.get().visionConcurrency,
    Math.ceil(assets.length / batchSize),
  );
  const assetOrder = new Map(assets.map((asset, index) => [asset.id, index]));
  let nextIndex = 0;
  const analysisStartedAt = Date.now();

  function progressTiming() {
    const elapsedMs = Date.now() - analysisStartedAt;
    return {
      elapsedMs,
      etaMs:
        processed > 0
          ? Math.max(0, Math.round((elapsedMs / processed) * (assets.length - processed)))
          : null,
    };
  }

  send("organizer:progress", {
    phase: "starting",
    current: 0,
    total: assets.length,
    concurrency,
    ...progressTiming(),
    message: `Preparing ${model.name} cloud visual analysis with ${concurrency} parallel request${concurrency === 1 ? "" : "s"}…`,
  });

  async function processBatches() {
    while (true) {
      if (analysisCancelled) {
        throw new Error("Visual analysis was cancelled. No plan was created.");
      }
      const start = nextIndex;
      nextIndex += batchSize;
      if (start >= assets.length) return;
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
          pending.push({
            asset,
            image: await prepareVisionImage(asset, model.maxImageSize),
          });
        } catch (error) {
          failed += 1;
          logger.error(`[vision] ${asset.relativePath} could not be decoded`, error);
        }
      }

      if (pending.length > 0) {
        const scoreBatches = await visionAnalyzer.classify(
          pending.map(({ image }) => image),
          request,
          model,
          (attempt) => {
            send("organizer:progress", {
              phase: "retrying",
              current: processed,
              total: assets.length,
              concurrency,
              ...progressTiming(),
              message: `Retrying ${model.name} request (attempt ${attempt} of 3)…`,
            });
          },
        );
        if (analysisCancelled) {
          throw new Error("Visual analysis was cancelled. No plan was created.");
        }
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
        concurrency,
        ...progressTiming(),
        message: `Analyzed ${processed.toLocaleString()} of ${assets.length.toLocaleString()} images with ${model.name} using ${concurrency} parallel request${concurrency === 1 ? "" : "s"}${cached ? ` (${cached.toLocaleString()} cached)` : ""}…`,
      });
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => processBatches()));
  } catch (error) {
    analysisCancelled = true;
    await visionAnalyzer.cancel();
    throw error;
  }
  classified.sort((left, right) => assetOrder.get(left.asset.id) - assetOrder.get(right.asset.id));

  return createVisualOrganizationPlan(request, classified, {
    total: assets.length,
    failed,
    modelName: model.name,
  });
}

async function refreshLibrary(rootPath) {
  try {
    await library.scan(rootPath, (progress) => send("library:progress", progress));
    send("library:progress", { phase: "categories", current: library.assets.size });
    await categoryStore.refresh(library.rootPath);
    send("library:progress", { phase: "complete", current: library.assets.size });
  } catch (error) {
    send("library:progress", { phase: "error", message: error.message });
    throw error;
  }
}

async function scanConfiguredRoot() {
  const { mediaRoot } = settings.get();
  if (!mediaRoot) return libraryState();
  if (activeScan?.rootPath === mediaRoot) return activeScan.promise;
  if (activeScan) {
    try {
      await activeScan.promise;
    } catch (error) {
      logger.error("[scan] Previous media root scan failed", error);
    }
  }

  const scan = {
    rootPath: mediaRoot,
    promise: null,
  };
  scan.promise = (async () => {
    await refreshLibrary(mediaRoot);
    invalidateRecommendationQueue();
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

async function moveAssetWithLocalData(asset, targetRelative) {
  const finalRelative = await library.moveAsset(
    asset.id,
    asset.relativePath,
    targetRelative,
  );
  await metadata.move(library.rootPath, asset.relativePath, finalRelative);
  visionStore.move(library.rootPath, asset.relativePath, finalRelative);
  recommendationStore.move(library.rootPath, asset.relativePath, finalRelative);
  await Promise.all([visionStore.flush(), recommendationStore.flush()]);
  return finalRelative;
}

async function removeAssetLocalData(asset) {
  await metadata.remove(library.rootPath, asset.relativePath);
  visionStore.remove(library.rootPath, asset.relativePath);
  recommendationStore.remove(library.rootPath, asset.relativePath);
  await Promise.all([visionStore.flush(), recommendationStore.flush()]);
  thumbnailCache.delete(asset.id);
  activePlan = null;
}

function registerIpc() {
  handle("deduplication:scan", async (method, sensitivity, concurrency) => {
    if (activeScan || activeAnalysis) throw new Error("Wait for the current scan or analysis to finish.");
    invalidateRecommendationQueue();
    return deduplication.scan(method, sensitivity, (progress) => {
      if (progress.failure?.kind === "decoderCrash") {
        logger.error(`[deduplication] Decoder crash for ${progress.failure.path}`,
          new Error(progress.failure.error));
      }
      send("deduplication:progress", progress);
    }, concurrency);
  });
  handle("deduplication:cancel", () => deduplication.cancel());
  handle("deduplication:recycle", async (planId, choices) => {
    if (deduplication.worker || deduplication.applying) throw new Error("Deduplication is already working.");
    const recycleRoot = settings.get().recycleBinRoot;
    if (!recycleRoot) throw new Error("Choose a recycling folder first. Deduplication never permanently deletes.");
    const result = await deduplication.recycleChoices(
      planId, choices, recycleRoot, removeAssetLocalData,
      (progress) => send("deduplication:progress", progress),
    );
    if (result.error) logger.error("[deduplication] Recycling stopped", new Error(result.error));
    return { ...result, state: libraryState() };
  });
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
    const selectedMediaRoot = result.filePaths[0];
    const resolvedMediaRoot = await fs.realpath(selectedMediaRoot);
    const recycleBinRoot = settings.get().recycleBinRoot;
    const resolvedRecycleBin = recycleBinRoot ? await fs.realpath(recycleBinRoot) : null;
    assertSeparateFolders(resolvedMediaRoot, resolvedRecycleBin);
    await settings.commitUserSelection(
      "mediaRoot",
      selectedMediaRoot,
      "media-folder-picker",
    );
    invalidateRecommendationQueue();
    return scanConfiguredRoot();
  });
  handle("settings:chooseRecycleBin", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a recycling bin folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedRecycleBin = result.filePaths[0];
    const resolvedRecycleBin = await fs.realpath(selectedRecycleBin);
    const configuredMediaRoot = settings.get().mediaRoot;
    const resolvedMediaRoot =
      library.rootPath ?? (configuredMediaRoot ? await fs.realpath(configuredMediaRoot) : null);
    assertSeparateFolders(resolvedMediaRoot, resolvedRecycleBin);
    await settings.commitUserSelection(
      "recycleBinRoot",
      selectedRecycleBin,
      "recycle-folder-picker",
    );
    return libraryState();
  });
  handle("settings:clearRecycleBin", async () => {
    if (!settings.get().recycleBinRoot) return libraryState();
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Use permanent deletion?",
      message: "Clear the recycling folder setting?",
      detail:
        "Future deletions will permanently remove media from disk. This setting can only be changed by your confirmation.",
      buttons: ["Keep recycling folder", "Use permanent deletion"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return null;
    await settings.commitUserSelection(
      "recycleBinRoot",
      null,
      "confirmed-recycle-clear",
    );
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
    const result = await library.deleteAsset(assetId, settings.get().recycleBinRoot);
    await removeAssetLocalData(asset);
    return { ...result, state: libraryState() };
  });
  handle("categories:assign", async (assetId, requestedCategory, description = "") => {
    const asset = library.getAsset(assetId);
    if (!asset || !library.rootPath) throw new Error("The media item is no longer available.");
    const category = categoryStore.list(library.rootPath)
      .find((entry) => entry.name === requestedCategory)?.name ??
      validateCategoryName(requestedCategory);
    await fs.mkdir(path.join(library.rootPath, category), { recursive: true });
    const categoriesBefore = JSON.stringify(categoryStore.list(library.rootPath));
    const storedCategory = await categoryStore.add(
      library.rootPath,
      category,
      description,
    );
    if (JSON.stringify(categoryStore.list(library.rootPath)) !== categoriesBefore) {
      invalidateRecommendationQueue();
    }
    const currentParent = path.dirname(asset.relativePath);
    let finalRelative = asset.relativePath;
    if (currentParent.toLocaleLowerCase() !== storedCategory.name.toLocaleLowerCase()) {
      finalRelative = await moveAssetWithLocalData(
        asset,
        path.join(storedCategory.name, asset.name),
      );
      await refreshLibrary(library.rootPath);
      clearThumbnailCache();
    }
    activePlan = null;
    return {
      category: storedCategory,
      moved: finalRelative !== asset.relativePath,
      finalRelative,
      state: libraryState(),
    };
  });
  handle("categories:updateDescription", async (category, description) => {
    if (!library.rootPath) throw new Error("Choose and scan a media folder first.");
    const updated = await categoryStore.updateDescription(
      library.rootPath,
      category,
      description,
    );
    invalidateRecommendationQueue();
    return { category: updated, state: libraryState() };
  });
  handle("categories:recommend", async (assetId) => {
    const asset = library.getAsset(assetId);
    if (!asset || !library.rootPath) throw new Error("The media item is no longer available.");
    const categories = categoryStore.list(library.rootPath);
    if (categories.length === 0) {
      throw new Error("Create at least one category before asking for a recommendation.");
    }
    if (activeAnalysis) throw new Error("Another AI analysis is already running.");
    activeAnalysis = true;
    try {
      const model = await visionAnalyzer.resolveModel(settings.get().visionModel);
      const image = await prepareVisionImage(asset, model.maxImageSize);
      const recommendation = await visionAnalyzer.recommendCategory(
        image,
        categories,
        model,
      );
      return { ...recommendation, modelName: model.name };
    } finally {
      activeAnalysis = false;
    }
  });
  handle("categories:precompute", async (assetIds, force = false) => {
    if (
      !Array.isArray(assetIds) ||
      assetIds.some((assetId) => typeof assetId !== "string")
    ) {
      throw new Error("Recommendation precompute requires media item identifiers.");
    }
    return enqueueRecommendations(assetIds, force === true);
  });
  handle("categories:draftDescription", async (assetId, requestedCategory) => {
    const asset = library.getAsset(assetId);
    if (!asset || !library.rootPath) throw new Error("The media item is no longer available.");
    const category = categoryStore.list(library.rootPath)
      .find((entry) => entry.name === requestedCategory)?.name ??
      validateCategoryName(requestedCategory);
    if (activeAnalysis) throw new Error("Another AI analysis is already running.");
    activeAnalysis = true;
    try {
      const model = await visionAnalyzer.resolveModel(settings.get().visionModel);
      const image = await prepareVisionImage(asset, model.maxImageSize);
      const description = await visionAnalyzer.draftCategoryDescription(
        image,
        category,
        model,
      );
      return { category, description, modelName: model.name };
    } finally {
      activeAnalysis = false;
    }
  });
  handle("organizer:plan", async (goal) => {
    if (!library.rootPath) throw new Error("Choose and scan a media folder first.");
    activePlan = null;
    let visualRequest = parseVisualRequest(goal);
    if (visualRequest || looksLikeVisualRequest(goal)) {
      if (activeAnalysis) throw new Error("Visual analysis is already running.");
      activeAnalysis = true;
      analysisCancelled = false;
      try {
        let model;
        if (!visualRequest) {
          model = await visionAnalyzer.resolveModel(settings.get().visionModel);
          send("organizer:progress", {
            phase: "interpreting",
            current: 0,
            total: 0,
            concurrency: 1,
            elapsedMs: 0,
            etaMs: null,
            message: `Interpreting the visual command with ${model.name}…`,
          });
          visualRequest = await visionAnalyzer.interpretRequest(
            goal,
            model,
            (attempt) => {
              send("organizer:progress", {
                phase: "retrying",
                current: 0,
                total: 0,
                concurrency: 1,
                elapsedMs: 0,
                etaMs: null,
                message: `Retrying command interpretation (attempt ${attempt} of 3)…`,
              });
            },
          );
        }
        activePlan = await createVisualPlan(visualRequest, model);
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
  handle("organizer:cancel", async () => {
    analysisCancelled = true;
    await visionAnalyzer.cancel();
    return true;
  });
  handle("vision:models", async () => {
    const catalog = await visionAnalyzer.listModels();
    const resolved = catalog.models.length
      ? await visionAnalyzer.resolveModel(settings.get().visionModel)
      : null;
    return {
      auth: catalog.auth,
      models: catalog.models,
      configuredModel: settings.get().visionModel,
      selectedModel: resolved?.id ?? null,
      concurrency: settings.get().visionConcurrency,
    };
  });
  handle("vision:setModel", async (modelId) => {
    const catalog = await visionAnalyzer.listModels();
    if (!catalog.models.some((model) => model.id === modelId)) {
      throw new Error("That model is not currently available to this Copilot account.");
    }
    await settings.commitUserSelection("visionModel", modelId, "model-picker");
    invalidateRecommendationQueue();
    return modelId;
  });
  handle("vision:setConcurrency", async (value) => {
    await settings.commitUserSelection(
      "visionConcurrency",
      value,
      "concurrency-picker",
    );
    visionAnalyzer.setMaxConcurrency(value);
    startRecommendationWorkers();
    return value;
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
      recommendationStore.move(
        library.rootPath,
        item.sourceRelative,
        finalRelative,
      );
      if (item.registerCategory) {
        const categoriesBefore = categoryStore.list(library.rootPath).length;
        await categoryStore.add(
          library.rootPath,
          item.targetRelative.split(path.sep)[0],
        );
        if (categoryStore.list(library.rootPath).length !== categoriesBefore) {
          invalidateRecommendationQueue();
        }
      }
      results.push({ name: item.name, targetRelative: finalRelative });
    }

    await Promise.all([visionStore.flush(), recommendationStore.flush()]);
    await refreshLibrary(library.rootPath);
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
    logger.initialize(app.getPath("userData"));
    settings = new SettingsStore(
      path.join(app.getPath("userData"), "settings.json"),
      path.join(app.getPath("userData"), "settings-audit.jsonl"),
    );
    metadata = new MetadataStore(path.join(app.getPath("userData"), "metadata.json"));
    categoryStore = new CategoryStore(path.join(app.getPath("userData"), "categories.json"));
    recommendationStore = new RecommendationStore(
      path.join(app.getPath("userData"), "category-recommendations.json"),
    );
    visionStore = new VisionStore(path.join(app.getPath("userData"), "vision-analysis.json"));
    visionAnalyzer = new VisionAnalyzer(app.getPath("userData"), logger);
    library = new MediaLibrary();
    deduplication = new Deduplication(library);
    await Promise.all([
      settings.load(),
      metadata.load(),
      categoryStore.load(),
      recommendationStore.load(),
      visionStore.load(),
    ]);
    visionAnalyzer.setMaxConcurrency(settings.get().visionConcurrency);

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
        logger.error("[startup] Could not scan the configured media folder", error);
      }
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", async () => {
  analysisCancelled = true;
  invalidateRecommendationQueue();
  await visionAnalyzer?.dispose();
  if (process.platform !== "darwin") app.quit();
});
