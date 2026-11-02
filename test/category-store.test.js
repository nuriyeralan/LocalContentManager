"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CATEGORY_FILE,
  CategoryStore,
  validateCategoryDescription,
  validateCategoryName,
} = require("../src/main/category-store");

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-categories-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "library");
  await fs.mkdir(root);
  const legacyPath = path.join(directory, "legacy.json");
  const store = new CategoryStore(legacyPath);
  await store.load();
  return { directory, root, legacyPath, store, filePath: path.join(root, CATEGORY_FILE) };
}

test("discovers existing and empty folders without writing category metadata", async (context) => {
  const { root, store, filePath } = await fixture(context);
  await fs.mkdir(path.join(root, "Kids"));
  await fs.mkdir(path.join(root, "Organized"));
  await fs.writeFile(path.join(root, "photo.jpg"), "image");
  assert.deepEqual(await store.refresh(root), [
    { name: "Kids", description: "" },
    { name: "Organized", description: "" },
  ]);
  await assert.rejects(fs.stat(filePath), { code: "ENOENT" });
  await store.updateDescription(root, "Organized", "Existing folder.");
  await store.add(root, "Organized");
  assert.equal(store.list(root)[1].description, "Existing folder.");
});

test("seeds library-local definitions and preserves legacy descriptions for matching folders", async (context) => {
  const { root, legacyPath, store, filePath } = await fixture(context);
  await fs.mkdir(path.join(root, "Kids"));
  await fs.mkdir(path.join(root, "Travel"));
  const normalized = process.platform === "win32" ? root.toLocaleLowerCase() : root;
  const key = crypto.createHash("sha256").update(normalized).digest("hex");
  await fs.writeFile(legacyPath, JSON.stringify({
    version: 1,
    roots: { [key]: { categories: [
      { name: "kids", description: "Family moments." },
      "Travel",
      { name: "Missing", description: "No matching folder." },
    ] } },
  }));
  await store.load();
  const legacyBefore = await fs.readFile(legacyPath, "utf8");
  await store.seed(root);
  const expected = [
    { name: "Kids", description: "Family moments." },
    { name: "Travel", description: "" },
  ];
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), {
    version: 1, categories: expected,
  });
  assert.equal(await fs.readFile(legacyPath, "utf8"), legacyBefore);
  const anotherPC = new CategoryStore(path.join(root, "absent-legacy.json"));
  await anotherPC.load();
  assert.deepEqual(await anotherPC.refresh(root), expected);
});

test("creates missing category folders from library definitions without rewriting metadata", async (context) => {
  const { root, store, filePath } = await fixture(context);
  await fs.mkdir(path.join(root, "Existing"));
  await fs.writeFile(path.join(root, "Existing", "photo.jpg"), "image");
  const raw = JSON.stringify({
    version: 1,
    categories: [
      { name: "Kids", description: "Family moments." },
      "Travel",
      { name: "existing", description: "Already here." },
    ],
  });
  await fs.writeFile(filePath, raw);
  const expected = [
    { name: "Existing", description: "Already here." },
    { name: "Kids", description: "Family moments." },
    { name: "Travel", description: "" },
  ];
  assert.deepEqual(await store.refresh(root), expected);
  for (const category of expected) {
    assert.equal((await fs.lstat(path.join(root, category.name))).isDirectory(), true);
  }
  assert.deepEqual(await fs.readdir(path.join(root, "Kids")), []);
  assert.equal(await fs.readFile(path.join(root, "Existing", "photo.jpg"), "utf8"), "image");
  assert.equal(await fs.readFile(filePath, "utf8"), raw);
  context.mock.method(fs, "mkdir", async () => {
    assert.fail("Existing category folders must not require write access.");
  });
  assert.deepEqual(await store.refresh(root), expected);
});

test("restores removed category folders before saving their definitions", async (context) => {
  const { root, store, filePath } = await fixture(context);
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    categories: [{ name: "Kids", description: "Family." }],
  }));
  await store.refresh(root);
  await fs.rmdir(path.join(root, "Kids"));
  await store.updateDescription(root, "Kids", "Updated.");
  assert.equal((await fs.lstat(path.join(root, "Kids"))).isDirectory(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).categories, [
    { name: "Kids", description: "Updated." },
  ]);
});

test("library definitions restore renamed folders without transferring their descriptions", async (context) => {
  const { root, store, filePath } = await fixture(context);
  await fs.mkdir(path.join(root, "Kids"));
  await store.refresh(root);
  await store.add(root, "Kids", "Family.");
  await fs.rename(path.join(root, "Kids"), path.join(root, "Family"));
  assert.deepEqual(await store.refresh(root), [
    { name: "Family", description: "" },
    { name: "Kids", description: "Family." },
  ]);
  await store.updateDescription(root, "Family", "New description.");
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).categories, [
    { name: "Family", description: "New description." },
    { name: "Kids", description: "Family." },
  ]);
  await store.updateDescription(root, "Family", "");
  assert.equal(store.list(root)[0].description, "");
});

test("detects concurrent edits without overwriting and can retry after rescan", async (context) => {
  const { root, store, legacyPath, filePath } = await fixture(context);
  await fs.mkdir(path.join(root, "Kids"));
  await store.seed(root);
  const other = new CategoryStore(legacyPath);
  await other.load();
  await other.refresh(root);
  await store.updateDescription(root, "Kids", "First writer.");
  await assert.rejects(other.updateDescription(root, "Kids", "Stale writer."), /changed on disk/);
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).categories[0].description, "First writer.");
  await other.refresh(root);
  await other.updateDescription(root, "Kids", "After rescan.");
  assert.equal(other.list(root)[0].description, "After rescan.");
  await assert.rejects(fs.stat(`${filePath}.lock`), { code: "ENOENT" });
});

test("refuses active locks and reports write failures without losing discovered categories", async (context) => {
  const { root, store, filePath } = await fixture(context);
  await fs.mkdir(path.join(root, "Kids"));
  await store.refresh(root);
  await fs.writeFile(`${filePath}.lock`, "");
  await assert.rejects(store.updateDescription(root, "Kids", "Blocked."), /locked by another writer/);
  await fs.unlink(`${filePath}.lock`);
  await fs.mkdir(`${filePath}.lock`);
  await assert.rejects(store.seed(root));
  assert.deepEqual(store.list(root), [{ name: "Kids", description: "" }]);
  await fs.rmdir(`${filePath}.lock`);
  await store.updateDescription(root, "Kids", "Recovered.");
});

test("rejects malformed, duplicate and unsafe library definitions explicitly", async (context) => {
  const { root, store, filePath } = await fixture(context);
  for (const contents of [
    "{",
    '{"version":2,"categories":[]}',
    '{"version":1,"categories":[{"name":"../escape","description":""}]}',
    '{"version":1,"categories":[{"name":"Kids"},{"name":"kids"}]}',
    '{"version":1,"categories":[{"name":"Kids"},{"name":"../escape"}]}',
  ]) {
    await fs.writeFile(filePath, contents);
    await assert.rejects(store.refresh(root));
    await assert.rejects(fs.stat(path.join(root, "Kids")), { code: "ENOENT" });
  }
});

test("reports category folder creation failures without changing definitions", async (context) => {
  const { root, store, filePath } = await fixture(context);
  const raw = '{"version":1,"categories":[{"name":"Kids","description":"Family."}]}';
  await fs.writeFile(filePath, raw);
  context.mock.method(fs, "mkdir", async () => {
    const error = new Error("Access denied.");
    error.code = "EACCES";
    throw error;
  });
  await assert.rejects(store.refresh(root), { code: "EACCES" });
  assert.deepEqual(store.list(root), []);
  assert.equal(await fs.readFile(filePath, "utf8"), raw);
  await assert.rejects(fs.stat(path.join(root, "Kids")), { code: "ENOENT" });
});

test("does not overwrite files or follow junctions that conflict with category definitions", async (context) => {
  const { directory, root, store, filePath } = await fixture(context);
  const folderPath = path.join(root, "Kids");
  const raw = '{"version":1,"categories":[{"name":"Kids","description":"Family."}]}';
  await fs.writeFile(filePath, raw);
  await fs.writeFile(folderPath, "Keep this file.");
  await assert.rejects(store.refresh(root), /regular, unlinked directory/);
  assert.equal(await fs.readFile(folderPath, "utf8"), "Keep this file.");
  await fs.unlink(folderPath);
  const outside = path.join(directory, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, folderPath, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.refresh(root), /regular, unlinked directory/);
  assert.equal((await fs.lstat(folderPath)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(filePath, "utf8"), raw);
});

test("accepts category folders created concurrently by another library load", async (context) => {
  const { root, store, filePath } = await fixture(context);
  await fs.writeFile(filePath, '{"version":1,"categories":[{"name":"Kids","description":"Family."}]}');
  const mkdir = fs.mkdir;
  context.mock.method(fs, "mkdir", async (...args) => {
    await mkdir(...args);
    return mkdir(...args);
  });
  assert.deepEqual(await store.refresh(root), [{ name: "Kids", description: "Family." }]);
});

test("read-only libraries remain discoverable and saving reports permission errors", async (context) => {
  const { root, store } = await fixture(context);
  await fs.mkdir(path.join(root, "Kids"));
  context.mock.method(fs, "open", async () => {
    const error = new Error("Access denied.");
    error.code = "EACCES";
    throw error;
  });
  assert.deepEqual(await store.refresh(root), [{ name: "Kids", description: "" }]);
  await assert.rejects(store.updateDescription(root, "Kids", "Not saved."), { code: "EACCES" });
  assert.equal(store.list(root)[0].description, "");
});

test("does not discover junctions or follow linked definitions", async (context) => {
  const { directory, root, store, filePath } = await fixture(context);
  const outside = path.join(directory, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "Linked"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await store.refresh(root), []);
  await fs.symlink(outside, filePath, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.refresh(root), /regular, unlinked file/);
});

test("rejects unsafe new category folder names", () => {
  assert.equal(validateCategoryName(" Kids "), "Kids");
  for (const value of ["", "..", "Organized", "A/B", "CON", "Trailing."]) {
    assert.throws(() => validateCategoryName(value));
  }
  assert.equal(validateCategoryDescription(" Family photos "), "Family photos");
  assert.throws(() => validateCategoryDescription("x".repeat(501)));
});
