"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

class SettingsStore {
  constructor(filePath, auditFilePath) {
    this.filePath = filePath;
    this.auditFilePath = auditFilePath;
    this.value = {
      mediaRoot: null,
      recycleBinRoot: null,
      visionModel: null,
      visionConcurrency: 4,
    };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.value = {
        mediaRoot: typeof parsed.mediaRoot === "string" ? parsed.mediaRoot : null,
        recycleBinRoot: typeof parsed.recycleBinRoot === "string" ? parsed.recycleBinRoot : null,
        visionModel: typeof parsed.visionModel === "string" ? parsed.visionModel : null,
        visionConcurrency: [1, 2, 4, 8].includes(parsed.visionConcurrency)
          ? parsed.visionConcurrency
          : 4,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.get();
  }

  get() {
    return { ...this.value };
  }

  async commitUserSelection(field, value, source) {
    const allowedSources = {
      mediaRoot: "media-folder-picker",
      recycleBinRoot: value === null ? "confirmed-recycle-clear" : "recycle-folder-picker",
      visionModel: "model-picker",
      visionConcurrency: "concurrency-picker",
    };
    if (!Object.hasOwn(allowedSources, field) || source !== allowedSources[field]) {
      throw new Error("Settings can only be changed through a confirmed user settings action.");
    }
    if (
      field !== "visionModel" &&
      field !== "visionConcurrency" &&
      value !== null &&
      (typeof value !== "string" || !path.isAbsolute(value))
    ) {
      throw new Error("A selected settings folder must be an absolute path.");
    }
    if (
      field === "visionModel" &&
      (typeof value !== "string" || !value.trim() || value.length > 200)
    ) {
      throw new Error("A selected vision model must be a valid model identifier.");
    }
    if (field === "visionConcurrency" && ![1, 2, 4, 8].includes(value)) {
      throw new Error("Vision concurrency must be 1, 2, 4, or 8.");
    }

    const previousValue = this.value[field];
    if (previousValue === value) return this.get();
    this.value[field] = value;
    await this.#save();
    await this.#appendAudit({
      timestamp: new Date().toISOString(),
      field,
      source,
      previousValue,
      value,
    });
    return this.get();
  }

  #save() {
    const snapshot = JSON.stringify(this.value, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  async #appendAudit(event) {
    await fs.mkdir(path.dirname(this.auditFilePath), { recursive: true });
    await fs.appendFile(this.auditFilePath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

module.exports = { SettingsStore };
