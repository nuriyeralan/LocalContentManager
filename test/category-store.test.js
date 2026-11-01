"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CategoryStore,
  validateCategoryDescription,
  validateCategoryName,
} = require("../src/main/category-store");

test("persists unique categories per media library", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-categories-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "categories.json");
  const store = new CategoryStore(filePath);
  await store.load();
  await store.add("C:\\Media", "Kids", "Photos of children and family activities.");
  await store.add("C:\\Media", "kids");
  await store.add("D:\\Media", "Travel");

  const reloaded = new CategoryStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.list("C:\\Media"), [
    { name: "Kids", description: "Photos of children and family activities." },
  ]);
  assert.deepEqual(reloaded.list("D:\\Media"), [{ name: "Travel", description: "" }]);
});

test("rejects unsafe category folder names", () => {
  assert.equal(validateCategoryName(" Kids "), "Kids");
  for (const value of ["", "..", "Organized", "A/B", "CON", "Trailing."]) {
    assert.throws(() => validateCategoryName(value));
  }
  assert.equal(validateCategoryDescription(" Family photos "), "Family photos");
  assert.throws(() => validateCategoryDescription("x".repeat(501)));
});

test("migrates string categories and updates descriptions", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-category-migration-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "categories.json");
  const root = "C:\\Media";
  const seed = new CategoryStore(filePath);
  await seed.load();
  await seed.add(root, "Kids");
  const initial = JSON.parse(await fs.readFile(filePath, "utf8"));
  Object.values(initial.roots)[0].categories = ["Kids"];
  await fs.writeFile(filePath, JSON.stringify(initial));
  const store = new CategoryStore(filePath);
  await store.load();
  await store.updateDescription(root, "Kids", "Children and family moments.");

  assert.deepEqual(store.list(root), [
    { name: "Kids", description: "Children and family moments." },
  ]);
});
