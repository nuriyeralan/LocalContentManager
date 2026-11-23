"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { assertUnchanged, checkedStats, fingerprint, validateScanConcurrency } = require("./duplicate-scanner");

class Deduplication {
  constructor(library) {
    this.library = library;
    this.worker = null;
    this.plan = null;
    this.applying = false;
  }

  get active() {
    return Boolean(this.worker || this.plan || this.applying);
  }

  async scan(method, sensitivity, onProgress = () => {}, concurrency = 16) {
    if (this.worker || this.applying) throw new Error("Deduplication is already working.");
    if (!this.library.rootPath) throw new Error("Choose and scan a media folder first.");
    if (!["exact", "similar"].includes(method) || !["conservative", "broader"].includes(sensitivity)) {
      throw new Error("Choose a valid deduplication method and sensitivity.");
    }
    validateScanConcurrency(concurrency);
    this.plan = null;
    const rootPath = this.library.rootPath;
    const assets = this.library.assetsByType("image");
    if (!assets.length) throw new Error("There are no images in this library.");
    const worker = new Worker(path.join(__dirname, "duplicate-worker.js"), {
      workerData: { rootPath, assets, method, sensitivity, concurrency },
    });
    this.worker = worker;
    try {
      const result = await new Promise((resolve, reject) => {
        let received = false;
        worker.on("message", (message) => {
          if (message.type === "progress") onProgress(message.progress);
          if (message.type === "result") {
            received = true;
            resolve(message.result);
          }
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (!received) reject(new Error(this.worker !== worker
            ? "Deduplication scan cancelled. No files were moved."
            : `The deduplication worker stopped unexpectedly (${code}).`));
        });
      });
      if (this.worker !== worker) throw new Error("Deduplication scan cancelled. No files were moved.");
      this.plan = { ...result, id: crypto.randomUUID(), rootPath };
      return this.snapshot();
    } finally {
      if (this.worker === worker) this.worker = null;
      await worker.terminate();
    }
  }

  async cancel() {
    if (this.applying) throw new Error("Wait for the current recycling operation to finish.");
    this.plan = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  snapshot() {
    if (!this.plan) return null;
    const { id, method, sensitivity, concurrency, scanned, analyzed, failed, failures, decoderCrashes } = this.plan;
    const records = new Map(this.plan.records.map((record) => [record.asset.id, record]));
    return {
      id, method, sensitivity, concurrency, scanned, analyzed, failed, failures, decoderCrashes,
      groups: this.plan.groups.map((group) => ({
        id: group.id,
        members: group.memberIds.map((assetId) => {
          const { asset, width, height } = records.get(assetId);
          const { absolutePath: _absolutePath, ...publicAsset } = asset;
          return { ...publicAsset, width, height };
        }),
      })),
    };
  }

  selections(planId, choices) {
    if (!this.plan || planId !== this.plan.id || this.plan.rootPath !== this.library.rootPath) {
      throw new Error("This deduplication scan is no longer current. Scan again.");
    }
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error("Choose a keeper for at least one duplicate group.");
    }
    const groupIds = new Set();
    return choices.map((choice) => {
      if (!choice || typeof choice.groupId !== "string" ||
        typeof choice.keeperId !== "string" || groupIds.has(choice.groupId)) {
        throw new Error("The deduplication choices are invalid.");
      }
      groupIds.add(choice.groupId);
      const group = this.plan.groups.find((entry) => entry.id === choice.groupId);
      if (!group || !group.memberIds.includes(choice.keeperId) || group.memberIds.length < 2) {
        throw new Error("Choose one valid keeper from each reviewed duplicate group.");
      }
      return {
        group,
        keeperId: choice.keeperId,
        recycleIds: group.memberIds.filter((assetId) => assetId !== choice.keeperId),
      };
    });
  }

  async recycleChoices(planId, choices, recycleRoot, onRecycled, onProgress) {
    if (this.worker || this.applying) throw new Error("Deduplication is already working.");
    if (!recycleRoot) throw new Error("Configure a recycling folder first. Deduplication never permanently deletes.");
    const selections = this.selections(planId, choices);
    const plan = this.plan;
    const records = new Map(plan.records.map((record) => [record.asset.id, record]));
    const verificationIds = selections.flatMap(({ group }) => group.memberIds);
    const recycleItems = selections.flatMap(({ keeperId, recycleIds }) =>
      recycleIds.map((assetId) => ({ assetId, keeperId })));
    const moved = [];
    this.applying = true;
    try {
      for (let index = 0; index < verificationIds.length; index += 1) {
        const assetId = verificationIds[index];
        const record = records.get(assetId);
        const current = this.library.getAsset(assetId);
        if (!current || current.absolutePath !== record.asset.absolutePath) {
          throw new Error("The library changed. Rescan before recycling.");
        }
        onProgress({ phase: "verifying", current: index, total: verificationIds.length,
          percent: index / verificationIds.length * 50,
          message: `Verifying ${record.asset.relativePath}...` });
        let lastProgressAt = 0;
        await assertUnchanged(plan.rootPath, record, true, (bytes) => {
          if (Date.now() - lastProgressAt < 100) return;
          lastProgressAt = Date.now();
          const fraction = Math.min(1, bytes / Math.max(1, record.asset.size));
          onProgress({ phase: "verifying", current: index, total: verificationIds.length,
            percent: (index + fraction) / verificationIds.length * 50,
            message: `Verifying ${record.asset.relativePath} (${Math.round(fraction * 100)}%)...` });
        });
      }
      for (const { assetId, keeperId } of recycleItems) {
        const record = records.get(assetId);
        const keeper = records.get(keeperId);
        await assertUnchanged(plan.rootPath, keeper);
        await assertUnchanged(plan.rootPath, record);
        const result = await this.library.deleteAsset(assetId, recycleRoot);
        moved.push({ assetId, ...result });
        await onRecycled(record.asset);
        if (record.linkedIdentity) {
          // Unlinking one hard link changes the ctime of its surviving aliases.
          for (const linked of records.values()) {
            if (linked.linkedIdentity !== record.linkedIdentity || !this.library.getAsset(linked.asset.id)) continue;
            const refreshed = { ...linked, fingerprint: fingerprint(await checkedStats(plan.rootPath, linked.asset)) };
            await assertUnchanged(plan.rootPath, refreshed, true);
            linked.fingerprint = refreshed.fingerprint;
          }
        }
        onProgress({ phase: "recycling", current: moved.length, total: recycleItems.length,
          percent: 50 + moved.length / recycleItems.length * 50,
          message: `Recycled ${moved.length} of ${recycleItems.length} copies.` });
      }
      const processedGroupIds = new Set(selections.map(({ group }) => group.id));
      plan.groups = plan.groups.filter((group) => !processedGroupIds.has(group.id));
      return {
        status: "complete",
        moved,
        processedGroupIds: [...processedGroupIds],
        plan: this.snapshot(),
      };
    } catch (error) {
      this.plan = null;
      return { status: "error", moved, error: error.message, plan: null };
    } finally {
      this.applying = false;
    }
  }
}

module.exports = { Deduplication };
