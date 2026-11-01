"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_GOAL_LENGTH = 400;
const VISUAL_CONFIDENCE_THRESHOLD = 0.3;
const PRIORITY_SCORE_TOLERANCE = 0.04;
const OTHER_IMAGE_PROMPT = "another kind of image that does not match the requested categories";
const VISUAL_CONCEPTS = [
  { pattern: /\b(people|persons?|faces?|portraits?|selfies?)\b/i, label: "people" },
  { pattern: /\b(text|writing|written|words?|ocr)\b/i, label: "visible text" },
  { pattern: /\b(cartoons?|comics?)\b/i, label: "cartoons or comics" },
  {
    pattern: /\b(memes?|well[- ]recognized internet images?|viral images?)\b/i,
    label: "memes or internet images",
  },
  { pattern: /\b(reactions?|reaction images?|reaction gifs?)\b/i, label: "reactions" },
];

function safeSegment(value) {
  const segment = String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  return segment.slice(0, 60) || "Untagged";
}

function visualConceptsIn(goal) {
  return VISUAL_CONCEPTS.filter(({ pattern }) => pattern.test(goal)).map(({ label }) => label);
}

function cleanVisualSource(value) {
  return value
    .replace(/^(?:let'?s\s+)?(?:move|organize|sort|put)\s+/i, "")
    .replace(/^(?:all|the\s+remaining)\s+/i, "")
    .trim();
}

function visualPromptForSource(source) {
  const cleaned = cleanVisualSource(source);
  const normalized = cleaned.toLocaleLowerCase();
  const ofMatch = cleaned.match(/^(?:images?|photos?|pictures?)\s+of\s+(.+)$/i);
  if (ofMatch) return `a photograph of ${ofMatch[1]}`;
  const adjectivePhotoMatch = cleaned.match(/^(.+?)\s+(?:images?|photos?|pictures?)$/i);
  if (adjectivePhotoMatch) return `a photograph of ${adjectivePhotoMatch[1]}`;
  const withMatch = cleaned.match(/^(?:images?|photos?|pictures?)\s+with\s+(.+)$/i);
  if (withMatch) return `an image containing ${withMatch[1]}`;
  if (/\bscreenshots?\b/.test(normalized)) return `a ${cleaned.replace(/^.*?\bscreenshots?\b/i, "screenshot")}`;
  return `an image matching the visual description: ${cleaned}`;
}

function visualCategoryDetails(label, destinationName = null) {
  const query = cleanVisualSource(label);
  const normalized = label.toLocaleLowerCase();
  let details;
  if (/\b(people|persons?|faces?|portraits?|selfies?)\b/.test(normalized)) {
    details = { name: "People", prompt: "a photograph containing one or more people" };
  } else if (/\b(text|writing|written|words?|ocr)\b/.test(normalized)) {
    details = {
      name: "Text",
      prompt: "an image containing prominent visible text, such as a screenshot, document, or sign",
    };
  } else if (/\b(cartoons?|comics?)\b/.test(normalized)) {
    details = {
      name: "Cartoons or Comics",
      prompt: "a cartoon, comic, illustration, or drawn panel",
    };
  } else if (/\b(memes?|internet images?|viral images?)\b/.test(normalized)) {
    details = {
      name: "Memes or Internet Images",
      prompt: "a recognizable internet meme or viral image",
    };
  } else if (/\b(reactions?|reaction images?|reaction gifs?)\b/.test(normalized)) {
    details = {
      name: "Reactions",
      prompt: "a reaction image expressing an emotion or response",
    };
  } else {
    const name = query
      .replace(/^(?:images?|photos?|pictures?)\s+(?:of|with|containing)\s+/i, "")
      .trim();
    details = {
      name: name.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase()),
      prompt: visualPromptForSource(query),
    };
  }

  return {
    ...details,
    name: destinationName?.trim() || details.name,
    query,
    explicitDestination: Boolean(destinationName),
  };
}

function parseVisualMapping(value) {
  const match = value
    .trim()
    .match(/^(.*?)\s+(?:to|into)\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/i);
  if (!match) return null;
  const source = cleanVisualSource(match[1]);
  const destination = (match[2] || match[3] || match[4] || "").trim();
  const looksVisual =
    /\b(images?|photos?|pictures?|screenshots?|people|persons?|faces?|portraits?|selfies?|text|writing|words?|cartoons?|comics?|memes?|reactions?|bab(?:y|ies)|food)\b/i.test(
      source,
    );
  if (!looksVisual || !destination) return null;
  return visualCategoryDetails(source, destination);
}

function createVisualRequestFromMappings(mappings) {
  const categories = mappings.map(
    ({ visualQuery, destinationFolder, explicitDestination = true }) =>
      visualCategoryDetails(
        visualQuery,
        explicitDestination ? destinationFolder : null,
      ),
  );
  const uniqueCategories = [];
  const seen = new Set();
  for (const category of categories) {
    const key = `${category.name}\0${category.prompt}`.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCategories.push(category);
    }
  }
  return {
    categories: uniqueCategories,
    labels: [...uniqueCategories.map((category) => category.prompt), OTHER_IMAGE_PROMPT],
    otherLabel: OTHER_IMAGE_PROMPT,
  };
}

function parseVisualRequest(goal) {
  if (typeof goal !== "string") return null;
  if (/\b(tags?|tagged)\b/i.test(goal)) return null;
  const lines = goal.split(/\r?\n/);
  const categoryLines = lines
    .map((line) => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/)?.[1])
    .filter(Boolean);
  const firstCategoryLine = lines.findIndex((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));
  const introduction = firstCategoryLine === -1 ? goal : lines.slice(0, firstCategoryLine).join(" ");
  const describesVisualGrouping =
    /\b(categor(?:y|ies|ize|ization)|priority|visual|content|images?|photos?|pictures?)\b/i.test(
      introduction,
    ) || categoryLines.some((line) => visualConceptsIn(line).length > 0);

  let categories = [];
  const mappedCategories = categoryLines.map(parseVisualMapping);
  if (mappedCategories.some(Boolean)) {
    categories = categoryLines.map(
      (line, index) => mappedCategories[index] || visualCategoryDetails(line),
    );
  } else if (categoryLines.length > 0 && describesVisualGrouping) {
    categories = categoryLines.map((line) => visualCategoryDetails(line));
  } else {
    const wholeCommand = parseVisualMapping(goal.replace(/\s+/g, " "));
    if (wholeCommand) {
      categories = [wholeCommand];
    } else {
      categories = VISUAL_CONCEPTS.map(({ pattern }) => {
        const match = pattern.exec(goal);
        return match ? { index: match.index, label: match[0] } : null;
      })
        .filter(Boolean)
        .sort((left, right) => left.index - right.index)
        .map(({ label }) => visualCategoryDetails(label));
    }
  }
  if (categories.length === 0) return null;

  return createVisualRequestFromMappings(
    categories.map((category) => ({
      visualQuery: category.query,
      destinationFolder: category.name,
      explicitDestination: category.explicitDestination,
    })),
  );
}

function looksLikeVisualRequest(goal) {
  if (typeof goal !== "string" || !goal.trim()) return false;
  const normalized = goal.toLocaleLowerCase();
  if (
    /\bby\s+(?:year|date|month|media\s+type|type|tags?|favorite|favourite|starred)\b/.test(
      normalized,
    ) ||
    /\b(?:from|to)\s+(?:a\s+)?(?:folder|directory)\b/.test(normalized)
  ) {
    return false;
  }
  if (parseVisualRequest(goal)) return true;
  return (
    /\b(images?|photos?|photographs?|pictures?|screenshots?|artwork|graphics?)\b/.test(
      normalized,
    ) &&
    /\b(identify|find|discover|detect|classify|categorize|categorise|move|organize|organise|sort|group|containing|showing|depicting|of|with)\b/.test(
      normalized,
    )
  );
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
      const destinationFolder = category.explicitDestination
        ? safeSegment(category.name)
        : path.join("Organized", safeSegment(category.name));
      return {
        id: randomUUID(),
        assetId: asset.id,
        name: asset.name,
        sourceRelative: asset.relativePath,
        targetRelative: path.join(destinationFolder, asset.name),
        reason: `Matched "${category.query}" for destination "${category.name}" with ${Math.round(confidence * 100)}% confidence; priority ${categoryIndex + 1}.`,
        confidence,
        category: category.name,
        registerCategory: category.explicitDestination,
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
    interpretation: `images classified by ${stats.modelName || "the selected vision model"} in priority order: ${request.categories.map((category) => (category.query.toLocaleLowerCase() === category.name.toLocaleLowerCase() ? category.name : `${category.query} → ${category.name}`)).join("; then ")}`,
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
      `I found a visual request for ${visualConcepts.join(", ")}, but could not extract usable categories. Use a category name in prose or list categories with bullets.`,
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
  createVisualRequestFromMappings,
  createVisualOrganizationPlan,
  looksLikeVisualRequest,
  parseVisualRequest,
  safeSegment,
  selectPriorityCategory,
};
