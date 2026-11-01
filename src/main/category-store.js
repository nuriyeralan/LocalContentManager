"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function normalizedRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function rootKey(rootPath) {
  return crypto.createHash("sha256").update(normalizedRoot(rootPath)).digest("hex");
}

function validateCategoryName(value) {
  if (typeof value !== "string") throw new Error("Category name must be text.");
  const name = value.trim();
  if (!name || name.length > 60) {
    throw new Error("Category name must contain 1-60 characters.");
  }
  if (
    name === "." ||
    name === ".." ||
    name.toLocaleLowerCase() === "organized" ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    RESERVED_WINDOWS_NAMES.test(name)
  ) {
    throw new Error("Category name is not a valid folder name.");
  }
  return name;
}

function validateCategoryDescription(value) {
  if (typeof value !== "string") throw new Error("Category description must be text.");
  const description = value.trim();
  if (description.length > 500) {
    throw new Error("Category description must contain at most 500 characters.");
  }
  return description;
}

function normalizeCategory(category) {
  if (typeof category === "string") {
    return { name: validateCategoryName(category), description: "" };
  }
  return {
    name: validateCategoryName(category?.name),
    description: validateCategoryDescription(category?.description ?? ""),
  };
}

class CategoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, roots: {} };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed?.version !== 1 || !parsed.roots || typeof parsed.roots !== "object") {
        throw new Error("The category store has an unsupported format.");
      }
      this.data = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  list(rootPath) {
    const categories = this.data.roots[rootKey(rootPath)]?.categories ?? [];
    return categories
      .map(normalizeCategory)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async add(rootPath, value, description = "") {
    const name = validateCategoryName(value);
    const normalizedDescription = validateCategoryDescription(description);
    const key = rootKey(rootPath);
    const root = this.data.roots[key] ?? {
      rootPath: path.resolve(rootPath),
      categories: [],
    };
    this.data.roots[key] = root;
    root.categories = root.categories.map(normalizeCategory);
    const existing = root.categories.find(
      (category) => category.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (existing) {
      if (normalizedDescription && existing.description !== normalizedDescription) {
        existing.description = normalizedDescription;
        await this.#save();
      }
      return structuredClone(existing);
    }
    const category = { name, description: normalizedDescription };
    root.categories.push(category);
    await this.#save();
    return structuredClone(category);
  }

  async updateDescription(rootPath, value, description) {
    const name = validateCategoryName(value);
    const normalizedDescription = validateCategoryDescription(description);
    const key = rootKey(rootPath);
    const root = this.data.roots[key];
    if (!root) throw new Error("Category was not found.");
    root.categories = root.categories.map(normalizeCategory);
    const category = root.categories.find(
      (entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (!category) throw new Error("Category was not found.");
    category.description = normalizedDescription;
    await this.#save();
    return structuredClone(category);
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

module.exports = {
  CategoryStore,
  validateCategoryDescription,
  validateCategoryName,
};
