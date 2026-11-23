# Local Content Manager

A privacy-first Electron prototype for browsing, tagging, and safely organizing a local media library.

Browse media, manage local tags and favorites, move images into categories, and review duplicates before recycling. Visual category recommendations use a user-selectable vision-capable model from the signed-in GitHub Copilot model catalog. Video and audio content analysis are not yet supported. The **Organize with agent** launch button has been removed; **Vision settings** in the image preview retains access to model and session settings.

Visual requests send resized JPEG copies with metadata removed. Filenames and folder paths are never attached. Results are cached by file fingerprint, selected model, and requested categories. Low-confidence and unreadable images stay in place.

Classification sessions use the model's lowest supported reasoning effort (`none` for GPT-5.6 Sol Fast), the SDK's default context tier rather than long context, and a user-configurable maximum of 1, 2, 4, or 8 parallel transient sessions. Recommendations appear on thumbnails and in the image preview when ready.

## Privacy and safety

- Original media and local metadata stay on the local machine.
- The app contains no analytics. Visual prompts send resized, metadata-free image copies to GitHub Copilot for classification.
- The selected model follows the models available to the signed-in Copilot account and organization policy.
- The renderer is sandboxed and receives no filesystem access.
- Media is exposed through a narrow read-only custom protocol.
- Organization plans are previews until explicitly applied.
- Moves never overwrite existing files.
- Media can be moved to a remembered recycling folder with its relative path preserved.
- When no recycling folder is configured, deletion requires confirmation and permanently removes the file.
- Media and recycling folder choices persist between launches.
- Folder settings preserve the exact user-selected path and can change only through the OS folder picker or a main-process confirmation dialog. Changes are recorded locally in `settings-audit.jsonl`.
- Symbolic links are not followed while scanning.
- Metadata is saved atomically under Electron's per-user application data directory.
- Bounded main-process diagnostics are written locally under the application data `logs` folder; closed launcher pipes are ignored.

The application pins the GitHub Copilot SDK and its audited transitive dependencies. Its Electron 45.1.0 Windows runtime is downloaded from the official Electron GitHub release by `scripts/install-electron.ps1`, checked against a pinned official SHA-256 digest, and stored in the ignored `.runtime` directory. Electron 45 is one of the three stable major lines currently supported by Electron.

HEIC/HEIF spectral decoding uses a local WIC-backed Windows helper, built from `native/WindowsImageDecoder.cs` with the .NET Framework compiler included with supported Windows versions. It uses full decoded frames, not Shell thumbnails or embedded previews. Windows' HEIF/HEVC codec components are serviced separately by Windows/Microsoft Store; no third-party HEVC library is bundled with this helper.

Run `npm audit` before each release and update both the runtime version and pinned digest when Electron publishes a security update. A clean audit and current supported runtime reduce known risk but cannot guarantee that no undisclosed vulnerability exists. Decoder process isolation protects the app from native crashes; it is not an OS security sandbox.

## Run

```powershell
npm install
npm test
npm run check
npm start
```

`npm install`, `npm start`, and installer builds compile the Windows helper into `.runtime/wic/WindowsImageDecoder.exe`. After changing its C# source, run `npm run build:decoder` before testing. No .NET SDK, Visual Studio, separate Node.js installation, or elevated installation is required on end-user machines.

Choose a media folder, add tags or favorites, move images into categories, and review duplicates.

## Large and network libraries

Library scans request size and timestamp metadata for up to **16 media files at once**, instead of waiting for each file sequentially. Image contents are not read during this scan. The loading panel shows the current directory, discovered/checked counts, and elapsed time; progress remains indeterminate until recursive discovery finishes. The complete snapshot is displayed after category definitions have been loaded, preserving consistent sorting and category views. Scan failures remain visible and are logged locally.

This reduces serialized SMB metadata latency but does not remove network/server delays. Browsing still uses a virtualized grid and lazy thumbnails rather than loading every image at once.

## Guided image deduplication

Choose **Deduplicate** to scan all images in the selected library, including category folders.
Browsing filters do not limit this scan. Both methods run locally in a bounded worker pool, with
phase/count progress, elapsed time, and scan cancellation; no images are uploaded and scanning
does not move any files.

Choose **Maximum parallel files**: **1, 2, 4, 8, or 16**, defaulting to **16**. Each worker processes one file at a time; SHA-256 reads and spectral image decoding/fingerprint computation run across files in parallel. Exact scans use lightweight threads; spectral scans use isolated decoder processes so a native decoder crash cannot terminate the desktop app. Each active HEIC/HEIF file runs in a separate short-lived Windows helper, bounded by the selected file limit. Similar-image scans also compute SHA-256, so exact matches are included without a separate scan. Group comparison remains deterministic in the coordinating worker, and cancelling terminates the scan and its workers/processes without moving files. No hashes or spectral analysis are computed automatically when opening a library. Higher parallelism uses more CPU, memory, and network I/O; choose a lower limit for large images or an overloaded share. This setting is independent of the Copilot session limit.

If a decoder process crashes while reading a file, that file is explicitly reported as skipped and left untouched; remaining files continue without retrying the crashing image. The result includes a native-decoder failure count, details include the affected path and exit status, and reported decoder crashes are logged locally. Analysis-process startup failures stop the scan with an error instead of silently skipping the library. Each Sharp decoder uses one libvips thread, a bounded 16 MB operation cache, and no cached file handles. These cache limits do not bound total image-decoding memory; lowering parallelism can still help with very large files. The app's bundled Electron runtime runs the analysis processes; Windows runs the WIC helpers.

- **Exact content (SHA-256)** streams the original files and groups byte-identical copies,
  even across different paths or file extensions.
- **Similar images (spectral analysis)** normalizes image orientation and computes grayscale
  DCT perceptual fingerprints with color/texture checks. It compares full images and sampled
  crop regions to suggest resizes, recompressions, and some crops. Conservative matching
  includes light crops; the optional **Broader** setting samples deeper crops and tolerates
  more differences, at the cost of more false positives. This is not semantic matching or
  exhaustive crop detection. Groups are anchored on one image rather than merged through
  chains of increasingly dissimilar matches.

Review up to 20 groups per page. Each group occupies one horizontally scrollable row containing
all of its images and metadata; similarity groups list higher pixel resolutions first. Select
one canonical image and path to keep in any row, and every other image in that row is
automatically marked for recycling. An unselected row retains every image. Choices persist
across pages, and **Accept choices** applies every reviewed group in one batch without an
additional confirmation dialog.

Recycling requires a configured recycling folder and never falls back to permanent deletion.
Source hashes and file fingerprints are rechecked before applying the batch; a changed keeper
or copy stops the operation and requires a fresh
scan. Recycling preserves relative paths and avoids overwrites, including concurrent
destination collisions; linked destination subfolders are rejected. If an operation stops
partway through, the completed count and error remain visible, the library is refreshed, and
a new scan is required. Existing metadata for the keeper is retained; tags and favorites from
recycled copies are removed from the local cache, not merged into the keeper.

Similarity decoding routes `.heic` and `.heif` files to Windows WIC and retains bundled Sharp/libvips for other formats. HEIC-only scans do not load Sharp. Both paths use the full first frame, correct EXIF orientation, normalize color to sRGB, composite transparency onto white, and produce 96-by-96 RGB pixels for the app's own DCT spectral profiles. Original oriented dimensions are retained for resolution ordering. The sampling implementations are not byte-identical; conservative matching across both paths is regression-tested.

Windows HEIF Image Extensions and a suitable HEVC decoder (for example, Microsoft HEVC Video Extensions) must be installed when the file's compression requires them. The app does not download codecs or convert originals. Missing/unsupported codecs produce a per-file error with installation guidance, not a thumbnail fallback. Each Windows decode has a 30-second timeout, an exact bounded RGB response, and parent-process exit cleanup; native helper failures are isolated and reported.

Both decoding paths limit input to 100 megapixels. Unsupported codecs, corrupt/oversized files, and images changed since the library scan are explicitly
reported as skipped, with details for the first 50 failures. Exact matching does not require
image decoding. Flat/low-texture images only match by identical file content, not speculative
spectral similarity. Close deduplication before rescanning, organizing, or otherwise moving
library files.

## Manual category triage

Every existing top-level, non-linked folder is discovered as a category on scan, including empty folders. Category definitions live in `.local-content-categories.json` at the library root, so local and UNC network libraries carry their definitions between PCs. The version-1 JSON file contains a `categories` array of `{ "name": "Folder", "description": "..." }` entries. Folder names are authoritative; descriptions explain what belongs there.

Browsing does not create or modify metadata. Loading or rescanning a library automatically creates any missing top-level category folders from valid library definitions, preserving their descriptions without rewriting the JSON file or moving media. Read-only shares remain browsable when no category folders need to be created; missing folders require write access, and creation failures are reported explicitly. On the first save, matching descriptions from the former per-PC category store are migrated if no library definitions exist; newly discovered folders have blank descriptions. Legacy-only definitions do not create missing folders. Explicit seeding also saves these discovered definitions without moving media. Once library definitions exist, they are authoritative.

Rescan after editing definitions or changing folders externally. Missing defined folders are recreated, including the original folder after an external rename unless its metadata name is also updated. Renamed folders are discovered with blank descriptions when the metadata still uses the old name; the app does not guess which renamed folder inherited a description. Malformed definitions and category paths occupied by files or symbolic links cause an explicit error. Saves use an exclusive `.local-content-categories.json.lock`, detect changes since the last scan, and replace the definitions atomically. All cooperating app instances honor the lock; external editors should edit only while no save is running. A stale lock after a crash must be removed manually once no writer is active. Saving requires write access to the library.

Seed definitions from existing folders, preserving any matching legacy descriptions:

```powershell
npm run seed:categories -- "\\server\share\Library"
```

In the media preview:

- The sidebar defaults to `Unsorted`, showing only loose root-level files, and can switch to any defined category folder. Every option includes its current file count.
- `All folders` shows all scanned media, including nested subfolders, while retaining search and media-type filters.
- Click a category to move the current item and advance automatically.
- Create a category with a title and description to create its folder, move the item, and make the category immediately available.
- Ask the selected Copilot vision model to draft an editable description from the current image and proposed category title before creation.
- Use the pencil beside a category to open its in-app description editor. Save or cancel without moving the current image; blank descriptions clear the definition. Save errors remain visible in the editor with your text preserved for retry. Escape closes only the category editor, not the underlying preview.
- Ask the selected Copilot vision model to recommend one available category from the titles and descriptions, then explicitly apply or ignore the recommendation.
- Opening or navigating the preview asynchronously precomputes recommendations for the current image plus the next 24, within the configured global Copilot session limit. Results are cached by file, model, and category descriptions.
- Ready recommendations also appear as category pills beside the media-type pill on thumbnails; no placeholder is shown while unavailable, uncertain, analyzing, or failed.
- Use Left/Right Arrow to navigate.
- Use Shift+Left/Right Arrow to accept a ready AI recommendation, move the current image, then navigate in that direction.
- Use Escape to close.
- Use Delete to move the current item to the configured recycling folder and advance.

## Windows installer

The application version follows Semantic Versioning from `package.json` and appears in the title bar. Build a versioned per-user installer with native Windows tooling:

```powershell
npm run build:installer
```

The installer and its SHA-256 checksum are written to `dist/`. It installs under the current user's local application data, creates a Start Menu shortcut, and registers an uninstaller without requiring administrator access. Builds require the pinned Inno Setup 7.1.1 compiler and bundle the already verified Electron runtime for offline installation.
