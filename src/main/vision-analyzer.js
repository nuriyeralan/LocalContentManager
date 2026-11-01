"use strict";

const path = require("node:path");
const { CopilotClient, RuntimeConnection } = require("@github/copilot-sdk");
const { createVisualRequestFromMappings } = require("./organizer");

const PREFERRED_MODEL_IDS = ["gpt-5.6-sol-fast", "gpt-5.6-sol"];

function resolveRuntimeBinary() {
  const packageName = `@github/copilot-sdk-${process.platform}-${process.arch}`;
  const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
  const executable = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
  return path.join(
    packageRoot,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    executable,
  );
}

function extractJson(content) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The selected model did not return JSON.");
  return JSON.parse(content.slice(start, end + 1));
}

function parseVisualMappingsJson(content) {
  const parsed = extractJson(content);
  if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
    throw new Error("The selected model did not return visual categories.");
  }
  const mappings = parsed.categories.slice(0, 20).map((category) => {
    const visualQuery =
      typeof category.visualQuery === "string" ? category.visualQuery.trim() : "";
    const destinationFolder =
      typeof category.destinationFolder === "string"
        ? category.destinationFolder.trim()
        : "";
    if (
      !visualQuery ||
      !destinationFolder ||
      visualQuery.length > 200 ||
      destinationFolder.length > 100
    ) {
      throw new Error("The selected model returned an invalid visual category.");
    }
    return { visualQuery, destinationFolder };
  });
  return mappings;
}

function parseCategoryRecommendationJson(content, categories) {
  const parsed = extractJson(content);
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  if (parsed.categoryName === null) {
    return {
      categoryName: null,
      confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    };
  }
  const category = categories.find(
    (entry) =>
      entry.name.toLocaleLowerCase() ===
      String(parsed.categoryName ?? "").trim().toLocaleLowerCase(),
  );
  if (!category) throw new Error("The selected model recommended an unknown category.");
  return {
    categoryName: category.name,
    confidence,
    reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
  };
}

function parseCategoryDescriptionJson(content) {
  const parsed = extractJson(content);
  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!description || description.length > 500) {
    throw new Error("The selected model returned an invalid category description.");
  }
  return description;
}

function choosePreferredModel(models, configuredModel) {
  const configured = models.find((model) => model.id === configuredModel);
  if (configured) return configured;
  for (const id of PREFERRED_MODEL_IDS) {
    const preferred = models.find(
      (model) =>
        model.id.toLocaleLowerCase() === id ||
        model.name.toLocaleLowerCase().includes(id.replaceAll("-", " ")),
    );
    if (preferred) return preferred;
  }
  const namedFastSol = models.find((model) => {
    const identity = `${model.id} ${model.name}`.toLocaleLowerCase();
    return identity.includes("sol") && identity.includes("fast");
  });
  return namedFastSol || models[0] || null;
}

function classificationReasoningEffort(model) {
  const efforts = model.supportedReasoningEfforts ?? [];
  if (efforts.includes("none")) return "none";
  if (efforts.includes("low")) return "low";
  return null;
}

function normalizeConcurrency(value, taskCount) {
  const configured = [1, 2, 4, 8].includes(value) ? value : 4;
  return Math.max(1, Math.min(configured, Math.max(1, taskCount)));
}

class VisionAnalyzer {
  constructor(workingDirectory, logger) {
    this.workingDirectory = workingDirectory;
    this.logger = logger;
    this.client = null;
    this.startPromise = null;
    this.activeSessions = new Set();
    this.cancelVersion = 0;
    this.maxConcurrency = 4;
    this.activeSlots = 0;
    this.slotWaiters = [];
  }

  setMaxConcurrency(value) {
    this.maxConcurrency = [1, 2, 4, 8].includes(value) ? value : 4;
    this.#drainSlotWaiters();
  }

  async listModels() {
    const client = await this.#ensureClient();
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) {
      return {
        auth,
        models: [],
        selected: null,
      };
    }
    const models = (await client.listModels())
      .filter((model) => model.capabilities?.supports?.vision)
      .map((model) => ({
        id: model.id,
        name: model.name,
        maxImages: model.capabilities.limits?.vision?.max_prompt_images ?? 1,
        maxImageSize: model.capabilities.limits?.vision?.max_prompt_image_size ?? null,
        mediaTypes: model.capabilities.limits?.vision?.supported_media_types ?? [],
        supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
      }));
    return { auth, models };
  }

  async resolveModel(configuredModel) {
    const { auth, models } = await this.listModels();
    if (!auth.isAuthenticated) {
      throw new Error(auth.statusMessage || "Sign in to GitHub Copilot before using visual analysis.");
    }
    if (models.length === 0) {
      throw new Error("No vision-capable models are available to this Copilot account.");
    }
    return choosePreferredModel(models, configuredModel);
  }

  async classify(images, request, model, onRetry) {
    if (images.length === 0) return [];
    const cancellationVersion = this.cancelVersion;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#classifyOnce(images, request, model);
      } catch (error) {
        if (this.cancelVersion !== cancellationVersion) throw error;
        lastError = error;
        if (attempt === 3) break;
        onRetry?.(attempt + 1, error);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError;
  }

  async interpretRequest(goal, model, onRetry) {
    const cancellationVersion = this.cancelVersion;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#interpretRequestOnce(goal, model);
      } catch (error) {
        if (this.cancelVersion !== cancellationVersion) throw error;
        lastError = error;
        if (attempt === 3) break;
        onRetry?.(attempt + 1, error);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError;
  }

  async recommendCategory(image, categories, model, onRetry) {
    const cancellationVersion = this.cancelVersion;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#recommendCategoryOnce(image, categories, model);
      } catch (error) {
        if (this.cancelVersion !== cancellationVersion) throw error;
        lastError = error;
        if (attempt === 3) break;
        onRetry?.(attempt + 1, error);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError;
  }

  async draftCategoryDescription(image, categoryName, model, onRetry) {
    const cancellationVersion = this.cancelVersion;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#draftCategoryDescriptionOnce(
          image,
          categoryName,
          model,
        );
      } catch (error) {
        if (this.cancelVersion !== cancellationVersion) throw error;
        lastError = error;
        if (attempt === 3) break;
        onRetry?.(attempt + 1, error);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError;
  }

  async #draftCategoryDescriptionOnce(image, categoryName, model) {
    const client = await this.#ensureClient();
    await this.#acquireSlot();
    const prompt = [
      `Draft a concise category description for the category ${JSON.stringify(categoryName)} using the attached image as one example.`,
      "Describe general visual inclusion criteria, not this specific filename or path.",
      "Use one or two short sentences, at most 500 characters.",
      "Do not identify people or transcribe/repeat sensitive image text.",
      'Return only JSON: {"description":"..."}',
    ].join("\n");
    let session;
    try {
      session = await client.createSession(
        this.#sessionConfig(
          model,
          "You draft concise, reusable descriptions for user-defined image categories. Follow the JSON schema exactly and never use tools.",
        ),
      );
      this.activeSessions.add(session);
      const response = await session.sendAndWait(
        {
          prompt,
          attachments: [
            {
              type: "blob",
              data: image.base64,
              mimeType: "image/jpeg",
              displayName: "image-1.jpg",
            },
          ],
        },
        180000,
      );
      if (!response?.data?.content) {
        throw new Error("The selected model returned no category description.");
      }
      return parseCategoryDescriptionJson(response.data.content);
    } finally {
      if (session) this.activeSessions.delete(session);
      if (session) {
        const sessionId = session.sessionId;
        await session.disconnect();
        try {
          await client.deleteSession(sessionId);
        } catch (error) {
          this.logger.error("[copilot] Could not delete transient drafting session", error);
        }
      }
      this.#releaseSlot();
    }
  }

  async #recommendCategoryOnce(image, categories, model) {
    const client = await this.#ensureClient();
    await this.#acquireSlot();
    const prompt = [
      "Recommend the single best available category for the attached image.",
      "Use the category descriptions as the user's intended meaning.",
      "Return null when none fit clearly. Do not invent a category.",
      `Available categories: ${JSON.stringify(categories)}`,
      'Return only JSON: {"categoryName":"exact available name"|null,"confidence":0.0,"reason":"brief visual reason without transcribing image text"}',
    ].join("\n");
    let session;
    try {
      session = await client.createSession(
        this.#sessionConfig(
          model,
          "You recommend one user-defined category for an image. Follow the JSON schema exactly, never use tools, and never identify people.",
        ),
      );
      this.activeSessions.add(session);
      const response = await session.sendAndWait(
        {
          prompt,
          attachments: [
            {
              type: "blob",
              data: image.base64,
              mimeType: "image/jpeg",
              displayName: "image-1.jpg",
            },
          ],
        },
        180000,
      );
      if (!response?.data?.content) {
        throw new Error("The selected model returned no category recommendation.");
      }
      return parseCategoryRecommendationJson(response.data.content, categories);
    } finally {
      if (session) this.activeSessions.delete(session);
      if (session) {
        const sessionId = session.sessionId;
        await session.disconnect();
        try {
          await client.deleteSession(sessionId);
        } catch (error) {
          this.logger.error("[copilot] Could not delete transient recommendation session", error);
        }
      }
      this.#releaseSlot();
    }
  }

  async #interpretRequestOnce(goal, model) {
    const client = await this.#ensureClient();
    await this.#acquireSlot();
    const prompt = [
      "Interpret this media-organization command as visual image classification categories.",
      "Return categories in priority order.",
      "visualQuery must describe what should visibly appear in matching images.",
      "destinationFolder must be the requested folder, or a concise inferred folder when none is explicit.",
      "Do not interpret dates, file types, tags, favorites, source folders, or paths as visual categories.",
      'Return only JSON: {"categories":[{"visualQuery":"...","destinationFolder":"..."}]}',
      `User command: ${JSON.stringify(goal)}`,
    ].join("\n");
    let session;
    try {
      session = await client.createSession(
        this.#sessionConfig(
          model,
          "You convert natural-language image organization commands into a strict JSON classification plan. Never use tools.",
        ),
      );
      this.activeSessions.add(session);
      const response = await session.sendAndWait({ prompt }, 60000);
      if (!response?.data?.content) {
        throw new Error("The selected model returned no command interpretation.");
      }
      return createVisualRequestFromMappings(
        parseVisualMappingsJson(response.data.content),
      );
    } finally {
      if (session) this.activeSessions.delete(session);
      if (session) {
        const sessionId = session.sessionId;
        await session.disconnect();
        try {
          await client.deleteSession(sessionId);
        } catch (error) {
          this.logger.error("[copilot] Could not delete transient interpretation session", error);
        }
      }
      this.#releaseSlot();
    }
  }

  async #classifyOnce(images, request, model) {
    const client = await this.#ensureClient();
    await this.#acquireSlot();
    const categories = request.categories.map((category, index) => ({
      index,
      visualQuery: category.query,
      destinationFolder: category.name,
      priority: index + 1,
    }));
    const prompt = [
      `Classify each of the ${images.length} attached images using the ordered categories below.`,
      "For each image, choose the first category in priority order that clearly applies.",
      "Use null when no category applies. Return confidence from 0 to 1.",
      "Do not identify people. Do not transcribe or repeat sensitive text.",
      `Categories: ${JSON.stringify(categories)}`,
      'Return only JSON: {"items":[{"imageIndex":0,"categoryIndex":0|null,"confidence":0.0,"reason":"brief visual reason"}]}',
      "Include exactly one item for every attached image index.",
    ].join("\n");
    const attachments = images.map((image, index) => ({
      type: "blob",
      data: image.base64,
      mimeType: "image/jpeg",
      displayName: `image-${index + 1}.jpg`,
    }));

    let session;
    try {
      session = await client.createSession(
        this.#sessionConfig(
          model,
          "You are a private image-classification component. Follow the requested schema exactly. Never use tools, retain context, identify people, or reveal image text.",
        ),
      );
      this.activeSessions.add(session);
      const response = await session.sendAndWait({ prompt, attachments }, 180000);
      if (!response?.data?.content) throw new Error("The selected model returned no classification.");
      const parsed = extractJson(response.data.content);
      if (!Array.isArray(parsed.items)) {
        throw new Error("The selected model returned an invalid classification shape.");
      }

      const byIndex = new Map(parsed.items.map((item) => [item.imageIndex, item]));
      return images.map((_image, imageIndex) => {
        const item = byIndex.get(imageIndex);
        const categoryIndex = Number.isInteger(item?.categoryIndex)
          ? item.categoryIndex
          : null;
        const confidence = Math.max(0, Math.min(1, Number(item?.confidence) || 0));
        const scores = Array(request.categories.length + 1).fill(0);
        if (
          categoryIndex !== null &&
          categoryIndex >= 0 &&
          categoryIndex < request.categories.length
        ) {
          scores[categoryIndex] = confidence;
          scores[scores.length - 1] = 1 - confidence;
        } else {
          scores[scores.length - 1] = 1;
        }
        return scores;
      });
    } finally {
      if (session) this.activeSessions.delete(session);
      if (session) {
        const sessionId = session.sessionId;
        await session.disconnect();
        try {
          await client.deleteSession(sessionId);
        } catch (error) {
          this.logger.error("[copilot] Could not delete transient classification session", error);
        }
      }
      this.#releaseSlot();
    }
  }

  async cancel() {
    this.cancelVersion += 1;
    const cancellationError = new Error("Copilot analysis was cancelled.");
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(cancellationError);
    await Promise.allSettled([...this.activeSessions].map((session) => session.abort()));
  }

  async dispose() {
    await this.cancel();
    if (this.client) {
      const client = this.client;
      this.client = null;
      this.startPromise = null;
      await client.stop();
    }
  }

  #acquireSlot() {
    if (this.activeSlots < this.maxConcurrency) {
      this.activeSlots += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.slotWaiters.push({ resolve, reject }));
  }

  #releaseSlot() {
    this.activeSlots = Math.max(0, this.activeSlots - 1);
    this.#drainSlotWaiters();
  }

  #drainSlotWaiters() {
    while (this.activeSlots < this.maxConcurrency && this.slotWaiters.length > 0) {
      this.activeSlots += 1;
      this.slotWaiters.shift().resolve();
    }
  }

  #sessionConfig(model, systemContent) {
    const config = {
      clientName: "Local Content Manager",
      model: model.id,
      contextTier: "default",
      workingDirectory: this.workingDirectory,
      enableSessionStore: false,
      availableTools: [],
      systemMessage: {
        mode: "append",
        content: systemContent,
      },
    };
    const reasoningEffort = classificationReasoningEffort(model);
    if (reasoningEffort) {
      config.reasoningEffort = reasoningEffort;
      config.reasoningSummary = "none";
    }
    return config;
  }

  #ensureClient() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const client = new CopilotClient({
        useLoggedInUser: true,
        mode: "copilot-cli",
        logLevel: "error",
        workingDirectory: this.workingDirectory,
        connection: RuntimeConnection.forStdio({ path: resolveRuntimeBinary() }),
        clientName: "Local Content Manager",
      });
      await client.start();
      this.client = client;
      return client;
    })().catch((error) => {
      this.client = null;
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }
}

module.exports = {
  choosePreferredModel,
  classificationReasoningEffort,
  extractJson,
  normalizeConcurrency,
  parseCategoryDescriptionJson,
  parseCategoryRecommendationJson,
  parseVisualMappingsJson,
  PREFERRED_MODEL_IDS,
  resolveRuntimeBinary,
  VisionAnalyzer,
};
