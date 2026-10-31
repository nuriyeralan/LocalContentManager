"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { requestKey, VisionStore } = require("../src/main/vision-store");

const asset = {
  relativePath: "Imports\\photo.jpg",
  size: 1024,
  modifiedAt: "2026-10-31T12:00:00.000Z",
};

test("caches visual scores by model request and file fingerprint", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-vision-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "vision.json");
  const key = requestKey("revision", ["people", "text"]);

  const store = new VisionStore(filePath);
  await store.load();
  store.set(directory, asset, key, [0.8, 0.2]);
  await store.flush();

  const reloaded = new VisionStore(filePath);
  await reloaded.load();
  assert.deepEqual(reloaded.get(directory, asset, key), [0.8, 0.2]);
  assert.equal(reloaded.get(directory, { ...asset, size: 2048 }, key), null);
  assert.equal(reloaded.get(directory, asset, requestKey("other", ["people", "text"])), null);
});

test("moves and removes cached visual analysis with media", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-vision-move-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new VisionStore(path.join(directory, "vision.json"));
  const key = requestKey("revision", ["people"]);
  await store.load();
  store.set(directory, asset, key, [1]);
  store.move(directory, asset.relativePath, "Organized\\People\\photo.jpg");
  assert.deepEqual(
    store.get(directory, { ...asset, relativePath: "Organized\\People\\photo.jpg" }, key),
    [1],
  );
  store.remove(directory, "Organized\\People\\photo.jpg");
  assert.equal(
    store.get(directory, { ...asset, relativePath: "Organized\\People\\photo.jpg" }, key),
    null,
  );
});
