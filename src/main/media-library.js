"use strict";

const crypto = require("node:crypto");
const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_MEDIA_FILES = 100_000;
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
      await fs.access(candidate);
      candidate = path.join(parsed.dir, `${parsed.name} (${suffix})${parsed.ext}`);
    } catch (error) {
      if (error.code === "ENOENT") return candidate;
      throw error;
    }
  }
}

class MediaLibrary {
  constructor() {
    this.rootPath = null;
    this.assets = new Map();
  }

  async scan(requestedRoot) {
    const rootPath = await fs.realpath(requestedRoot);
    const rootStats = await fs.stat(rootPath);
    if (!rootStats.isDirectory()) throw new Error("The selected media location is not a folder.");

    const assets = [];
    const pendingDirectories = [rootPath];

    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop();
      const entries = await fs.readdir(directory, { withFileTypes: true });
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
        if (assets.length >= MAX_MEDIA_FILES) {
          throw new Error(`This prototype supports up to ${MAX_MEDIA_FILES.toLocaleString()} media files per library.`);
        }

        const stats = await fs.stat(absolutePath);
        const relativePath = path.relative(rootPath, absolutePath);
        const id = assetId(rootPath, relativePath);
        assets.push({
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
          absolutePath,
        });
      }
    }

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

    const finalDestination = await availableDestination(destination);
    await fs.mkdir(path.dirname(finalDestination), { recursive: true });
    try {
      await fs.rename(asset.absolutePath, finalDestination);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      const sourceStats = await fs.stat(asset.absolutePath);
      await fs.copyFile(asset.absolutePath, finalDestination, constants.COPYFILE_EXCL);
      await fs.utimes(finalDestination, sourceStats.atime, sourceStats.mtime);
      try {
        await fs.unlink(asset.absolutePath);
      } catch (unlinkError) {
        try {
          await fs.unlink(finalDestination);
        } catch (cleanupError) {
          throw new AggregateError(
            [unlinkError, cleanupError],
            "The copied file and its source could not be reconciled safely.",
          );
        }
        throw unlinkError;
      }
    }

    this.assets.delete(id);
    return {
      mode: "recycled",
      recycledRelativePath: path.relative(resolvedRecycleBin, finalDestination),
    };
  }
}

module.exports = { MediaLibrary, isWithin };
