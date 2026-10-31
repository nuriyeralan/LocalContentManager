"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_GOAL_LENGTH = 400;
const VISUAL_CONFIDENCE_THRESHOLD = 0.3;
const PRIORITY_SCORE_TOLERANCE = 0.04;
const OTHER_IMAGE_PROMPT = "another kind of image that does not match the requested categories";

function safeSegment(value) {
  const segment = String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  return segment.slice(0, 60) || "Untagged";
}

function visualConceptsIn(goal) {
  const concepts = [
    [/\b(people|persons?|faces?|portraits?|selfies?)\b/, "people"],
    [/\b(text|writing|written|words?|ocr)\b/, "visible text"],
    [/\b(cartoons?|comics?)\b/, "cartoons or comics"],
    [/\b(memes?|well[- ]recognized internet images?|viral images?)\b/, "memes or internet images"],
    [/\b(reactions?|reaction images?|reaction gifs?)\b/, "reactions"],
  ];
  return concepts.filter(([pattern]) => pattern.test(goal)).map(([, label]) => label);
}

function visualCategoryDetails(label) {
  const normalized = label.toLocaleLowerCase();
  if (/\b(people|persons?|faces?|portraits?|selfies?)\b/.test(normalized)) {
    return { name: "People", prompt: "a photograph containing one or more people" };
  }
  if (/\b(text|writing|written|words?|ocr)\b/.test(normalized)) {
    return {
      name: "Text",
      prompt: "an image containing prominent visible text, such as a screenshot, document, or sign",
    };
  }
  if (/\b(cartoons?|comics?)\b/.test(normalized)) {
    return { name: "Cartoons or Comics", prompt: "a cartoon, comic, illustration, or drawn panel" };
  }
  if (/\b(memes?|internet images?|viral images?)\b/.test(normalized)) {
    return { name: "Memes or Internet Images", prompt: "a recognizable internet meme or viral image" };
  }
  if (/\b(reactions?|reaction images?|reaction gifs?)\b/.test(normalized)) {
    return {
      name: "Reactions",
      prompt: "a reaction image expressing an emotion or response",
    };
  }

  const name = label
    .replace(/^(?:images?|photos?|pictures?)\s+(?:of|with|containing)\s+/i, "")
    .trim();
  return {
    name: name.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase()),
    prompt: `an image matching the category: ${name}`,
  };
}

function parseVisualRequest(goal) {
  if (typeof goal !== "string") return null;
  const lines = goal.split(/\r?\n/);
  const categoryLines = lines
    .map((line) => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/)?.[1])
    .filter(Boolean);
  if (categoryLines.length < 2) return null;

  const introduction = lines.slice(0, lines.findIndex((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line))).join(" ");
  const describesVisualGrouping =
    /\b(categor(?:y|ies|ize|ization)|priority|visual|content)\b/i.test(introduction) ||
    categoryLines.some((line) => visualConceptsIn(line.toLocaleLowerCase()).length > 0);
  if (!describesVisualGrouping) return null;

  const categories = categoryLines.map(visualCategoryDetails);
  return {
    categories,
    labels: [...categories.map((category) => category.prompt), OTHER_IMAGE_PROMPT],
    otherLabel: OTHER_IMAGE_PROMPT,
  };
}

function selectPriorityCategory(scores, categoryCount) {
  const categoryScores = scores.slice(0, categoryCount);
  const otherScore = scores[categoryCount] ?? 0;
  const bestScore = Math.max(...categoryScores);
  if (bestScore < VISUAL_CONFIDENCE_THRESHOLD || bestScore <= otherScore) return null;

  const priorityCutoff = Math.max(VISUAL_CONFIDENCE_THRESHOLD, bestScore - PRIORITY_SCORE_TOLERANCE);
  const categoryIndex = categoryScores.findIndex(
    (score) => score >= priorityCutoff && score > otherScore,
  );
  return categoryIndex === -1
    ? null
    : {
        categoryIndex,
        confidence: categoryScores[categoryIndex],
      };
}

function createVisualOrganizationPlan(request, analyzedAssets, stats) {
  const items = analyzedAssets
    .map(({ asset, categoryIndex, confidence }) => {
      const category = request.categories[categoryIndex];
      return {
        id: randomUUID(),
        assetId: asset.id,
        name: asset.name,
        sourceRelative: asset.relativePath,
        targetRelative: path.join("Organized", safeSegment(category.name), asset.name),
        reason: `Matched "${category.name}" with ${Math.round(confidence * 100)}% confidence; priority ${categoryIndex + 1}.`,
        confidence,
        category: category.name,
      };
    })
    .filter(
      (item) => path.normalize(item.sourceRelative) !== path.normalize(item.targetRelative),
    );
  const uncertain = stats.total - analyzedAssets.length - stats.failed;
  const categorySummary = request.categories
    .map((category, index) => {
      const count = analyzedAssets.filter((result) => result.categoryIndex === index).length;
      return count > 0 ? `${category.name}: ${count.toLocaleString()}` : null;
    })
    .filter(Boolean)
    .join("; ");

  return {
    id: randomUUID(),
    visual: true,
    interpretation: `images classified locally in priority order: ${request.categories.map((category) => category.name).join(" → ")}`,
    summary: `Prepared ${items.length.toLocaleString()} reviewed move${items.length === 1 ? "" : "s"} from ${stats.total.toLocaleString()} images. ${uncertain.toLocaleString()} uncertain and ${stats.failed.toLocaleString()} unreadable image${stats.failed === 1 ? "" : "s"} will stay in place.${categorySummary ? ` ${categorySummary}.` : ""}`,
    items,
    analysis: {
      total: stats.total,
      classified: analyzedAssets.length,
      uncertain,
      failed: stats.failed,
    },
  };
}

function requestedAssetType(goal) {
  const types = [
    [/\b(images?|photos?|pictures?)\b/, "image"],
    [/\bvideos?|movies?|clips?\b/, "video"],
    [/\b(audio|music|songs?|recordings?)\b/, "audio"],
  ].filter(([pattern]) => pattern.test(goal));
  const explicitlyBroad = /\b(all|everything|media|files?|collection)\b/.test(goal);
  return types.length === 1 && !explicitlyBroad ? types[0][1] : null;
}

function createOrganizationPlan(goal, assets, metadataByPath) {
  if (typeof goal !== "string" || !goal.trim() || goal.length > MAX_GOAL_LENGTH) {
    throw new Error(`Describe an organization goal using 1-${MAX_GOAL_LENGTH} characters.`);
  }

  const normalizedGoal = goal.toLocaleLowerCase();
  const hasByClause = /\bby\b/.test(normalizedGoal);
  const byYear =
    (hasByClause && /\b(?:year|date|month)\b/.test(normalizedGoal)) ||
    /\bchronolog(?:y|ical|ically)?\b|\btimeline\b/.test(normalizedGoal);
  const byType =
    (hasByClause && /\b(?:media\s+)?(?:types?|kinds?)\b/.test(normalizedGoal)) ||
    /\bseparate\s+(?:photos?|images?|videos?|audio)\b/.test(normalizedGoal);
  const byTag =
    (hasByClause && /\btags?\b/.test(normalizedGoal)) || /\btag-based\b/.test(normalizedGoal);
  const byFavorite =
    (hasByClause && /\b(?:favorite|favourite|starred)(?:\s+status)?\b/.test(normalizedGoal)) ||
    /\bseparate\s+(?:favorites|favourites|starred)\b/.test(normalizedGoal);
  const visualConcepts = visualConceptsIn(normalizedGoal);

  if ((parseVisualRequest(goal) || visualConcepts.length > 0) && !byTag) {
    throw new Error(
      `Visual-content analysis is not available yet, so I cannot identify ${visualConcepts.join(", ")}. No plan was created. This planner currently uses file dates, media types, existing local tags, and favorites.`,
    );
  }
  if (!byYear && !byType && !byTag && !byFavorite) {
    throw new Error(
      "I could not map that request to a safe local rule. Ask to organize by year, media type, existing tags, or favorite status.",
    );
  }

  const assetType = requestedAssetType(normalizedGoal);
  const scopedAssets = assetType ? assets.filter((asset) => asset.type === assetType) : assets;
  const scopeLabel = assetType ? { image: "images", video: "videos", audio: "audio files" }[assetType] : "media files";
  if (scopedAssets.length === 0) {
    throw new Error(`There are no ${scopeLabel} in the current library.`);
  }
  if (
    byTag &&
    !scopedAssets.some(
      (asset) => metadataByPath[asset.relativePath.replaceAll("\\", "/")]?.tags?.length > 0,
    )
  ) {
    throw new Error(
      `None of the selected ${scopeLabel} have local tags. Add tags first, then ask to organize by tags.`,
    );
  }

  const dimensions = [
    byYear && "year",
    byType && "media type",
    byTag && "first tag",
    byFavorite && "favorite status",
  ].filter(Boolean);

  const items = [];
  for (const asset of scopedAssets) {
    const metadata = metadataByPath[asset.relativePath.replaceAll("\\", "/")] ?? {
      tags: [],
      favorite: false,
    };
    const destinationSegments = ["Organized"];
    if (byYear) destinationSegments.push(String(new Date(asset.modifiedAt).getFullYear()));
    if (byType) {
      destinationSegments.push({ image: "Photos", video: "Videos", audio: "Audio" }[asset.type]);
    }
    if (byTag) destinationSegments.push(safeSegment(metadata.tags[0] ?? "Untagged"));
    if (byFavorite) destinationSegments.push(metadata.favorite ? "Favorites" : "Other");
    destinationSegments.push(asset.name);

    const targetRelative = path.join(...destinationSegments);
    if (path.normalize(asset.relativePath) === path.normalize(targetRelative)) continue;
    items.push({
      id: randomUUID(),
      assetId: asset.id,
      name: asset.name,
      sourceRelative: asset.relativePath,
      targetRelative,
      reason: `Grouped by ${dimensions.join(", ")}.`,
    });
  }

  return {
    id: randomUUID(),
    interpretation: `${scopeLabel}, grouped by ${dimensions.join(", ")}`,
    summary: `Prepared ${items.length.toLocaleString()} safe move${items.length === 1 ? "" : "s"} for ${scopeLabel}, grouped by ${dimensions.join(", ")}.`,
    items,
  };
}

module.exports = {
  createOrganizationPlan,
  createVisualOrganizationPlan,
  parseVisualRequest,
  safeSegment,
  selectPriorityCategory,
};
