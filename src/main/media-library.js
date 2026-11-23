"use strict";

const crypto = require("node:crypto");
const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_MEDIA_FILES = 100_000;
const SCAN_CONCURRENCY = 16;
const CONVERTED_PREVIEW_EXTENSIONS = new Set([".heic", ".heif", ".tif", ".tiff"]);
const EXTENSIONS = new Map([
  [".jpg", "image"],
  [".jpeg", "image"],
  [".png", "image"],
  [".gif", "image"],
  [".webp", "image"],
  [".bmp", "image"],
  [".tif", "image"],
  [".tiff", "image"],
  [".heic", "image"],
  [".heif", "image"],
  [".avif", "image"],
  [".mp4", "video"],
  [".m4v", "video"],
  [".mov", "video"],
  [".webm", "video"],
  [".avi", "video"],
  [".mkv", "video"],
  [".wmv", "video"],
  [".mp3", "audio"],
  [".m4a", "audio"],
  [".aac", "audio"],
  [".wav", "audio"],
  [".flac", "audio"],
  [".ogg", "audio"],
  [".opus", "audio"],
  [".wma", "audio"],
]);

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assetId(rootPath, relativePath) {
  return crypto
    .createHash("sha256")
    .update(rootPath)
    .update("\0")
    .update(relativePath)
    .digest("hex");
}

async function availableDestination(destinationPath) {
  const parsed = path.parse(destinationPath);
  let candidate = destinationPath;
  for (let suffix = 2; ; suffix += 1) {
    try {
      await fs.lstat(candidate);
      candidate = path.join(parsed.dir, `${parsed.name} (${suffix})${parsed.ext}`);
    } catch (error) {
      if (error.code === "ENOENT") return candidate;
      throw error;
    }
  }
}

async function ensureRecycleDirectory(rootPath, directory) {
  let current = rootPath;
  for (const component of path.relative(rootPath, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory() ||
      !isWithin(rootPath, await fs.realpath(current))) {
      throw new Error("The recycling destination contains a linked or invalid folder.");
    }
  }
}

async function recycleFile(sourcePath, destination) {
  for (;;) {
    const finalDestination = await availableDestination(destination);
    let created = false;
    try {
      try {
        await fs.link(sourcePath, finalDestination);
        created = true;
      } catch (error) {
        if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) throw error;
        const stats = await fs.stat(sourcePath);
        await fs.copyFile(sourcePath, finalDestination, constants.COPYFILE_EXCL);
        created = true;
        await fs.utimes(finalDestination, stats.atime, stats.mtime);
      }
      await fs.unlink(sourcePath);
      return finalDestination;
    } catch (error) {
      if (created) {
        try {
          await fs.unlink(finalDestination);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError],
            "The recycling destination and its source could not be reconciled safely.");
        }
      }
      if (error.code !== "EEXIST") throw error;
    }
  }
}

class MediaLibrary {
  constructor() {
    this.rootPath = null;
    this.assets = new Map();
  }

  async scan(requestedRoot, onProgress = () => {}) {
    const startedAt = Date.now();
    let current = 0;
    let discovered = 0;
    let lastProgressAt = 0;
    function report(directory, force = false) {
      const now = Date.now();
      if (!force && now - lastProgressAt < 100) return;
      lastProgressAt = now;
      onProgress({ phase: "scanning", current, discovered, directory, elapsedMs: now - startedAt });
    }
    report(requestedRoot, true);
    const rootPath = await fs.realpath(requestedRoot);
    const rootStats = await fs.stat(rootPath);
    if (!rootStats.isDirectory()) throw new Error("The selected media location is not a folder.");

    const assets = [];
    const pendingDirectories = [rootPath];

    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop();
      report(directory);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const mediaEntries = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;

        const extension = path.extname(entry.name).toLocaleLowerCase();
        const type = EXTENSIONS.get(extension);
        if (!type) continue;
        if (assets.length + mediaEntries.length >= MAX_MEDIA_FILES) {
          throw new Error(`This prototype supports up to ${MAX_MEDIA_FILES.toLocaleString()} media files per library.`);
        }
        mediaEntries.push({ entry, absolutePath, extension, type });
      }
      discovered += mediaEntries.length;
      report(directory);
      const directoryAssets = new Array(mediaEntries.length);
      let next = 0;
      let scanError;
      const jobs = Array.from({ length: Math.min(SCAN_CONCURRENCY, mediaEntries.length) }, async () => {
        while (next < mediaEntries.length && !scanError) {
          const index = next++;
          const { entry, absolutePath, extension, type } = mediaEntries[index];
          try {
            const stats = await fs.stat(absolutePath);
            const relativePath = path.relative(rootPath, absolutePath);
            const id = assetId(rootPath, relativePath);
            directoryAssets[index] = {
              id,
              name: entry.name,
              relativePath,
              extension,
              type,
              size: stats.size,
              modifiedAt: stats.mtime.toISOString(),
              createdAt: stats.birthtime.toISOString(),
              mediaUrl: `local-media://asset/${id}`,
              thumbnailUrl: type === "image" ? `local-thumb://asset/${id}` : null,
              previewUrl:
                type === "image" && CONVERTED_PREVIEW_EXTENSIONS.has(extension)
                  ? `local-thumb://asset/${id}`
                  : `local-media://asset/${id}`,
              absolutePath,
            };
            current += 1;
            report(directory);
          } catch (error) {
            scanError ??= error;
          }
        }
      });
      await Promise.all(jobs);
      if (scanError) throw scanError;
      for (const asset of directoryAssets) assets.push(asset);
    }

    report(rootPath, true);
    assets.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    this.rootPath = rootPath;
    this.assets = new Map(assets.map((asset) => [asset.id, asset]));
    return this.publicSnapshot();
  }

  publicSnapshot() {
    return {
      rootPath: this.rootPath,
      assets: [...this.assets.values()].map(({ absolutePath: _absolutePath, ...asset }) => asset),
    };
  }

  getAsset(id) {
    if (typeof id !== "string") return null;
    return this.assets.get(id) ?? null;
  }

  resolveAsset(id) {
    return this.getAsset(id)?.absolutePath ?? null;
  }

  assetsByType(type) {
    return [...this.assets.values()].filter((asset) => asset.type === type);
  }

  async moveAsset(id, expectedSourceRelative, targetRelative) {
    const asset = this.getAsset(id);
    if (!asset || !this.rootPath) throw new Error("The media item is no longer available.");
    if (asset.relativePath !== expectedSourceRelative) {
      throw new Error("The library changed after this plan was created. Create a fresh plan.");
    }
    if (typeof targetRelative !== "string" || path.isAbsolute(targetRelative)) {
      throw new Error("The organizer produced an invalid destination.");
    }

    const destination = path.resolve(this.rootPath, targetRelative);
    if (!isWithin(this.rootPath, destination) || destination === this.rootPath) {
      throw new Error("The organizer destination is outside the media library.");
    }

    const finalDestination = await availableDestination(destination);
    await fs.mkdir(path.dirname(finalDestination), { recursive: true });
    await fs.rename(asset.absolutePath, finalDestination);
    return path.relative(this.rootPath, finalDestination);
  }

  async deleteAsset(id, recycleBinRoot) {
    const asset = this.getAsset(id);
    if (!asset || !this.rootPath) throw new Error("The media item is no longer available.");

    if (!recycleBinRoot) {
      await fs.unlink(asset.absolutePath);
      this.assets.delete(id);
      return { mode: "permanent", recycledRelativePath: null };
    }

    const resolvedRecycleBin = await fs.realpath(recycleBinRoot);
    if (isWithin(this.rootPath, resolvedRecycleBin) || isWithin(resolvedRecycleBin, this.rootPath)) {
      throw new Error("The recycling bin must be separate from the media library.");
    }
    const destination = path.resolve(resolvedRecycleBin, asset.relativePath);
    if (!isWithin(resolvedRecycleBin, destination) || destination === resolvedRecycleBin) {
      throw new Error("The recycling destination is invalid.");
    }

    await ensureRecycleDirectory(resolvedRecycleBin, path.dirname(destination));
    const finalDestination = await recycleFile(asset.absolutePath, destination);

    this.assets.delete(id);
    return {
      mode: "recycled",
      recycledRelativePath: path.relative(resolvedRecycleBin, finalDestination),
    };
  }
}

module.exports = { MediaLibrary, isWithin };
