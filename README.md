# LocalContentManager

A privacy-first Electron prototype for browsing, tagging, and safely organizing a local media library.

The local organization planner works from file dates, media types, user-created tags, favorite status, and ordered visual categories. Visual classification uses a pinned quantized CLIP model entirely on-device; only model weights are downloaded, and media pixels are never uploaded. Video and audio content analysis are not yet supported.

The first visual analysis downloads approximately 156 MB of model weights for `Xenova/clip-vit-base-patch32` at immutable revision `6b7c523703ae26e39be4b03774966f8571c7f523`. Results are cached by file fingerprint, model revision, and requested categories. Low-confidence and unreadable images stay in place. Earlier categories win only when their confidence is within a small tolerance of the best match, preserving priority without forcing implausible classifications.

## Privacy and safety

- Media and metadata stay on the local machine.
- The app contains no analytics. Its only application-initiated network traffic is the pinned model-weight download from Hugging Face.
- Image pixels and analysis results remain local.
- The renderer is sandboxed and receives no filesystem access.
- Media is exposed through a narrow read-only custom protocol.
- Organization plans are previews until explicitly applied.
- Moves never overwrite existing files.
- Media can be moved to a remembered recycling folder with its relative path preserved.
- When no recycling folder is configured, deletion requires confirmation and permanently removes the file.
- Media and recycling folder choices persist between launches.
- Symbolic links are not followed while scanning.
- Metadata is saved atomically under Electron's per-user application data directory.

The application has no npm runtime dependencies. Its Electron 45.1.0 Windows runtime is downloaded from the official Electron GitHub release by `scripts/install-electron.ps1`, checked against a pinned official SHA-256 digest, and stored in the ignored `.runtime` directory. Electron 45 is one of the three stable major lines currently supported by Electron.

Run `npm audit` before each release and update both the runtime version and pinned digest when Electron publishes a security update. A clean audit and current supported runtime reduce known risk but cannot guarantee that no undisclosed vulnerability exists.

## Run

```powershell
npm install
npm test
npm run check
npm start
```

Choose a media folder, add tags or favorites, describe how the private organizer should arrange it, review the dry run, and apply selected moves.

## Windows installer

The application version follows Semantic Versioning from `package.json` and appears in the title bar. Build a versioned per-user installer with native Windows tooling:

```powershell
npm run build:installer
```

The installer and its SHA-256 checksum are written to `dist/`. It installs under the current user's local application data, creates a Start Menu shortcut, and registers an uninstaller without requiring administrator access. Builds require the pinned Inno Setup 7.1.1 compiler and bundle the already verified Electron runtime for offline installation.
