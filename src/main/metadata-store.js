"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

function normalizedRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rootKey(rootPath) {
  return crypto.createHash("sha256").update(normalizedRoot(rootPath)).digest("hex");
}

function itemKey(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function validateTags(tags) {
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    throw new Error(`Tags must be an array containing at most ${MAX_TAGS} items.`);
  }

  const unique = [];
  const seen = new Set();
  for (const value of tags) {
    if (typeof value !== "string") throw new Error("Every tag must be text.");
    const tag = value.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH) {
      throw new Error(`Tags must contain 1-${MAX_TAG_LENGTH} characters.`);
    }
    const comparisonKey = tag.toLocaleLowerCase();
    if (!seen.has(comparisonKey)) {
      seen.add(comparisonKey);
      unique.push(tag);
    }
  }
  return unique;
}

class MetadataStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, roots: {} };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed?.version === 1 && parsed.roots && typeof parsed.roots === "object") {
        this.data = parsed;
      } else {
        throw new Error("The metadata file has an unsupported format.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  list(rootPath) {
    const items = this.data.roots[rootKey(rootPath)]?.items ?? {};
    return structuredClone(items);
  }

  async update(rootPath, relativePath, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Metadata changes must be an object.");
    }

    const root = this.#ensureRoot(rootPath);
    const key = itemKey(relativePath);
    const previous = root.items[key] ?? { tags: [], favorite: false };
    const next = {
      tags: Object.hasOwn(patch, "tags") ? validateTags(patch.tags) : previous.tags,
      favorite: Object.hasOwn(patch, "favorite") ? patch.favorite === true : previous.favorite,
      updatedAt: new Date().toISOString(),
    };
    root.items[key] = next;
    await this.#save();
    return structuredClone(next);
  }

  async move(rootPath, fromRelativePath, toRelativePath) {
    const root = this.#ensureRoot(rootPath);
    const fromKey = itemKey(fromRelativePath);
    const toKey = itemKey(toRelativePath);
    if (Object.hasOwn(root.items, fromKey)) {
      root.items[toKey] = root.items[fromKey];
      delete root.items[fromKey];
      await this.#save();
    }
  }

  async remove(rootPath, relativePath) {
    const root = this.#ensureRoot(rootPath);
    const key = itemKey(relativePath);
    if (Object.hasOwn(root.items, key)) {
      delete root.items[key];
      await this.#save();
    }
  }

  #ensureRoot(rootPath) {
    const key = rootKey(rootPath);
    if (!this.data.roots[key]) {
      this.data.roots[key] = {
        rootPath: path.resolve(rootPath),
        items: {},
      };
    }
    return this.data.roots[key];
  }

  #save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}

module.exports = { MetadataStore, validateTags };
