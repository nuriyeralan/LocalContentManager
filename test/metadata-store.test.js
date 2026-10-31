"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { MetadataStore, validateTags } = require("../src/main/metadata-store");

test("persists local metadata and transfers it after a move", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-metadata-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "metadata.json");
  const rootPath = path.join(directory, "library");

  const store = new MetadataStore(filePath);
  await store.load();
  await store.update(rootPath, "old\\photo.jpg", {
    tags: ["Family", "Travel"],
    favorite: true,
  });
  await store.move(rootPath, "old\\photo.jpg", "new\\photo.jpg");

  const reloaded = new MetadataStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.list(rootPath)["new/photo.jpg"].tags, ["Family", "Travel"]);
  assert.equal(reloaded.list(rootPath)["new/photo.jpg"].favorite, true);
  assert.equal(reloaded.list(rootPath)["old/photo.jpg"], undefined);
});

test("normalizes and deduplicates tags", () => {
  assert.deepEqual(validateTags([" Family ", "family", "Travel"]), ["Family", "Travel"]);
  assert.throws(() => validateTags([""]), /1-40 characters/);
});

test("removes metadata for deleted media", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-metadata-remove-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new MetadataStore(path.join(directory, "metadata.json"));
  await store.load();
  await store.update(directory, "photo.jpg", { tags: ["Delete me"], favorite: true });
  await store.remove(directory, "photo.jpg");

  assert.equal(store.list(directory)["photo.jpg"], undefined);
});
