"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function normalizedRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function rootKey(rootPath) {
  return crypto.createHash("sha256").update(normalizedRoot(rootPath)).digest("hex");
}

function itemKey(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function fingerprint(asset) {
  return `${asset.size}:${asset.modifiedAt}`;
}

function requestKey(modelRevision, labels) {
  return crypto
    .createHash("sha256")
    .update(modelRevision)
    .update("\0")
    .update(JSON.stringify(labels))
    .digest("hex");
}

class VisionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, roots: {} };
    this.writeQueue = Promise.resolve();
    this.dirty = false;
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed?.version !== 1 || !parsed.roots || typeof parsed.roots !== "object") {
        throw new Error("The visual-analysis cache has an unsupported format.");
      }
      this.data = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(rootPath, asset, analysisKey) {
    const entry = this.data.roots[rootKey(rootPath)]?.items?.[itemKey(asset.relativePath)];
    if (
      !entry ||
      entry.fingerprint !== fingerprint(asset) ||
      entry.analysisKey !== analysisKey ||
      !Array.isArray(entry.scores)
    ) {
      return null;
    }
    return structuredClone(entry.scores);
  }

  set(rootPath, asset, analysisKey, scores) {
    const root = this.#ensureRoot(rootPath);
    root.items[itemKey(asset.relativePath)] = {
      fingerprint: fingerprint(asset),
      analysisKey,
      scores,
      analyzedAt: new Date().toISOString(),
    };
    this.dirty = true;
  }

  move(rootPath, fromRelativePath, toRelativePath) {
    const root = this.#ensureRoot(rootPath);
    const fromKey = itemKey(fromRelativePath);
    const toKey = itemKey(toRelativePath);
    if (Object.hasOwn(root.items, fromKey)) {
      root.items[toKey] = root.items[fromKey];
      delete root.items[fromKey];
      this.dirty = true;
    }
  }

  remove(rootPath, relativePath) {
    const root = this.#ensureRoot(rootPath);
    const key = itemKey(relativePath);
    if (Object.hasOwn(root.items, key)) {
      delete root.items[key];
      this.dirty = true;
    }
  }

  flush() {
    if (!this.dirty) return this.writeQueue;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  #ensureRoot(rootPath) {
    const key = rootKey(rootPath);
    if (!this.data.roots[key]) {
      this.data.roots[key] = { rootPath: path.resolve(rootPath), items: {} };
    }
    return this.data.roots[key];
  }
}

module.exports = { requestKey, VisionStore };
