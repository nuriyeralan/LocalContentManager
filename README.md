# Local Content Manager

A privacy-first Electron prototype for browsing, tagging, and safely organizing a local media library.

The local organization planner works from file dates, media types, user-created tags, favorite status, and ordered visual categories. Visual classification uses a user-selectable vision-capable model from the signed-in GitHub Copilot model catalog. Video and audio content analysis are not yet supported.

Visual requests send resized JPEG copies with metadata removed. Filenames and folder paths are never attached. Results are cached by file fingerprint, selected model, and requested categories. Low-confidence and unreadable images stay in place.

Classification sessions use the model's lowest supported reasoning effort (`none` for GPT-5.6 Sol Fast), the SDK's default context tier rather than long context, and a user-configurable maximum of 1, 2, 4, or 8 parallel transient sessions. The planner displays completed/total progress and an estimated time remaining.

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

Run `npm audit` before each release and update both the runtime version and pinned digest when Electron publishes a security update. A clean audit and current supported runtime reduce known risk but cannot guarantee that no undisclosed vulnerability exists.

## Run

```powershell
npm install
npm test
npm run check
npm start
```

Choose a media folder, add tags or favorites, describe how the private organizer should arrange it, review the dry run, and apply selected moves.

## Manual category triage

User-defined categories are persisted per media library and backed by top-level folders. Each category has a folder title plus a free-text description that explains what belongs there. In the media preview:

- The sidebar defaults to `Unsorted`, showing only loose root-level files, and can switch to any defined category folder. Every option includes its current file count.
- Click a category to move the current item and advance automatically.
- Create a category with a title and description to create its folder, move the item, and make the category immediately available.
- Ask the selected Copilot vision model to draft an editable description from the current image and proposed category title before creation.
- Edit category descriptions independently of folder names.
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
