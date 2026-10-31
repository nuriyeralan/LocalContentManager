"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = { mediaRoot: null, recycleBinRoot: null };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.value = {
        mediaRoot: typeof parsed.mediaRoot === "string" ? parsed.mediaRoot : null,
        recycleBinRoot: typeof parsed.recycleBinRoot === "string" ? parsed.recycleBinRoot : null,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.get();
  }

  get() {
    return { ...this.value };
  }

  async setMediaRoot(mediaRoot) {
    this.value.mediaRoot = mediaRoot;
    await this.#save();
    return this.get();
  }

  async setRecycleBinRoot(recycleBinRoot) {
    this.value.recycleBinRoot = recycleBinRoot;
    await this.#save();
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
}

module.exports = { SettingsStore };
