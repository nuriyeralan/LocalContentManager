"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { RecommendationStore } = require("../src/main/recommendation-store");

const asset = {
  relativePath: "photo.jpg",
  size: 123,
  modifiedAt: "2026-10-31T12:00:00.000Z",
};

test("persists, moves, and removes category recommendations", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-content-recommend-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "recommendations.json");
  const store = new RecommendationStore(filePath);
  await store.load();
  store.set(directory, asset, "model-and-categories", {
    categoryName: "Kids",
    confidence: 0.9,
    reason: "A child is visible.",
  });
  store.move(directory, "photo.jpg", "Kids\\photo.jpg");
  await store.flush();

  const reloaded = new RecommendationStore(filePath);
  await reloaded.load();
  const movedAsset = { ...asset, relativePath: "Kids\\photo.jpg" };
  assert.equal(
    reloaded.get(directory, movedAsset, "model-and-categories").categoryName,
    "Kids",
  );
  reloaded.remove(directory, movedAsset.relativePath);
  assert.equal(reloaded.get(directory, movedAsset, "model-and-categories"), null);
});
