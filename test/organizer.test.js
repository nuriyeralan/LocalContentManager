"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createOrganizationPlan,
  createVisualRequestFromMappings,
  createVisualOrganizationPlan,
  looksLikeVisualRequest,
  parseVisualRequest,
  safeSegment,
  selectPriorityCategory,
} = require("../src/main/organizer");

const asset = {
  id: "asset-1",
  name: "beach.jpg",
  relativePath: "Imports\\beach.jpg",
  type: "image",
  modifiedAt: "2025-07-14T12:00:00.000Z",
};

test("creates a local plan using requested metadata dimensions", () => {
  const plan = createOrganizationPlan(
    "Organize by year, media type, tags, and favorite status",
    [asset],
    {
      "Imports/beach.jpg": {
        tags: ["Summer"],
        favorite: true,
      },
    },
  );

  assert.equal(plan.items.length, 1);
  assert.equal(
    plan.items[0].targetRelative,
    ["Organized", "2025", "Photos", "Summer", "Favorites", "beach.jpg"].join(
      require("node:path").sep,
    ),
  );
  assert.match(plan.summary, /1 safe move/);
});

test("rejects an open-ended goal instead of inventing an organization rule", () => {
  assert.throws(
    () => createOrganizationPlan("Please clean this up", [asset], {}),
    /could not map that request/,
  );
});

test("keeps visual classification out of the metadata-only planner", () => {
  const prompt = `Let's organize images into categories using a priority order of:
- images of people
- images with text
- cartoons or comics
- memes or well-recognized internet images
- reactions`;

  assert.throws(
    () => createOrganizationPlan(prompt, [asset], {}),
    /found a visual request/,
  );
});

test("parses ordered visual categories into local classifier prompts", () => {
  const request = parseVisualRequest(`Organize images by priority:
1. images of people
2. images with text
3. cartoons or comics
4. memes
5. reactions`);

  assert.deepEqual(
    request.categories.map((category) => category.name),
    ["People", "Text", "Cartoons or Comics", "Memes or Internet Images", "Reactions"],
  );
  assert.equal(request.labels.length, 6);
});

test("parses a single visual category on a later prompt", () => {
  const request = parseVisualRequest("Organize the remaining images of people");

  assert.deepEqual(request.categories.map((category) => category.name), ["People"]);
  assert.equal(request.labels.length, 2);
});

test("preserves category priority expressed in prose", () => {
  const request = parseVisualRequest(
    "First reactions, then people, and finally images with text.",
  );

  assert.deepEqual(
    request.categories.map((category) => category.name),
    ["Reactions", "People", "Text"],
  );
});

test("does not mistake metadata-only image prompts for visual classification", () => {
  assert.equal(parseVisualRequest("Organize images by year"), null);
});

test("parses arbitrary visual query-to-folder mappings from bullets", () => {
  const request = parseVisualRequest(`Let's move:
- screenshots to "Blue Prince"
- pictures of food to "Food"`);

  assert.deepEqual(
    request.categories.map(({ name, prompt }) => ({ name, prompt })),
    [
      { name: "Blue Prince", prompt: "a screenshot" },
      { name: "Food", prompt: "a photograph of food" },
    ],
  );
});

test("parses a single natural-language visual move command", () => {
  const request = parseVisualRequest("move all photos of babies to 'People'");

  assert.equal(request.categories.length, 1);
  assert.equal(request.categories[0].name, "People");
  assert.equal(request.categories[0].prompt, "a photograph of babies");
  assert.equal(request.categories[0].query, "photos of babies");
});

test("uses the requested destination folder in a visual plan", () => {
  const request = parseVisualRequest("move all photos of babies to 'People'");
  const plan = createVisualOrganizationPlan(
    request,
    [{ asset, categoryIndex: 0, confidence: 0.88 }],
    { total: 1, failed: 0 },
  );

  assert.equal(
    plan.items[0].targetRelative,
    ["People", "beach.jpg"].join(require("node:path").sep),
  );
  assert.match(plan.items[0].reason, /photos of babies.*destination "People".*88%/);
});

test("detects arbitrary visual natural language without misrouting metadata prompts", () => {
  assert.equal(
    looksLikeVisualRequest(
      'Identify and move images that are photographs of the video game "Blue Prince"',
    ),
    true,
  );
  assert.equal(looksLikeVisualRequest("Organize images by year"), false);
  assert.equal(looksLikeVisualRequest("Move images from folder A to folder B"), false);
});

test("creates a visual request from GPT-interpreted mappings", () => {
  const request = createVisualRequestFromMappings([
    {
      visualQuery: "photographs of the video game Blue Prince",
      destinationFolder: "Blue Prince",
    },
  ]);

  assert.equal(request.categories[0].name, "Blue Prince");
  assert.match(request.categories[0].prompt, /video game Blue Prince/);
});

test("uses priority order when category scores are close", () => {
  assert.deepEqual(selectPriorityCategory([0.49, 0.52, 0.02], 2), {
    categoryIndex: 0,
    confidence: 0.49,
  });
  assert.equal(selectPriorityCategory([0.2, 0.25, 0.55], 2), null);
});

test("builds a visual plan only for confident classifications", () => {
  const request = parseVisualRequest(`Organize into categories:
- images of people
- images with text`);
  const plan = createVisualOrganizationPlan(
    request,
    [{ asset, categoryIndex: 1, confidence: 0.91 }],
    { total: 3, failed: 1 },
  );

  assert.equal(plan.items.length, 1);
  assert.match(plan.items[0].targetRelative, /Organized.*Text.*beach\.jpg/);
  assert.match(plan.items[0].reason, /91% confidence; priority 2/);
  assert.equal(plan.analysis.uncertain, 1);
});

test("scopes an explicit image request to images only", () => {
  const video = {
    ...asset,
    id: "asset-2",
    name: "clip.mov",
    relativePath: "Imports\\clip.mov",
    type: "video",
  };
  const plan = createOrganizationPlan("Organize images by year", [asset, video], {});

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].assetId, asset.id);
  assert.match(plan.interpretation, /^images, grouped by year$/);
});

test("rejects tag organization when the selected files have no tags", () => {
  assert.throws(
    () => createOrganizationPlan("Organize images by tags", [asset], {}),
    /None of the selected images have local tags/,
  );
});

test("sanitizes tag names before using them as folders", () => {
  assert.equal(safeSegment('  Family:Trips/2025*  '), "Family-Trips-2025-");
  assert.equal(safeSegment("..."), "Untagged");
});

test("rejects empty organization goals", () => {
  assert.throws(() => createOrganizationPlan(" ", [asset], {}), /Describe an organization goal/);
});
