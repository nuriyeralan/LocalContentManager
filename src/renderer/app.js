const api = window.localContent;

const elements = {
  rootName: document.getElementById("root-name"),
  rootPath: document.getElementById("root-path"),
  chooseFolder: document.getElementById("choose-folder"),
  welcomeChoose: document.getElementById("welcome-choose"),
  recycleName: document.getElementById("recycle-name"),
  recyclePath: document.getElementById("recycle-path"),
  chooseRecycle: document.getElementById("choose-recycle"),
  clearRecycle: document.getElementById("clear-recycle"),
  categoryView: document.getElementById("category-view"),
  rescan: document.getElementById("rescan"),
  search: document.getElementById("search"),
  viewTitle: document.getElementById("view-title"),
  welcome: document.getElementById("welcome"),
  collection: document.getElementById("collection"),
  grid: document.getElementById("media-grid"),
  emptyResults: document.getElementById("empty-results"),
  resultSummary: document.getElementById("result-summary"),
  librarySize: document.getElementById("library-size"),
  filters: [...document.querySelectorAll(".filter")],
  counts: {
    all: document.getElementById("count-all"),
    image: document.getElementById("count-image"),
    video: document.getElementById("count-video"),
    audio: document.getElementById("count-audio"),
    favorite: document.getElementById("count-favorite"),
  },
  detailsDialog: document.getElementById("details-dialog"),
  detailsForm: document.getElementById("details-form"),
  detailsPreview: document.getElementById("details-preview"),
  previousImage: document.getElementById("previous-image"),
  nextImage: document.getElementById("next-image"),
  detailsType: document.getElementById("details-type"),
  detailsName: document.getElementById("details-name"),
  detailsPath: document.getElementById("details-path"),
  detailsSize: document.getElementById("details-size"),
  detailsDate: document.getElementById("details-date"),
  detailsTags: document.getElementById("details-tags"),
  detailsFavorite: document.getElementById("details-favorite"),
  revealFile: document.getElementById("reveal-file"),
  deleteFile: document.getElementById("delete-file"),
  detailsCategories: document.getElementById("details-categories"),
  newCategoryName: document.getElementById("new-category-name"),
  newCategoryDescription: document.getElementById("new-category-description"),
  draftCategoryDescription: document.getElementById("draft-category-description"),
  createCategory: document.getElementById("create-category"),
  recommendCategory: document.getElementById("recommend-category"),
  categoryRecommendation: document.getElementById("category-recommendation"),
  categoryRecommendationText: document.getElementById("category-recommendation-text"),
  applyRecommendation: document.getElementById("apply-recommendation"),
  categoryEditor: document.getElementById("category-editor"),
  categoryEditorForm: document.getElementById("category-editor-form"),
  categoryEditorName: document.getElementById("category-editor-name"),
  categoryEditorDescription: document.getElementById("category-editor-description"),
  categoryEditorError: document.getElementById("category-editor-error"),
  categoryEditorCancel: document.getElementById("category-editor-cancel"),
  categoryEditorSave: document.getElementById("category-editor-save"),
  organizerDialog: document.getElementById("organizer-dialog"),
  openOrganizer: document.getElementById("open-organizer"),
  closeOrganizer: document.getElementById("close-organizer"),
  visionModel: document.getElementById("vision-model"),
  visionConcurrency: document.getElementById("vision-concurrency"),
  visionModelStatus: document.getElementById("vision-model-status"),
  analysisProgress: document.getElementById("analysis-progress"),
  analysisProgressBar: document.getElementById("analysis-progress-bar"),
  analysisProgressCount: document.getElementById("analysis-progress-count"),
  analysisProgressEta: document.getElementById("analysis-progress-eta"),
  goalForm: document.getElementById("goal-form"),
  goal: document.getElementById("goal"),
  goalStatus: document.getElementById("goal-status"),
  cancelAnalysis: document.getElementById("cancel-analysis"),
  plan: document.getElementById("plan"),
  planSummary: document.getElementById("plan-summary"),
  planItems: document.getElementById("plan-items"),
  selectAll: document.getElementById("select-all"),
  selectedSummary: document.getElementById("selected-summary"),
  applyPlan: document.getElementById("apply-plan"),
  toast: document.getElementById("toast"),
};

const state = {
  rootPath: null,
  configuredMediaRoot: null,
  assets: [],
  metadata: {},
  categories: [],
  categoryFilter: null,
  recycleBinRoot: null,
  filter: "all",
  search: "",
  selectedAssetId: null,
  previewAssetIds: [],
  previewIndex: -1,
  categoryRecommendation: null,
  categoryRecommendationStatus: null,
  categoryRecommendations: new Map(),
  editingCategory: null,
  plan: null,
  selectedPlanItemIds: new Set(),
  visionModelsLoaded: false,
  busy: false,
};

let toastTimer;
const GRID_GAP = 16;
const MIN_CARD_WIDTH = 210;
const CARD_BODY_HEIGHT = 82;
const OVERSCAN_ROWS = 3;
const WINDOW_CHUNK_ROWS = 5;
const PLAN_ROW_HEIGHT = 56;
const PLAN_OVERSCAN_ROWS = 5;
const virtualGrid = {
  assets: [],
  columns: 0,
  cardWidth: 0,
  rowHeight: 0,
  startIndex: -1,
  endIndex: -1,
  animationFrame: 0,
};
const virtualPlan = {
  canvas: null,
  startIndex: -1,
  endIndex: -1,
  animationFrame: 0,
};

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3500);
}

function requireSuccess(result) {
  if (!result?.ok) throw new Error(result?.error || "The operation failed.");
  return result.data;
}

function metadataKey(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function metadataFor(asset) {
  return state.metadata[metadataKey(asset.relativePath)] ?? { tags: [], favorite: false };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function typeLabel(type) {
  return { image: "Photo", video: "Video", audio: "Audio" }[type] ?? "Media";
}

function createPreview(asset, detailed = false) {
  if (asset.type === "image") {
    const image = document.createElement("img");
    image.src = detailed ? asset.previewUrl || asset.mediaUrl : asset.thumbnailUrl;
    image.alt = detailed ? asset.name : "";
    image.loading = "lazy";
    image.decoding = "async";
    image.fetchPriority = detailed ? "high" : "low";
    if (detailed && asset.thumbnailUrl && asset.previewUrl !== asset.thumbnailUrl) {
      image.addEventListener(
        "error",
        () => {
          image.src = asset.thumbnailUrl;
        },
        { once: true },
      );
    }
    return image;
  }
  if (asset.type === "video") {
    if (!detailed) {
      const glyph = document.createElement("span");
      glyph.className = "media-glyph video-glyph";
      glyph.textContent = "▶";
      return glyph;
    }
    const video = document.createElement("video");
    video.src = asset.mediaUrl;
    video.preload = "metadata";
    video.muted = true;
    video.controls = detailed;
    return video;
  }
  if (detailed) {
    const audio = document.createElement("audio");
    audio.src = asset.mediaUrl;
    audio.preload = "metadata";
    audio.controls = true;
    return audio;
  }
  const glyph = document.createElement("span");
  glyph.className = "media-glyph audio-glyph";
  glyph.textContent = "♪";
  return glyph;
}

function matchesCategory(asset) {
  if (state.categoryFilter === "*") return true;
  const segments = asset.relativePath.split(/[\\/]/);
  return state.categoryFilter
    ? segments.length > 1 &&
      segments[0].toLocaleLowerCase() === state.categoryFilter.toLocaleLowerCase()
    : segments.length === 1;
}

function filteredAssets() {
  const query = state.search.trim().toLocaleLowerCase();
  return state.assets.filter((asset) => {
    const categoryMatches = matchesCategory(asset);
    const metadata = metadataFor(asset);
    const typeMatches =
      state.filter === "all" ||
      asset.type === state.filter ||
      (state.filter === "favorite" && metadata.favorite);
    if (!categoryMatches || !typeMatches) return false;
    if (!query) return true;
    return [asset.name, asset.relativePath, ...(metadata.tags ?? [])]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  });
}

function updateCounts() {
  const scopedAssets = state.assets.filter(matchesCategory);
  const counts = { all: scopedAssets.length, image: 0, video: 0, audio: 0, favorite: 0 };
  for (const asset of scopedAssets) {
    counts[asset.type] += 1;
    if (metadataFor(asset).favorite) counts.favorite += 1;
  }
  for (const [name, count] of Object.entries(counts)) elements.counts[name].textContent = count;
}

function renderCard(asset) {
  const metadata = metadataFor(asset);
  const card = document.createElement("div");
  card.className = "media-card";
  card.dataset.assetId = asset.id;
  card.role = "button";
  card.tabIndex = 0;
  card.addEventListener("click", () => openDetails(asset.id));
  card.addEventListener("keydown", (event) => {
    if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openDetails(asset.id);
  });

  const thumbnail = document.createElement("div");
  thumbnail.className = "thumb";
  thumbnail.appendChild(createPreview(asset));

  const chips = document.createElement("div");
  chips.className = "thumb-chips";
  const type = document.createElement("span");
  type.className = "type-chip";
  type.textContent = typeLabel(asset.type);
  chips.appendChild(type);
  const recommendation =
    state.categoryRecommendations.get(asset.id)?.status === "ready"
      ? state.categoryRecommendations.get(asset.id).recommendation
      : null;
  if (recommendation?.categoryName) {
    const recommendationChip = document.createElement("span");
    recommendationChip.className = "recommendation-chip";
    recommendationChip.textContent = recommendation.categoryName;
    recommendationChip.title = `${Math.round(recommendation.confidence * 100)}% · ${recommendation.reason || "AI recommendation"}`;
    chips.appendChild(recommendationChip);
  }
  thumbnail.appendChild(chips);
  if (metadata.favorite) {
    const favorite = document.createElement("span");
    favorite.className = "favorite-star";
    favorite.textContent = "★";
    favorite.setAttribute("aria-label", "Favorite");
    thumbnail.appendChild(favorite);
  }
  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-media";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.title = state.recycleBinRoot
    ? "Move to the configured recycling folder"
    : "Permanently delete from disk";
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteAsset(asset.id);
  });
  thumbnail.appendChild(deleteButton);

  const body = document.createElement("div");
  body.className = "card-body";
  const name = document.createElement("strong");
  name.textContent = asset.name;
  name.title = asset.relativePath;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const date = document.createElement("span");
  date.textContent = new Date(asset.modifiedAt).toLocaleDateString();
  const size = document.createElement("span");
  size.textContent = formatBytes(asset.size);
  meta.append(date, size);
  body.append(name, meta);

  if (metadata.tags?.length) {
    const tags = document.createElement("div");
    tags.className = "tag-row";
    for (const value of metadata.tags.slice(0, 3)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = value;
      tags.appendChild(tag);
    }
    body.appendChild(tags);
  }

  card.append(thumbnail, body);
  return card;
}

function renderVirtualGrid(force = false) {
  virtualGrid.animationFrame = 0;
  const width = elements.grid.clientWidth;
  if (!state.rootPath || width <= 0 || virtualGrid.assets.length === 0) {
    elements.grid.style.height = "0px";
    elements.grid.replaceChildren();
    return;
  }

  const columns = Math.max(1, Math.floor((width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));
  const cardWidth = (width - GRID_GAP * (columns - 1)) / columns;
  const cardHeight = cardWidth * 0.75 + CARD_BODY_HEIGHT;
  const rowHeight = cardHeight + GRID_GAP;
  const totalRows = Math.ceil(virtualGrid.assets.length / columns);
  const gridTop = elements.grid.getBoundingClientRect().top + window.scrollY;
  const firstVisibleRow = Math.floor((window.scrollY - gridTop) / rowHeight);
  const lastVisibleRow = Math.ceil((window.scrollY + window.innerHeight - gridTop) / rowHeight);
  const clampedFirstRow = Math.max(0, Math.min(totalRows - 1, firstVisibleRow));
  const clampedLastRow = Math.max(clampedFirstRow, Math.min(totalRows - 1, lastVisibleRow));
  const startRow =
    Math.floor(Math.max(0, clampedFirstRow - OVERSCAN_ROWS) / WINDOW_CHUNK_ROWS) *
    WINDOW_CHUNK_ROWS;
  const endRow = Math.min(
    totalRows,
    Math.ceil((clampedLastRow + OVERSCAN_ROWS + 1) / WINDOW_CHUNK_ROWS) * WINDOW_CHUNK_ROWS,
  );
  const startIndex = Math.min(virtualGrid.assets.length, startRow * columns);
  const endIndex = Math.min(virtualGrid.assets.length, endRow * columns);

  elements.grid.style.height = `${Math.max(0, totalRows * rowHeight - GRID_GAP)}px`;
  if (
    !force &&
    columns === virtualGrid.columns &&
    Math.abs(cardWidth - virtualGrid.cardWidth) < 0.5 &&
    startIndex === virtualGrid.startIndex &&
    endIndex === virtualGrid.endIndex
  ) {
    return;
  }

  const cards = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const card = renderCard(virtualGrid.assets[index]);
    card.style.left = `${column * (cardWidth + GRID_GAP)}px`;
    card.style.top = `${row * rowHeight}px`;
    card.style.width = `${cardWidth}px`;
    card.style.height = `${cardHeight}px`;
    cards.push(card);
  }

  elements.grid.replaceChildren(...cards);
  virtualGrid.columns = columns;
  virtualGrid.cardWidth = cardWidth;
  virtualGrid.rowHeight = rowHeight;
  virtualGrid.startIndex = startIndex;
  virtualGrid.endIndex = endIndex;
}

function scheduleVirtualGridRender(force = false) {
  if (force) {
    virtualGrid.startIndex = -1;
    virtualGrid.endIndex = -1;
  }
  if (virtualGrid.animationFrame) return;
  virtualGrid.animationFrame = requestAnimationFrame(() => renderVirtualGrid(force));
}

function render() {
  const hasLibrary = Boolean(state.rootPath);
  elements.welcome.classList.toggle("hidden", hasLibrary);
  elements.collection.classList.toggle("hidden", !hasLibrary);
  elements.rescan.disabled = !hasLibrary || state.busy;
  elements.openOrganizer.disabled = !hasLibrary || state.assets.length === 0 || state.busy;
  elements.rootName.textContent = hasLibrary
    ? state.configuredMediaRoot.split(/[\\/]/).filter(Boolean).at(-1)
    : "No folder selected";
  elements.rootPath.textContent = hasLibrary
    ? state.configuredMediaRoot
    : "Choose a folder to begin.";
  const hasRecycleBin = Boolean(state.recycleBinRoot);
  elements.recycleName.textContent = hasRecycleBin
    ? state.recycleBinRoot.split(/[\\/]/).filter(Boolean).at(-1)
    : "Permanent deletion";
  elements.recyclePath.textContent = hasRecycleBin
    ? state.recycleBinRoot
    : "No recycling bin configured.";
  elements.clearRecycle.classList.toggle("hidden", !hasRecycleBin);
  elements.chooseRecycle.textContent = hasRecycleBin ? "Change folder" : "Choose recycling folder";

  updateCounts();
  const visible = filteredAssets();
  const titles = { all: "All media", image: "Photos", video: "Videos", audio: "Audio", favorite: "Favorites" };
  elements.viewTitle.textContent = state.categoryFilter === "*"
    ? `All folders · ${titles[state.filter]}`
    : state.categoryFilter
    ? `${state.categoryFilter} · ${titles[state.filter]}`
    : `Unsorted · ${titles[state.filter]}`;
  const scopedCount = Number(elements.counts.all.textContent.replaceAll(",", "")) || 0;
  elements.resultSummary.textContent = `${visible.length.toLocaleString()} of ${scopedCount.toLocaleString()} items`;
  elements.librarySize.textContent = formatBytes(visible.reduce((sum, asset) => sum + asset.size, 0));
  elements.emptyResults.classList.toggle("hidden", visible.length > 0);
  virtualGrid.assets = visible;
  scheduleVirtualGridRender(true);
  elements.filters.forEach((button) => button.classList.toggle("active", button.dataset.type === state.filter));
}

function setLibrary(nextState) {
  state.rootPath = nextState.rootPath;
  state.configuredMediaRoot = nextState.configuredMediaRoot ?? nextState.rootPath;
  state.assets = nextState.assets ?? [];
  state.metadata = nextState.metadata ?? {};
  const nextCategories = nextState.categories ?? [];
  if (JSON.stringify(state.categories) !== JSON.stringify(nextCategories)) {
    state.categoryRecommendations.clear();
  }
  state.categories = nextCategories;
  if (
    state.categoryFilter &&
    state.categoryFilter !== "*" &&
    !state.categories.some(
      (category) =>
        category.name.toLocaleLowerCase() === state.categoryFilter.toLocaleLowerCase(),
    )
  ) {
    state.categoryFilter = null;
  }
  elements.categoryView.replaceChildren();
  const unsortedCount = state.assets.filter(
    (asset) => asset.relativePath.split(/[\\/]/).length === 1,
  ).length;
  const unsorted = document.createElement("option");
  unsorted.value = "";
  unsorted.textContent = `Unsorted (${unsortedCount.toLocaleString()})`;
  elements.categoryView.appendChild(unsorted);
  const allFolders = document.createElement("option");
  allFolders.value = "*";
  allFolders.textContent = `All folders (${state.assets.length.toLocaleString()})`;
  elements.categoryView.appendChild(allFolders);
  for (const category of state.categories) {
    const categoryCount = state.assets.filter((asset) => {
      const segments = asset.relativePath.split(/[\\/]/);
      return (
        segments.length > 1 &&
        segments[0].toLocaleLowerCase() === category.name.toLocaleLowerCase()
      );
    }).length;
    const option = document.createElement("option");
    option.value = category.name;
    option.textContent = `${category.name} (${categoryCount.toLocaleString()})`;
    elements.categoryView.appendChild(option);
  }
  elements.categoryView.value = state.categoryFilter ?? "";
  state.recycleBinRoot = nextState.recycleBinRoot ?? null;
  state.plan = null;
  renderPlan();
  render();
}

async function chooseRecycleBin() {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const result = requireSuccess(await api.chooseRecycleBin());
    if (result) {
      setLibrary(result);
      showToast("Recycling folder saved. Future deletions will preserve relative paths.");
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    render();
  }
}

async function clearRecycleBin() {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const result = requireSuccess(await api.clearRecycleBin());
    if (result) {
      setLibrary(result);
      showToast("Recycling folder cleared. Future deletions will be permanent.");
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    render();
  }
}

async function chooseFolder() {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const result = requireSuccess(await api.chooseFolder());
    if (result) {
      setLibrary(result);
      showToast(`Found ${state.assets.length.toLocaleString()} media items.`);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    render();
  }
}

async function rescan() {
  if (state.busy || !state.rootPath) return;
  state.busy = true;
  elements.rescan.textContent = "…";
  render();
  try {
    setLibrary(requireSuccess(await api.scan()));
    showToast("Library scan complete.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    elements.rescan.textContent = "↻";
    render();
  }
}

function previewIndexFrom(startIndex, direction) {
  for (
    let index = startIndex;
    index >= 0 && index < state.previewAssetIds.length;
    index += direction
  ) {
    if (state.assets.some((asset) => asset.id === state.previewAssetIds[index])) return index;
  }
  return -1;
}

function renderDetailsCategories() {
  elements.detailsCategories.replaceChildren();
  if (state.categories.length === 0) {
    const empty = document.createElement("span");
    empty.className = "category-empty";
    empty.textContent = "No categories yet. Create one below.";
    elements.detailsCategories.appendChild(empty);
    return;
  }
  for (const category of state.categories) {
    const item = document.createElement("div");
    item.className = "category-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-button";
    if (state.categoryRecommendation?.categoryName === category.name) {
      button.classList.add("recommended");
    }
    button.textContent = category.name;
    button.title = category.description || "No description";
    button.addEventListener("click", () =>
      assignSelectedAssetToCategory(category.name),
    );
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "category-edit";
    edit.textContent = "✎";
    edit.title = `Edit ${category.name} description`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => editCategoryDescription(category));
    item.append(button, edit);
    elements.detailsCategories.appendChild(item);
  }
}

function renderCategoryRecommendation() {
  const status = state.categoryRecommendationStatus;
  if (state.categories.length === 0 || !status) {
    elements.categoryRecommendation.classList.add("hidden");
    elements.recommendCategory.disabled = state.categories.length === 0;
    return;
  }
  elements.categoryRecommendation.classList.remove("hidden");
  if (status.status === "analyzing") {
    elements.categoryRecommendationText.textContent =
      "AI is analyzing this image against the available categories…";
    elements.applyRecommendation.disabled = true;
  } else if (status.status === "error") {
    elements.categoryRecommendationText.textContent = status.error;
    elements.applyRecommendation.disabled = true;
  } else {
    const recommendation = status.recommendation;
    elements.applyRecommendation.disabled = !recommendation.categoryName;
    elements.categoryRecommendationText.textContent = recommendation.categoryName
      ? `${recommendation.categoryName} · ${Math.round(recommendation.confidence * 100)}% · ${recommendation.reason || "Recommended by the selected model."}`
      : `${recommendation.modelName} did not find a clear matching category.`;
  }
}

function schedulePreviewRecommendations(forceCurrent = false) {
  const asset = state.assets.find((item) => item.id === state.selectedAssetId);
  if (!asset || asset.type !== "image" || state.categories.length === 0) {
    state.categoryRecommendation = null;
    state.categoryRecommendationStatus = null;
    renderCategoryRecommendation();
    return;
  }
  const assetIds = [];
  for (
    let index = state.previewIndex;
    index < state.previewAssetIds.length && assetIds.length < 25;
    index += 1
  ) {
    const candidate = state.assets.find(
      (item) => item.id === state.previewAssetIds[index],
    );
    if (candidate?.type === "image") assetIds.push(candidate.id);
  }
  const existing = forceCurrent
    ? null
    : state.categoryRecommendations.get(asset.id);
  state.categoryRecommendationStatus = existing ?? { status: "analyzing" };
  state.categoryRecommendation =
    state.categoryRecommendationStatus.status === "ready"
      ? state.categoryRecommendationStatus.recommendation
      : null;
  renderDetailsCategories();
  renderCategoryRecommendation();
  api
    .precomputeCategoryRecommendations(assetIds, forceCurrent)
    .then(requireSuccess)
    .catch((error) => {
      state.categoryRecommendationStatus = {
        status: "error",
        error: error.message,
      };
      renderCategoryRecommendation();
    });
}

function showDetailsAsset(assetId) {
  const asset = state.assets.find((item) => item.id === assetId);
  if (!asset) return;
  const index = state.previewAssetIds.indexOf(assetId);
  if (index !== -1) state.previewIndex = index;
  const metadata = metadataFor(asset);
  state.selectedAssetId = assetId;
  elements.detailsPreview.replaceChildren(createPreview(asset, true));
  elements.detailsType.textContent = typeLabel(asset.type);
  elements.detailsName.textContent = asset.name;
  elements.detailsPath.textContent = asset.relativePath;
  elements.detailsSize.textContent = formatBytes(asset.size);
  elements.detailsDate.textContent = new Date(asset.modifiedAt).toLocaleString();
  elements.detailsTags.value = (metadata.tags ?? []).join(", ");
  elements.detailsFavorite.checked = metadata.favorite === true;
  renderDetailsCategories();
  schedulePreviewRecommendations();
  elements.previousImage.disabled = previewIndexFrom(state.previewIndex - 1, -1) === -1;
  elements.nextImage.disabled = previewIndexFrom(state.previewIndex + 1, 1) === -1;
}

function openDetails(assetId) {
  state.previewAssetIds = filteredAssets().map((asset) => asset.id);
  state.previewIndex = state.previewAssetIds.indexOf(assetId);
  showDetailsAsset(assetId);
  elements.detailsDialog.showModal();
}

function navigateDetails(direction) {
  const index = previewIndexFrom(state.previewIndex + direction, direction);
  if (index === -1) return;
  state.previewIndex = index;
  showDetailsAsset(state.previewAssetIds[index]);
}

function previewAssetIdInDirection(direction) {
  const index = previewIndexFrom(state.previewIndex + direction, direction);
  return index === -1 ? null : state.previewAssetIds[index];
}

function advanceDetails(nextAssetId) {
  if (nextAssetId && state.assets.some((asset) => asset.id === nextAssetId)) {
    showDetailsAsset(nextAssetId);
  } else {
    elements.detailsDialog.close();
    state.selectedAssetId = null;
  }
}

async function assignSelectedAssetToCategory(
  category,
  description = "",
  advanceDirection = 1,
) {
  if (state.busy) return;
  const asset = state.assets.find((item) => item.id === state.selectedAssetId);
  if (!asset) return;
  const nextAssetId = previewAssetIdInDirection(advanceDirection);
  state.busy = true;
  elements.detailsCategories.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = requireSuccess(
      await api.assignCategory(asset.id, category, description),
    );
    setLibrary(result.state);
    elements.newCategoryName.value = "";
    elements.newCategoryDescription.value = "";
    showToast(`Moved "${asset.name}" to ${result.category.name}.`);
    advanceDetails(nextAssetId);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    render();
    if (elements.detailsDialog.open) renderDetailsCategories();
  }
}

function editCategoryDescription(category) {
  if (state.busy) return;
  state.editingCategory = category.name;
  elements.categoryEditorName.textContent = category.name;
  elements.categoryEditorDescription.value = category.description;
  elements.categoryEditorError.textContent = "";
  elements.categoryEditorError.classList.add("hidden");
  elements.categoryEditor.showModal();
  elements.categoryEditorDescription.focus();
}

async function saveCategoryDescription(event) {
  event.preventDefault();
  if (state.busy || !state.editingCategory) return;
  const category = state.editingCategory;
  state.busy = true;
  elements.categoryEditorSave.disabled = true;
  elements.categoryEditorCancel.disabled = true;
  elements.categoryEditorDescription.disabled = true;
  elements.categoryEditorError.textContent = "";
  elements.categoryEditorError.classList.add("hidden");
  try {
    const result = requireSuccess(
      await api.updateCategoryDescription(category, elements.categoryEditorDescription.value),
    );
    setLibrary(result.state);
    if (elements.detailsDialog.open) schedulePreviewRecommendations();
    elements.categoryEditor.close();
    showToast(`Updated ${category}.`);
  } catch (error) {
    elements.categoryEditorError.textContent = error.message;
    elements.categoryEditorError.classList.remove("hidden");
    showToast(error.message, true);
  } finally {
    state.busy = false;
    elements.categoryEditorSave.disabled = false;
    elements.categoryEditorCancel.disabled = false;
    elements.categoryEditorDescription.disabled = false;
    if (elements.categoryEditor.open) elements.categoryEditorDescription.focus();
    render();
  }
}

function recommendSelectedCategory() {
  schedulePreviewRecommendations(true);
}

async function draftNewCategoryDescription() {
  if (state.busy) return;
  const asset = state.assets.find((item) => item.id === state.selectedAssetId);
  if (!asset) return;
  const category = elements.newCategoryName.value.trim();
  if (!category) {
    showToast("Enter a category name before asking AI to draft its description.", true);
    elements.newCategoryName.focus();
    return;
  }
  state.busy = true;
  elements.draftCategoryDescription.disabled = true;
  elements.draftCategoryDescription.textContent = "Drafting…";
  try {
    const result = requireSuccess(
      await api.draftCategoryDescription(asset.id, category),
    );
    elements.newCategoryDescription.value = result.description;
    elements.newCategoryDescription.focus();
    showToast(`Drafted with ${result.modelName}. Review or edit before creating.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    elements.draftCategoryDescription.disabled = false;
    elements.draftCategoryDescription.textContent = "Draft with AI";
  }
}

async function deleteAsset(assetId, { advance = false, requireRecycle = false } = {}) {
  if (state.busy) return;
  const asset = state.assets.find((item) => item.id === assetId);
  if (!asset) return;
  if (requireRecycle && !state.recycleBinRoot) {
    showToast("Configure a recycling folder before using Delete in the preview.", true);
    return;
  }
  if (
    !state.recycleBinRoot &&
    !confirm(`Permanently delete "${asset.name}" from disk? This cannot be undone.`)
  ) {
    return;
  }

  const nextAssetId = advance ? previewAssetIdInDirection(1) : null;
  state.busy = true;
  render();
  try {
    const result = requireSuccess(await api.deleteAsset(asset.id));
    setLibrary(result.state);
    if (elements.detailsDialog.open) {
      if (advance) advanceDetails(nextAssetId);
      else elements.detailsDialog.close();
    }
    if (!elements.detailsDialog.open) state.selectedAssetId = null;
    showToast(
      result.mode === "recycled"
        ? `"${asset.name}" moved to the recycling folder.`
        : `"${asset.name}" permanently deleted.`,
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    render();
  }
}

async function saveDetails(event) {
  event.preventDefault();
  if (event.submitter?.value !== "save") {
    elements.detailsDialog.close();
    return;
  }
  const asset = state.assets.find((item) => item.id === state.selectedAssetId);
  if (!asset) return;
  const tags = elements.detailsTags.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  try {
    const updated = requireSuccess(
      await api.updateMetadata(asset.id, {
        tags,
        favorite: elements.detailsFavorite.checked,
      }),
    );
    state.metadata[metadataKey(asset.relativePath)] = updated;
    elements.detailsDialog.close();
    render();
    showToast("Local metadata saved.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderPlan() {
  if (!state.plan) {
    elements.plan.classList.add("hidden");
    elements.planItems.replaceChildren();
    state.selectedPlanItemIds.clear();
    return;
  }
  elements.plan.classList.remove("hidden");
  elements.planSummary.textContent = state.plan.summary;
  state.selectedPlanItemIds = new Set(state.plan.items.map((item) => item.id));
  elements.planItems.scrollTop = 0;
  virtualPlan.canvas = document.createElement("div");
  virtualPlan.canvas.className = "plan-canvas";
  virtualPlan.canvas.style.height = `${state.plan.items.length * PLAN_ROW_HEIGHT}px`;
  elements.planItems.replaceChildren(virtualPlan.canvas);
  virtualPlan.startIndex = -1;
  virtualPlan.endIndex = -1;
  renderPlanRows(true);
  updatePlanSelection();
}

function renderPlanRows(force = false) {
  virtualPlan.animationFrame = 0;
  if (!state.plan || !virtualPlan.canvas) return;
  const startIndex = Math.max(
    0,
    Math.floor(elements.planItems.scrollTop / PLAN_ROW_HEIGHT) - PLAN_OVERSCAN_ROWS,
  );
  const endIndex = Math.min(
    state.plan.items.length,
    Math.ceil((elements.planItems.scrollTop + elements.planItems.clientHeight) / PLAN_ROW_HEIGHT) +
      PLAN_OVERSCAN_ROWS,
  );
  if (!force && startIndex === virtualPlan.startIndex && endIndex === virtualPlan.endIndex) return;

  const rows = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const item = state.plan.items[index];
    const row = document.createElement("label");
    row.className = "plan-item";
    row.style.top = `${index * PLAN_ROW_HEIGHT}px`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedPlanItemIds.has(item.id);
    checkbox.dataset.planItemId = item.id;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedPlanItemIds.add(item.id);
      else state.selectedPlanItemIds.delete(item.id);
      updatePlanSelection();
    });
    const source = document.createElement("span");
    source.className = "source";
    source.textContent = item.sourceRelative;
    source.title = item.sourceRelative;
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    const target = document.createElement("span");
    target.className = "target";
    target.textContent =
      item.confidence == null
        ? item.targetRelative
        : `${item.targetRelative} · ${Math.round(item.confidence * 100)}%`;
    target.title = item.reason || item.targetRelative;
    row.title = item.reason || "";
    row.append(checkbox, source, arrow, target);
    rows.push(row);
  }
  virtualPlan.canvas.replaceChildren(...rows);
  virtualPlan.startIndex = startIndex;
  virtualPlan.endIndex = endIndex;
}

function schedulePlanRender() {
  if (virtualPlan.animationFrame) return;
  virtualPlan.animationFrame = requestAnimationFrame(() => renderPlanRows());
}

function selectedPlanIds() {
  return [...state.selectedPlanItemIds];
}

function updatePlanSelection() {
  const selected = selectedPlanIds();
  const total = state.plan?.items.length ?? 0;
  elements.selectedSummary.textContent = `${selected.length.toLocaleString()} move${selected.length === 1 ? "" : "s"} selected`;
  elements.applyPlan.disabled = selected.length === 0 || state.busy;
  elements.selectAll.checked = total > 0 && selected.length === total;
  elements.selectAll.indeterminate = selected.length > 0 && selected.length < total;
}

async function buildPlan(event) {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  render();
  elements.analysisProgress.classList.add("hidden");
  elements.analysisProgressBar.value = 0;
  elements.analysisProgressCount.textContent = "Preparing analysis…";
  elements.analysisProgressEta.textContent = "";
  state.plan = null;
  renderPlan();
  elements.goalStatus.className = "goal-status";
  elements.goalStatus.textContent = "Interpreting this request locally…";
  elements.cancelAnalysis.classList.remove("hidden");
  elements.goalForm.querySelector('button[type="submit"]').disabled = true;
  try {
    state.plan = requireSuccess(await api.createPlan(elements.goal.value));
    renderPlan();
    elements.goalStatus.className = "goal-status success";
    elements.goalStatus.textContent = `Interpreted as: ${state.plan.interpretation}.`;
    if (state.plan.items.length === 0) showToast("Everything already matches this plan.");
  } catch (error) {
    state.plan = null;
    renderPlan();
    elements.goalStatus.className = "goal-status error";
    elements.goalStatus.textContent = `No plan created. ${error.message}`;
    if (!elements.analysisProgress.classList.contains("hidden")) {
      elements.analysisProgressEta.textContent = "Stopped";
    }
    showToast(error.message, true);
  } finally {
    state.busy = false;
    elements.cancelAnalysis.classList.add("hidden");
    elements.goalForm.querySelector('button[type="submit"]').disabled = false;
    updatePlanSelection();
    render();
  }
}

async function loadVisionModels(force = false) {
  if (state.visionModelsLoaded && !force) return;
  elements.visionModel.disabled = true;
  elements.visionModelStatus.textContent = "Loading models available to your Copilot account…";
  try {
    const catalog = requireSuccess(await api.listVisionModels());
    elements.visionConcurrency.value = String(catalog.concurrency ?? 4);
    elements.visionModel.replaceChildren();
    if (!catalog.auth?.isAuthenticated) {
      elements.visionModelStatus.textContent =
        catalog.auth?.statusMessage || "Sign in to GitHub Copilot to use visual analysis.";
      return;
    }
    if (catalog.models.length === 0) {
      elements.visionModelStatus.textContent =
        "No vision-capable models are currently available to this Copilot account.";
      return;
    }
    for (const model of catalog.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      option.selected = model.id === catalog.selectedModel;
      elements.visionModel.appendChild(option);
    }
    elements.visionModel.disabled = false;
    state.visionModelsLoaded = true;
    const selectedModel = catalog.models.find(
      (model) => model.id === catalog.selectedModel,
    );
    if (catalog.configuredModel && catalog.configuredModel !== catalog.selectedModel) {
      elements.visionModelStatus.textContent =
        "Your previously selected model is unavailable; choose an available replacement.";
    } else {
      const effort = selectedModel?.supportedReasoningEfforts?.includes("none")
        ? "None"
        : selectedModel?.supportedReasoningEfforts?.includes("low")
          ? "Low"
          : "model default";
      elements.visionModelStatus.textContent =
        `${effort} reasoning · default context · ${catalog.concurrency ?? 4} maximum parallel sessions · Fast routing when provided by the model.`;
    }
  } catch (error) {
    elements.visionModelStatus.textContent = error.message;
    showToast(error.message, true);
  }
}

async function applyPlan() {
  const selected = selectedPlanIds();
  if (!state.plan || selected.length === 0 || state.busy) return;
  const approved = confirm(
    `Move ${selected.length.toLocaleString()} selected file${selected.length === 1 ? "" : "s"}? Existing files will never be overwritten.`,
  );
  if (!approved) return;

  state.busy = true;
  render();
  updatePlanSelection();
  try {
    const result = requireSuccess(await api.applyPlan(state.plan.id, selected));
    setLibrary(result.state);
    elements.organizerDialog.close();
    showToast(`Moved ${result.moved.length.toLocaleString()} file${result.moved.length === 1 ? "" : "s"} safely.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.busy = false;
    updatePlanSelection();
    render();
  }
}

elements.chooseFolder.addEventListener("click", chooseFolder);
elements.welcomeChoose.addEventListener("click", chooseFolder);
elements.chooseRecycle.addEventListener("click", chooseRecycleBin);
elements.clearRecycle.addEventListener("click", clearRecycleBin);
elements.categoryView.addEventListener("change", () => {
  state.categoryFilter = elements.categoryView.value || null;
  window.scrollTo({ top: 0, behavior: "auto" });
  render();
});
elements.rescan.addEventListener("click", rescan);
elements.search.addEventListener("input", () => {
  state.search = elements.search.value;
  render();
});
elements.filters.forEach((button) =>
  button.addEventListener("click", () => {
    state.filter = button.dataset.type;
    render();
  }),
);
elements.detailsForm.addEventListener("submit", saveDetails);
elements.revealFile.addEventListener("click", async () => {
  try {
    requireSuccess(await api.reveal(state.selectedAssetId));
  } catch (error) {
    showToast(error.message, true);
  }
});
elements.deleteFile.addEventListener("click", () =>
  deleteAsset(state.selectedAssetId, { advance: elements.detailsDialog.open }),
);
elements.previousImage.addEventListener("click", () => navigateDetails(-1));
elements.nextImage.addEventListener("click", () => navigateDetails(1));
elements.createCategory.addEventListener("click", () => {
  const category = elements.newCategoryName.value.trim();
  if (!category) {
    showToast("Enter a category name.", true);
    return;
  }
  assignSelectedAssetToCategory(
    category,
    elements.newCategoryDescription.value.trim(),
  );
});
elements.newCategoryName.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  elements.createCategory.click();
});
elements.newCategoryDescription.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  elements.createCategory.click();
});
elements.draftCategoryDescription.addEventListener(
  "click",
  draftNewCategoryDescription,
);
elements.recommendCategory.addEventListener("click", recommendSelectedCategory);
elements.categoryEditorForm.addEventListener("submit", saveCategoryDescription);
elements.categoryEditorCancel.addEventListener("click", () => {
  if (!state.busy) elements.categoryEditor.close();
});
elements.categoryEditor.addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
});
elements.categoryEditor.addEventListener("close", () => {
  state.editingCategory = null;
  elements.categoryEditorDescription.value = "";
  elements.categoryEditorError.textContent = "";
  elements.categoryEditorError.classList.add("hidden");
});
elements.applyRecommendation.addEventListener("click", () => {
  if (!state.categoryRecommendation?.categoryName) return;
  assignSelectedAssetToCategory(state.categoryRecommendation.categoryName);
});
elements.detailsDialog.addEventListener("close", () => {
  elements.detailsPreview.querySelectorAll("audio, video").forEach((media) => media.pause());
  elements.detailsPreview.replaceChildren();
  elements.newCategoryName.value = "";
  elements.newCategoryDescription.value = "";
  elements.categoryRecommendation.classList.add("hidden");
  state.selectedAssetId = null;
  state.previewAssetIds = [];
  state.previewIndex = -1;
  state.categoryRecommendation = null;
  state.categoryRecommendationStatus = null;
});
document.addEventListener("keydown", (event) => {
  if (elements.categoryEditor.open) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!state.busy) elements.categoryEditor.close();
    }
    return;
  }
  if (!elements.detailsDialog.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    elements.detailsDialog.close();
    return;
  }
  const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName);
  if (editing) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (event.shiftKey && state.categoryRecommendation?.categoryName) {
      assignSelectedAssetToCategory(
        state.categoryRecommendation.categoryName,
        "",
        -1,
      );
    } else {
      navigateDetails(-1);
    }
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    if (event.shiftKey && state.categoryRecommendation?.categoryName) {
      assignSelectedAssetToCategory(
        state.categoryRecommendation.categoryName,
        "",
        1,
      );
    } else {
      navigateDetails(1);
    }
  } else if (event.key === "Delete") {
    event.preventDefault();
    deleteAsset(state.selectedAssetId, { advance: true, requireRecycle: true });
  }
});
elements.openOrganizer.addEventListener("click", () => {
  elements.organizerDialog.showModal();
  loadVisionModels(true);
});
elements.closeOrganizer.addEventListener("click", () => elements.organizerDialog.close());
elements.visionModel.addEventListener("change", async () => {
  elements.visionModel.disabled = true;
  try {
    requireSuccess(await api.setVisionModel(elements.visionModel.value));
    state.categoryRecommendations.clear();
    elements.visionModelStatus.textContent = "Vision model saved for future visual prompts.";
  } catch (error) {
    showToast(error.message, true);
    state.visionModelsLoaded = false;
    await loadVisionModels(true);
  } finally {
    elements.visionModel.disabled = !state.visionModelsLoaded;
  }
});
elements.visionConcurrency.addEventListener("change", async () => {
  const value = Number(elements.visionConcurrency.value);
  elements.visionConcurrency.disabled = true;
  try {
    requireSuccess(await api.setVisionConcurrency(value));
    state.visionModelsLoaded = false;
    await loadVisionModels(true);
    showToast(`Maximum parallel sessions set to ${value}.`);
  } catch (error) {
    showToast(error.message, true);
    state.visionModelsLoaded = false;
    await loadVisionModels(true);
  } finally {
    elements.visionConcurrency.disabled = false;
  }
});
elements.goalForm.addEventListener("submit", buildPlan);
elements.cancelAnalysis.addEventListener("click", async () => {
  elements.cancelAnalysis.disabled = true;
  elements.goalStatus.textContent = "Cancelling after the current image…";
  try {
    requireSuccess(await api.cancelPlan());
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.cancelAnalysis.disabled = false;
  }
});
document.querySelectorAll("[data-goal]").forEach((button) =>
  button.addEventListener("click", () => {
    elements.goal.value = button.dataset.goal;
    elements.goalStatus.className = "goal-status";
    elements.goalStatus.textContent =
      "Supported: ordered visual categories, year, media type, existing tags, and favorites.";
    elements.goal.focus();
  }),
);
elements.selectAll.addEventListener("change", () => {
  state.selectedPlanItemIds = elements.selectAll.checked
    ? new Set(state.plan?.items.map((item) => item.id) ?? [])
    : new Set();
  renderPlanRows(true);
  updatePlanSelection();
});
elements.applyPlan.addEventListener("click", applyPlan);
elements.planItems.addEventListener("scroll", schedulePlanRender, { passive: true });
api.onOrganizerProgress((progress) => {
  elements.goalStatus.className = "goal-status";
  elements.goalStatus.textContent = progress.message;
  elements.analysisProgress.classList.remove("hidden");
  if (progress.total > 0) {
    elements.analysisProgressBar.max = progress.total;
    elements.analysisProgressBar.value = Math.min(progress.current || 0, progress.total);
  } else {
    elements.analysisProgressBar.removeAttribute("value");
  }
  if (progress.total <= 0) {
    elements.analysisProgressCount.textContent = "Interpreting visual command…";
    elements.analysisProgressEta.textContent = "";
    return;
  }
  const percent =
    progress.total > 0 ? Math.round(((progress.current || 0) / progress.total) * 100) : 0;
  elements.analysisProgressCount.textContent =
    `${(progress.current || 0).toLocaleString()} of ${(progress.total || 0).toLocaleString()} · ${percent}% · ${progress.concurrency || 1} session${progress.concurrency === 1 ? "" : "s"}`;
  if (progress.current >= progress.total && progress.total > 0) {
    elements.analysisProgressEta.textContent = `Completed in ${formatDuration(progress.elapsedMs)}`;
  } else {
    elements.analysisProgressEta.textContent =
      progress.etaMs == null
        ? "Estimating time remaining…"
        : `About ${formatDuration(progress.etaMs)} remaining`;
  }
});
api.onCategoryRecommendation((payload) => {
  state.categoryRecommendations.set(payload.assetId, payload);
  scheduleVirtualGridRender(true);
  if (payload.assetId !== state.selectedAssetId) return;
  state.categoryRecommendationStatus = payload;
  state.categoryRecommendation =
    payload.status === "ready" ? payload.recommendation : null;
  renderDetailsCategories();
  renderCategoryRecommendation();
});
window.addEventListener("scroll", () => scheduleVirtualGridRender(), { passive: true });
window.addEventListener("resize", () => scheduleVirtualGridRender(true));

async function initialize() {
  try {
    setLibrary(requireSuccess(await api.getState()));
  } catch (error) {
    showToast(error.message, true);
    render();
  }
}

initialize();
