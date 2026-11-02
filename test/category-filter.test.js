"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app.js"), "utf8");
const filterCode = source.slice(source.indexOf("function matchesCategory("), source.indexOf("function renderCard("));

test("folder views and counts consistently include nested media and retain search and type filters", () => {
  const assets = [
    { name: "root.jpg", relativePath: "root.jpg", type: "image" },
    { name: "child.jpg", relativePath: "Kids\\Nested\\child.jpg", type: "image" },
    { name: "clip.mp4", relativePath: "Travel/clip.mp4", type: "video" },
  ];
  const state = { assets, categoryFilter: null, filter: "all", search: "" };
  const elements = { counts: Object.fromEntries(
    ["all", "image", "video", "audio", "favorite"].map((name) => [name, {}]),
  ) };
  const context = vm.createContext({ state, elements, metadataFor: () => ({ tags: [], favorite: false }) });
  vm.runInContext(filterCode, context);
  const count = () => vm.runInContext("filteredAssets().length", context);
  const update = () => vm.runInContext("updateCounts()", context);
  assert.equal(count(), 1);
  state.categoryFilter = "kids";
  assert.equal(count(), 1);
  update();
  assert.equal(elements.counts.all.textContent, 1);
  state.categoryFilter = "*";
  assert.equal(count(), 3);
  update();
  assert.equal(elements.counts.all.textContent, 3);
  assert.equal(elements.counts.image.textContent, 2);
  state.filter = "image";
  assert.equal(count(), 2);
  state.search = "nested";
  assert.equal(count(), 1);
});
