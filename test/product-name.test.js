"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = require("../package.json");

test("uses the spaced product display name across application surfaces", () => {
  assert.equal(manifest.productName, "Local Content Manager");
  const renderer = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer", "index.html"),
    "utf8",
  );
  assert.match(renderer, /<title>Local Content Manager<\/title>/);
  assert.match(renderer, /<h1>Local Content Manager<\/h1>/);
});
