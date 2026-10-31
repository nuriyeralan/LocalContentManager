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
  detailsType: document.getElementById("details-type"),
  detailsName: document.getElementById("details-name"),
  detailsPath: document.getElementById("details-path"),
  detailsSize: document.getElementById("details-size"),
  detailsDate: document.getElementById("details-date"),
  detailsTags: document.getElementById("details-tags"),
  detailsFavorite: document.getElementById("details-favorite"),
  revealFile: document.getElementById("reveal-file"),
  deleteFile: document.getElementById("delete-file"),
  organizerDialog: document.getElementById("organizer-dialog"),
  openOrganizer: document.getElementById("open-organizer"),
  closeOrganizer: document.getElementById("close-organizer"),
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
  assets: [],
  metadata: {},
  recycleBinRoot: null,
  filter: "all",
  search: "",
  selectedAssetId: null,
  plan: null,
  selectedPlanItemIds: new Set(),
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

function typeLabel(type) {
  return { image: "Photo", video: "Video", audio: "Audio" }[type] ?? "Media";
}

function createPreview(asset, detailed = false) {
  if (asset.type === "image") {
    const image = document.createElement("img");
    image.src = detailed ? asset.mediaUrl : asset.thumbnailUrl;
    image.alt = detailed ? asset.name : "";
    image.loading = "lazy";
    image.decoding = "async";
    image.fetchPriority = detailed ? "high" : "low";
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

function filteredAssets() {
  const query = state.search.trim().toLocaleLowerCase();
  return state.assets.filter((asset) => {
    const metadata = metadataFor(asset);
    const typeMatches =
      state.filter === "all" ||
      asset.type === state.filter ||
      (state.filter === "favorite" && metadata.favorite);
    if (!typeMatches) return false;
    if (!query) return true;
    return [asset.name, asset.relativePath, ...(metadata.tags ?? [])]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  });
}

function updateCounts() {
  const counts = { all: state.assets.length, image: 0, video: 0, audio: 0, favorite: 0 };
  for (const asset of state.assets) {
    counts[asset.type] += 1;
    if (metadataFor(asset).favorite) counts.favorite += 1;
  }
  for (const [name, count] of Object.entries(counts)) elements.counts[name].textContent = count;
}

function renderCard(asset) {
  const metadata = metadataFor(asset);
  const card = document.createElement("div");
  card.className = "media-card";
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

  const type = document.createElement("span");
  type.className = "type-chip";
  type.textContent = typeLabel(asset.type);
  thumbnail.appendChild(type);
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
    ? state.rootPath.split(/[\\/]/).filter(Boolean).at(-1)
    : "No folder selected";
  elements.rootPath.textContent = hasLibrary ? state.rootPath : "Choose a folder to begin.";
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
  elements.viewTitle.textContent = titles[state.filter];
  elements.resultSummary.textContent = `${visible.length.toLocaleString()} of ${state.assets.length.toLocaleString()} items`;
  elements.librarySize.textContent = formatBytes(state.assets.reduce((sum, asset) => sum + asset.size, 0));
  elements.emptyResults.classList.toggle("hidden", visible.length > 0);
  virtualGrid.assets = visible;
  scheduleVirtualGridRender(true);
  elements.filters.forEach((button) => button.classList.toggle("active", button.dataset.type === state.filter));
}

function setLibrary(nextState) {
  state.rootPath = nextState.rootPath;
  state.assets = nextState.assets ?? [];
  state.metadata = nextState.metadata ?? {};
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
  const approved = confirm(
    "Use permanent deletion instead? Deleted media will no longer be recoverable through LocalContentManager.",
  );
  if (!approved) return;
  state.busy = true;
  render();
  try {
    setLibrary(requireSuccess(await api.clearRecycleBin()));
    showToast("Recycling folder cleared. Future deletions will be permanent.");
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

function openDetails(assetId) {
  const asset = state.assets.find((item) => item.id === assetId);
  if (!asset) return;
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
  elements.detailsDialog.showModal();
}

async function deleteAsset(assetId) {
  if (state.busy) return;
  const asset = state.assets.find((item) => item.id === assetId);
  if (!asset) return;
  const action = state.recycleBinRoot
    ? `Move "${asset.name}" to the recycling folder using its current relative path?`
    : `Permanently delete "${asset.name}" from disk? This cannot be undone.`;
  if (!confirm(action)) return;

  state.busy = true;
  render();
  try {
    const result = requireSuccess(await api.deleteAsset(asset.id));
    setLibrary(result.state);
    if (elements.detailsDialog.open) elements.detailsDialog.close();
    state.selectedAssetId = null;
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
    showToast(error.message, true);
  } finally {
    state.busy = false;
    elements.cancelAnalysis.classList.add("hidden");
    elements.goalForm.querySelector('button[type="submit"]').disabled = false;
    updatePlanSelection();
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
  }
}

elements.chooseFolder.addEventListener("click", chooseFolder);
elements.welcomeChoose.addEventListener("click", chooseFolder);
elements.chooseRecycle.addEventListener("click", chooseRecycleBin);
elements.clearRecycle.addEventListener("click", clearRecycleBin);
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
elements.deleteFile.addEventListener("click", () => deleteAsset(state.selectedAssetId));
elements.openOrganizer.addEventListener("click", () => elements.organizerDialog.showModal());
elements.closeOrganizer.addEventListener("click", () => elements.organizerDialog.close());
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
