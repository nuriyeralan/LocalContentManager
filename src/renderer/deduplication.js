const dedupApi = window.localContent;
const dedupElements = Object.fromEntries([
  "open-deduplication", "deduplication-dialog", "close-deduplication", "deduplication-form",
  "deduplication-method", "deduplication-sensitivity", "deduplication-concurrency",
  "scan-duplicates", "cancel-deduplication",
  "deduplication-progress", "deduplication-progress-bar", "deduplication-progress-text",
  "deduplication-progress-time", "deduplication-status", "deduplication-failures",
  "deduplication-failure-summary", "deduplication-failure-list", "deduplication-review",
  "deduplication-previous", "deduplication-next", "deduplication-page-summary",
  "deduplication-groups", "deduplication-recycle-path", "deduplication-choose-recycle",
  "accept-deduplication-choices", "deduplication-choice-summary", "deduplication-preview",
  "deduplication-preview-path", "deduplication-preview-image",
].map((id) => [id, document.getElementById(id)]));

const GROUPS_PER_PAGE = 20;
const dedupState = {
  plan: null,
  page: 0,
  choices: new Map(),
  library: null,
  busy: null,
};

function dedupData(result) {
  if (!result?.ok) throw new Error(result?.error || "Deduplication failed.");
  return result.data;
}

function dedupStatus(message, error = false) {
  const element = dedupElements["deduplication-status"];
  element.textContent = message;
  element.className = error ? "goal-status error" : "goal-status";
}

function dedupBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3;
  return `${(bytes / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB"][unit]}`;
}

function setDedupBusy(value) {
  dedupState.busy = value;
  dedupElements["scan-duplicates"].disabled = Boolean(value);
  dedupElements["deduplication-method"].disabled = Boolean(value);
  dedupElements["deduplication-concurrency"].disabled = Boolean(value);
  dedupElements["deduplication-sensitivity"].disabled =
    Boolean(value) || dedupElements["deduplication-method"].value === "exact";
  dedupElements["close-deduplication"].disabled = Boolean(value);
  dedupElements["cancel-deduplication"].classList.toggle("hidden", value !== "scanning");
  dedupElements["cancel-deduplication"].disabled = false;
  renderDedupReview();
}

function publishDedupLibrary(snapshot) {
  dedupState.library = snapshot;
  window.dispatchEvent(new CustomEvent("deduplication:library", { detail: snapshot }));
}

function chooseDedupKeeper(groupId, keeperId) {
  dedupState.choices.set(groupId, keeperId);
  renderDedupReview();
}

function selectedDedupChoices() {
  if (!dedupState.plan) return [];
  const groups = new Map(dedupState.plan.groups.map((group) => [group.id, group]));
  return [...dedupState.choices].flatMap(([groupId, keeperId]) => {
    const group = groups.get(groupId);
    return group?.members.some((asset) => asset.id === keeperId)
      ? [{ groupId, keeperId }]
      : [];
  });
}

function openDedupPreview(asset) {
  dedupElements["deduplication-preview-path"].textContent = asset.relativePath;
  const image = dedupElements["deduplication-preview-image"];
  image.src = asset.previewUrl || asset.mediaUrl;
  image.alt = asset.name;
  image.onerror = () => {
    image.onerror = null;
    image.src = asset.thumbnailUrl;
  };
  dedupElements["deduplication-preview"].showModal();
}

function renderDedupMember(group, asset, busy) {
  const keeperId = dedupState.choices.get(group.id);
  const selected = keeperId === asset.id;
  const automaticRecycle = Boolean(keeperId) && !selected;
  const card = document.createElement("article");
  card.className = `deduplication-member${selected ? " keeper" : ""}${automaticRecycle ? " recycle" : ""}`;

  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "deduplication-thumbnail";
  preview.setAttribute("aria-label", `Enlarge ${asset.relativePath}`);
  const image = document.createElement("img");
  image.src = asset.thumbnailUrl;
  image.alt = asset.name;
  image.loading = "lazy";
  preview.appendChild(image);
  preview.addEventListener("click", () => openDedupPreview(asset));

  const name = document.createElement("strong");
  name.textContent = asset.relativePath;
  name.title = asset.relativePath;
  const facts = document.createElement("span");
  facts.className = "deduplication-facts";
  facts.textContent = [
    asset.width && asset.height ? `${asset.width} x ${asset.height}` : "Exact match",
    dedupBytes(asset.size),
    new Date(asset.modifiedAt).toLocaleDateString(),
  ].join(" | ");

  const choice = document.createElement("label");
  choice.className = "deduplication-keeper-choice";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = `deduplication-keeper-${group.id}`;
  radio.checked = selected;
  radio.disabled = busy;
  radio.addEventListener("change", () => chooseDedupKeeper(group.id, asset.id));
  const choiceText = document.createElement("span");
  choiceText.textContent = selected ? "Keep" : automaticRecycle ? "Recycle" : "Keep this image";
  choice.append(radio, choiceText);
  card.append(preview, name, facts, choice);
  return card;
}

function renderDedupGroup(group, absoluteIndex, busy) {
  const row = document.createElement("section");
  row.className = "deduplication-group";
  const heading = document.createElement("div");
  heading.className = "deduplication-group-heading";
  const title = document.createElement("strong");
  title.textContent = `Group ${absoluteIndex + 1}`;
  const status = document.createElement("span");
  const keeper = group.members.find((asset) => asset.id === dedupState.choices.get(group.id));
  status.textContent = keeper
    ? `Keep ${keeper.relativePath}; recycle ${group.members.length - 1}`
    : `Not reviewed - retain all ${group.members.length}`;
  heading.append(title, status);
  const members = document.createElement("div");
  members.className = "deduplication-group-members";
  members.replaceChildren(...group.members.map((asset) => renderDedupMember(group, asset, busy)));
  row.append(heading, members);
  return row;
}

function updateDedupChoiceSummary() {
  const choices = selectedDedupChoices();
  const groupMap = new Map(dedupState.plan?.groups.map((group) => [group.id, group]) ?? []);
  const recycleCount = choices.reduce(
    (total, choice) => total + groupMap.get(choice.groupId).members.length - 1,
    0,
  );
  dedupElements["deduplication-choice-summary"].textContent = choices.length
    ? `${choices.length} reviewed group${choices.length === 1 ? "" : "s"} | ${recycleCount} image${recycleCount === 1 ? "" : "s"} will be recycled`
    : "Unreviewed groups retain every image.";
  const button = dedupElements["accept-deduplication-choices"];
  button.disabled = Boolean(dedupState.busy) || choices.length === 0 ||
    !dedupState.library?.recycleBinRoot;
  button.textContent = choices.length
    ? `Accept choices (${choices.length} group${choices.length === 1 ? "" : "s"})`
    : "Accept choices";
}

function renderDedupReview() {
  const plan = dedupState.plan;
  const hasGroups = Boolean(plan?.groups.length);
  dedupElements["deduplication-review"].classList.toggle("hidden", !hasGroups);
  if (!hasGroups) {
    dedupElements["deduplication-groups"].replaceChildren();
    return;
  }
  const pageCount = Math.ceil(plan.groups.length / GROUPS_PER_PAGE);
  dedupState.page = Math.max(0, Math.min(dedupState.page, pageCount - 1));
  const first = dedupState.page * GROUPS_PER_PAGE;
  const last = Math.min(first + GROUPS_PER_PAGE, plan.groups.length);
  const busy = Boolean(dedupState.busy);
  dedupElements["deduplication-page-summary"].textContent =
    `Groups ${first + 1}-${last} of ${plan.groups.length}`;
  dedupElements["deduplication-previous"].disabled = busy || dedupState.page === 0;
  dedupElements["deduplication-next"].disabled = busy || dedupState.page === pageCount - 1;
  dedupElements["deduplication-groups"].replaceChildren(
    ...plan.groups.slice(first, last).map((group, index) =>
      renderDedupGroup(group, first + index, busy)),
  );
  dedupElements["deduplication-recycle-path"].textContent = dedupState.library?.recycleBinRoot
    ? `Recycle to: ${dedupState.library.recycleBinRoot}`
    : "A recycling folder is required. Deduplication never permanently deletes.";
  dedupElements["deduplication-choose-recycle"].disabled = busy;
  updateDedupChoiceSummary();
}

async function scanDedupImages(event) {
  event.preventDefault();
  if (dedupState.busy) return;
  dedupState.plan = null;
  dedupState.choices.clear();
  dedupState.page = 0;
  dedupElements["deduplication-failures"].classList.add("hidden");
  dedupElements["deduplication-progress"].classList.remove("hidden");
  dedupElements["deduplication-progress-bar"].value = 0;
  dedupElements["deduplication-progress-text"].textContent = "Starting local scan...";
  dedupElements["deduplication-progress-time"].textContent = "";
  dedupStatus("Scanning images. No files are moved during analysis.");
  setDedupBusy("scanning");
  try {
    const plan = dedupData(await dedupApi.scanDuplicates(
      dedupElements["deduplication-method"].value,
      dedupElements["deduplication-sensitivity"].value,
      Number(dedupElements["deduplication-concurrency"].value),
    ));
    dedupState.plan = plan;
    dedupStatus(`${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"} found. ` +
      `${plan.analyzed} of ${plan.scanned} images analyzed; ${plan.failed} skipped. ` +
      (plan.decoderCrashes ? `${plan.decoderCrashes} native decoder failure(s); affected files were left untouched. ` : "") +
      (plan.groups.length
        ? "Choose one keeper in any group; every other image in that group will be recycled when you accept."
        : plan.analyzed === 0 && plan.failed > 0
          ? "No images could be analyzed. Review the skipped-file errors."
          : "No matching images found among the analyzed images.") +
      (plan.method === "similar" ? " Crop matching is approximate; not every crop can be detected." : ""),
    plan.analyzed === 0 && plan.failed > 0);
    if (plan.failed) {
      dedupElements["deduplication-failures"].classList.remove("hidden");
      dedupElements["deduplication-failure-summary"].textContent =
        `${plan.failed} images skipped: unreadable, unsupported, oversized, changed, or decoder failure (first 50 shown)`;
      dedupElements["deduplication-failure-list"].replaceChildren(...plan.failures.map((failure) => {
        const item = document.createElement("li");
        item.textContent = `${failure.path}: ${failure.error}`;
        return item;
      }));
    }
  } catch (error) {
    dedupStatus(error.message, true);
    dedupElements["deduplication-progress-text"].textContent = "Scan stopped. No files were moved.";
  } finally {
    setDedupBusy(null);
  }
}

async function acceptDedupChoices() {
  const choices = selectedDedupChoices();
  if (!dedupState.plan || choices.length === 0 || dedupState.busy) return;
  setDedupBusy("recycling");
  dedupElements["deduplication-progress"].classList.remove("hidden");
  dedupElements["deduplication-progress-bar"].value = 0;
  dedupElements["deduplication-progress-text"].textContent = "Verifying reviewed groups...";
  dedupStatus("Applying choices. Unreviewed groups will remain untouched.");
  try {
    const result = dedupData(await dedupApi.recycleDuplicates(dedupState.plan.id, choices));
    publishDedupLibrary(result.state);
    dedupState.plan = result.plan;
    for (const groupId of result.processedGroupIds ?? []) dedupState.choices.delete(groupId);
    if (result.status === "error") {
      dedupState.choices.clear();
      dedupStatus(`Stopped after recycling ${result.moved.length} cop${result.moved.length === 1 ? "y" : "ies"}. ${result.error} Scan again before continuing.`, true);
      dedupElements["deduplication-progress-text"].textContent = "Recycling stopped. See the error below.";
    } else {
      dedupStatus(`Accepted ${result.processedGroupIds.length} group${result.processedGroupIds.length === 1 ? "" : "s"} and recycled ${result.moved.length} image${result.moved.length === 1 ? "" : "s"}. ` +
        (result.plan.groups.length
          ? "Unreviewed groups were retained; continue reviewing or scan again."
          : "All duplicate groups have been reviewed."));
    }
  } catch (error) {
    dedupStatus(error.message, true);
    dedupElements["deduplication-progress-text"].textContent = "Recycling stopped. See the error below.";
  } finally {
    setDedupBusy(null);
  }
}

async function closeDeduplication() {
  if (dedupState.busy) return;
  setDedupBusy("closing");
  try {
    dedupData(await dedupApi.cancelDeduplication());
    dedupState.plan = null;
    dedupState.choices.clear();
    dedupElements["deduplication-dialog"].close();
  } catch (error) {
    dedupStatus(error.message, true);
  } finally {
    setDedupBusy(null);
  }
}

dedupElements["open-deduplication"].addEventListener("click", async () => {
  dedupElements["deduplication-dialog"].showModal();
  setDedupBusy("loading");
  try {
    dedupState.library = dedupData(await dedupApi.getState());
    dedupStatus("Start with exact copies, then try similarity for images with different sizes or crops.");
  } catch (error) {
    dedupStatus(error.message, true);
  } finally {
    setDedupBusy(null);
  }
});
dedupElements["deduplication-method"].addEventListener("change", () => {
  dedupElements["deduplication-sensitivity"].disabled =
    dedupElements["deduplication-method"].value === "exact";
});
dedupElements["deduplication-form"].addEventListener("submit", scanDedupImages);
dedupElements["close-deduplication"].addEventListener("click", closeDeduplication);
dedupElements["deduplication-dialog"].addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDeduplication();
});
dedupElements["deduplication-dialog"].addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeDeduplication();
});
dedupElements["cancel-deduplication"].addEventListener("click", async () => {
  dedupElements["cancel-deduplication"].disabled = true;
  dedupStatus("Cancelling the scan...");
  try {
    dedupData(await dedupApi.cancelDeduplication());
  } catch (error) {
    dedupStatus(error.message, true);
  }
});
dedupElements["deduplication-choose-recycle"].addEventListener("click", async () => {
  if (dedupState.busy) return;
  setDedupBusy("settings");
  try {
    const snapshot = dedupData(await dedupApi.chooseRecycleBin());
    if (snapshot) publishDedupLibrary(snapshot);
  } catch (error) {
    dedupStatus(error.message, true);
  } finally {
    setDedupBusy(null);
  }
});
dedupElements["accept-deduplication-choices"].addEventListener("click", acceptDedupChoices);
for (const [id, delta] of [["deduplication-previous", -1], ["deduplication-next", 1]]) {
  dedupElements[id].addEventListener("click", () => {
    if (dedupState.busy) return;
    dedupState.page += delta;
    renderDedupReview();
  });
}
dedupElements["deduplication-preview"].addEventListener("close", () => {
  dedupElements["deduplication-preview-image"].removeAttribute("src");
});
dedupElements["deduplication-preview"].addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  dedupElements["deduplication-preview"].close();
});
dedupApi.onDeduplicationProgress((progress) => {
  if (!dedupState.busy) return;
  dedupElements["deduplication-progress-bar"].value = progress.percent;
  dedupElements["deduplication-progress-text"].textContent =
    `${Math.round(progress.percent)}% | ${progress.message}`;
  dedupElements["deduplication-progress-time"].textContent =
    progress.elapsedMs == null ? "" : `${Math.round(progress.elapsedMs / 1000)}s elapsed`;
});
