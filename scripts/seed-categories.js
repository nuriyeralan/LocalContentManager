"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { CATEGORY_FILE, CategoryStore } = require("../src/main/category-store");
const { productName } = require("../package.json");

async function main() {
  const [requestedRoot, ...extra] = process.argv.slice(2);
  if (!requestedRoot || extra.length || !path.isAbsolute(requestedRoot)) {
    throw new Error("Usage: npm run seed:categories -- <absolute library folder>");
  }
  if (!process.env.APPDATA) throw new Error("Windows APPDATA is required to locate legacy definitions.");
  const root = await fs.realpath(requestedRoot);
  const store = new CategoryStore(path.join(process.env.APPDATA, productName, "categories.json"));
  await store.load();
  const categories = await store.seed(root);
  console.log(`Seeded ${categories.length} categories in ${path.join(root, CATEGORY_FILE)}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
