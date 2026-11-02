"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CATEGORY_FILE = ".local-content-categories.json";

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

function validateExistingFolderName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
    /[. ]$/.test(value) ||
    RESERVED_WINDOWS_NAMES.test(value)
  ) {
    throw new Error("Category definition contains an invalid folder name.");
  }
  return value;
}

function normalizeCategory(category) {
  if (typeof category === "string") {
    return { name: validateExistingFolderName(category), description: "" };
  }
  return {
    name: validateExistingFolderName(category?.name),
    description: validateCategoryDescription(category?.description ?? ""),
  };
}

class CategoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, roots: {} };
    this.libraries = new Map();
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
    return structuredClone(this.libraries.get(rootKey(rootPath))?.categories ?? []);
  }

  async #readDefinitions(rootPath) {
    const filePath = path.join(rootPath, CATEGORY_FILE);
    try {
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("Category definitions must be a regular, unlinked file.");
      }
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || !Array.isArray(parsed.categories)) {
        throw new Error("The library category definitions have an unsupported format.");
      }
      const categories = parsed.categories.map(normalizeCategory);
      const names = categories.map((category) => category.name.toLocaleLowerCase());
      if (new Set(names).size !== names.length) {
        throw new Error("The library category definitions contain duplicate folder names.");
      }
      return { raw, categories };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { raw: null, categories: null };
    }
  }

  async #discover(rootPath, definitions) {
    const saved = definitions.categories ??
      (this.data.roots[rootKey(rootPath)]?.categories ?? []).map(normalizeCategory);
    const descriptions = new Map(
      saved.map((category) => [category.name.toLocaleLowerCase(), category.description]),
    );
    let entries = await fs.readdir(rootPath, { withFileTypes: true });
    const folders = new Set(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name.toLocaleLowerCase()),
    );
    let createdFolders = false;
    for (const category of definitions.categories ?? []) {
      if (folders.has(category.name.toLocaleLowerCase())) continue;
      const folderPath = path.join(rootPath, category.name);
      try {
        await fs.mkdir(folderPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stats = await fs.lstat(folderPath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new Error(`Category folder "${category.name}" must be a regular, unlinked directory.`);
        }
      }
      createdFolders = true;
    }
    if (createdFolders) entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        entry.name !== CATEGORY_FILE &&
        !entry.name.startsWith(`${CATEGORY_FILE}.`),
      )
      .map((entry) => ({
        name: validateExistingFolderName(entry.name),
        description: descriptions.get(entry.name.toLocaleLowerCase()) ?? "",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async refresh(rootPath) {
    const definitions = await this.#readDefinitions(rootPath);
    const categories = await this.#discover(rootPath, definitions);
    this.libraries.set(rootKey(rootPath), { ...definitions, categories });
    return this.list(rootPath);
  }

  async seed(rootPath) {
    await this.refresh(rootPath);
    await this.#save(rootPath, () => {});
    return this.list(rootPath);
  }

  async add(rootPath, value, description = "") {
    const name = this.list(rootPath).find((category) => category.name === value)?.name ??
      validateCategoryName(value);
    const normalizedDescription = validateCategoryDescription(description);
    let result;
    await this.#save(rootPath, (categories) => {
      const category = categories.find(
        (entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      if (!category) throw new Error("Create the category folder before saving its definition.");
      if (normalizedDescription) category.description = normalizedDescription;
      result = structuredClone(category);
    });
    return result;
  }

  async updateDescription(rootPath, value, description) {
    const name = validateExistingFolderName(value);
    const normalizedDescription = validateCategoryDescription(description);
    let result;
    await this.#save(rootPath, (categories) => {
      const category = categories.find(
        (entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      if (!category) throw new Error("Category folder was not found. Rescan the library.");
      category.description = normalizedDescription;
      result = structuredClone(category);
    });
    return result;
  }

  async #save(rootPath, mutate) {
    const key = rootKey(rootPath);
    if (!this.libraries.has(key)) await this.refresh(rootPath);
    const expectedRaw = this.libraries.get(key).raw;
    const filePath = path.join(rootPath, CATEGORY_FILE);
    const lockPath = `${filePath}.lock`;
    let lock;
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("Category definitions are locked by another writer. Retry after it finishes; a stale lock after a crash must be removed manually.");
      }
      throw error;
    }
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const definitions = await this.#readDefinitions(rootPath);
      if (definitions.raw !== expectedRaw) {
        throw new Error("Category definitions changed on disk. Rescan the library before saving.");
      }
      const categories = await this.#discover(rootPath, definitions);
      mutate(categories);
      const raw = `${JSON.stringify({ version: 1, categories }, null, 2)}\n`;
      await fs.writeFile(temporaryPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, filePath);
      this.libraries.set(key, { raw, categories });
    } finally {
      try {
        await fs.rm(temporaryPath, { force: true });
      } finally {
        try {
          await lock.close();
        } finally {
          await fs.unlink(lockPath);
        }
      }
    }
  }
}

module.exports = {
  CATEGORY_FILE,
  CategoryStore,
  validateCategoryDescription,
  validateCategoryName,
};
