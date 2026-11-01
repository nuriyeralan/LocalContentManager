"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classificationReasoningEffort,
  choosePreferredModel,
  extractJson,
  normalizeConcurrency,
  parseCategoryDescriptionJson,
  parseCategoryRecommendationJson,
  parseVisualMappingsJson,
} = require("../src/main/vision-analyzer");

const models = [
  { id: "other-vision", name: "Other Vision" },
  { id: "gpt-5.6-sol-fast", name: "GPT-5.6 Sol Fast" },
];

test("prefers the configured available vision model", () => {
  assert.equal(choosePreferredModel(models, "other-vision").id, "other-vision");
});

test("prefers GPT-5.6 Sol Fast when no configured model is available", () => {
  assert.equal(choosePreferredModel(models, "retired-model").id, "gpt-5.6-sol-fast");
});

test("extracts classification JSON without accepting surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"items":[]}\n```'), { items: [] });
  assert.throws(() => extractJson("No JSON here"), /did not return JSON/);
});

test("uses the lowest available reasoning effort for classification", () => {
  assert.equal(
    classificationReasoningEffort({ supportedReasoningEfforts: ["low", "medium"] }),
    "low",
  );
  assert.equal(
    classificationReasoningEffort({ supportedReasoningEfforts: ["none", "low"] }),
    "none",
  );
  assert.equal(classificationReasoningEffort({ supportedReasoningEfforts: [] }), null);
});

test("enforces the configured maximum concurrency", () => {
  assert.equal(normalizeConcurrency(8, 20), 8);
  assert.equal(normalizeConcurrency(8, 3), 3);
  assert.equal(normalizeConcurrency(16, 20), 4);
  assert.equal(normalizeConcurrency(1, 20), 1);
});

test("validates GPT-interpreted visual mappings", () => {
  assert.deepEqual(
    parseVisualMappingsJson(
      '{"categories":[{"visualQuery":"photographs of Blue Prince","destinationFolder":"Blue Prince"}]}',
    ),
    [
      {
        visualQuery: "photographs of Blue Prince",
        destinationFolder: "Blue Prince",
      },
    ],
  );
  assert.throws(
    () => parseVisualMappingsJson('{"categories":[]}'),
    /did not return visual categories/,
  );
});

test("validates category recommendations against available categories", () => {
  const categories = [
    { name: "Kids", description: "Children and family activities." },
  ];
  assert.deepEqual(
    parseCategoryRecommendationJson(
      '{"categoryName":"kids","confidence":0.92,"reason":"A child is visible."}',
      categories,
    ),
    {
      categoryName: "Kids",
      confidence: 0.92,
      reason: "A child is visible.",
    },
  );
  assert.throws(
    () =>
      parseCategoryRecommendationJson(
        '{"categoryName":"Unknown","confidence":0.8,"reason":""}',
        categories,
      ),
    /unknown category/,
  );
});

test("validates drafted category descriptions", () => {
  assert.equal(
    parseCategoryDescriptionJson(
      '{"description":"Images containing readable text, signs, screenshots, or documents."}',
    ),
    "Images containing readable text, signs, screenshots, or documents.",
  );
  assert.throws(
    () => parseCategoryDescriptionJson('{"description":""}'),
    /invalid category description/,
  );
});
