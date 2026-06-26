# Downloader Pro — Codex Project Guide

Quick handoff for agents working in `D:\Code\my-downloader`. **Read this before reading anything else.**

## Stack

- Electron 39 + React 19 + TypeScript 5 + Vite 7
- Package manager: `pnpm`
- Build: `electron-vite`, `electron-builder`
- Bundled: `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, `whisper-cli.exe`
- Python deps (OCR): `rapidocr`, `onnxruntime-directml`, `numpy<2`
- Typecheck: `npx tsc --noEmit -p tsconfig.node.json --composite false`
- Renderer: `npx tsc --noEmit -p tsconfig.web.json --composite false`

## Important Files

### Main Process

| File | Purpose | Status |
| --- | --- | --- |
| `src/main/index.ts` | Window creation, module init | Stable |
| `src/main/modules/download.ts` | yt-dlp download engine | DO NOT TOUCH |
| `src/main/modules/subtitle-parser.ts` | SRT/VTT parser | DO NOT TOUCH |
| `src/main/modules/ipc.ts` | IPC handlers | Add handlers only |
| `src/main/modules/cookie.ts` | Bilibili cookie helpers | DO NOT TOUCH |
| `src/main/modules/utils.ts` | Binary paths, proxy, model dir | DO NOT TOUCH |
| `src/main/modules/audio-extractor.ts` | ffmpeg audio → 16kHz WAV | Stable |
| `src/main/modules/transcriber.ts` | whisper.cpp ASR (Vulkan GPU, large-v3 + medium) | Stable |
| `src/main/modules/ocr-extractor.ts` | [NEW] OCR (RapidOCR + DirectML, batch JSON protocol) | Phase 3 |
| `src/main/modules/content-analyzer.ts` | LLM prompts, provider calls, article gen | Phase 2 core |
| `src/main/modules/analysis-pipeline.ts` | Pipeline orchestration (URL + existing-text + OCR) | Phase 2+3 |

### Renderer

| File | Purpose |
| --- | --- |
| `src/renderer/src/App.tsx` | Main layout: left panel (download + CLI logs), right panel (tabs) |
| `src/renderer/src/env.d.ts` | **Renderer types. Add new API types HERE, not preload.** |
| `src/preload/index.ts` | contextBridge implementation |
| `src/renderer/src/components/VideoAnalysisPanel/` | URL analysis + folder analysis + LLM settings + strategy select |
| `src/renderer/src/components/AnalysisResultCard/` | Summary/KeyPoints/MindMap renderers |

### Resources

| Path | Purpose |
| --- | --- |
| `resources/bin/` | Bundled binaries (whisper-cli, ffmpeg, yt-dlp) |
| `resources/bin/models/` | Whisper models (large-v3 ~3GB, medium ~1.5GB) |
| `resources/ocr/ocr_worker.py` | [NEW] RapidOCR Python worker (stdin/stdout JSON) |

## Current Features

### Download (Stable)
- Bilibili/YouTube video and audio download
- External subtitle download (manual/auto, SRT/VTT)
- Bilibili Cookie login, concurrent download (1-10), open folder / delete files

### Video Analysis

**Phase 1 — Transcription ✅:**
- ffmpeg → 16kHz mono WAV
- whisper.cpp ASR with Vulkan GPU (AMD 7900XTX)
- Models: large-v3 (best ~3GB), medium (~1.5GB)
- Strategy: subtitle-first → ASR fallback
- Output: `{savePath}/article/{safeTitle}/` (transcript.txt, transcript.json, README.md)

**Phase 2 — LLM Analysis ✅:**
- Providers: DeepSeek (default), OpenAI-compatible, Codex CLI
- Two-stage: chunk notes extraction ([FC]/[OP]/[SP]/[RT] tags) → full article synthesis
- 9-section article with credibility scoring, ad filtering
- Output: analysis.md, analysis.prompt.md, analysis.json
- Existing-folder analysis via `select-analysis-folder` IPC

**Phase 3 — OCR Hard Subtitle Extraction 🔧:**
- Engine: RapidOCR v3 (ONNX Runtime + DirectML for AMD GPU)
- Flow: ffmpeg frames (fps=1, cropBottom=1/3) → pHash dedup → batch JSON → Python worker → text filter → merge
- GPU: Monkey-patched `ProviderConfig.is_dml_available()` to force DirectML
- Known: noisy output on documentary/news videos (too much on-screen text, not just subtitles)

## Architecture Patterns

- **Binary execution**: `spawn(getBinaryPath('tool'), args)` — always use this
- **IPC**: `ipcMain.handle` (req/res) + `webContents.send` (push)
- **State**: `electron-store`
- **Process tracking**: `Set<ChildProcess>` + `processSet` param → cancel via `taskkill /T /F`
- **Python subprocess**: stdin/stdout JSON line protocol, single + batch modes
- **Paths**: `app.isPackaged` distinguishes dev/packaged

## Critical Gotchas

1. **Every spawned process must be in processSet** — orphan processes CPU 100%
2. **whisper threads**: physical cores, not logical. large-v3 use `-t 8 -p 4`
3. **Windows encoding**: whisper stdout → `iconv-lite` cp936. Python pipe → `PYTHONIOENCODING=utf-8`
4. **numpy**: `onnxruntime-directml` requires `numpy<2`. Upgrading numpy breaks DLL loading
5. **RapidOCR GPU**: Internal `use_dml` defaults to False → must monkey-patch `ProviderConfig.is_dml_available()`
6. **Model download**: Use `hf-mirror.com` (stable from China). Never resume from two different sources — corrupts file
7. **Renderer types** go in `src/renderer/src/env.d.ts`, NOT `src/preload/index.d.ts`
8. **Path pollution**: Use `select-analysis-folder` for folder selection, not `select-folder`
9. **Never log API keys**. UI = `type="password"`. Persistence = opt-in checkbox only
10. **Do not touch**: `download.ts`, `subtitle-parser.ts`, `cookie.ts`, `utils.ts`

## Next: Phase 3.5 — ASR+OCR Cross-Validation 📋

See `.claude/skills/video-analysis/plan.md` for full design.

**Problem**: Pure OCR produces too much noise on documentary/news videos. On-screen text (watermarks, dates, social handles) can't be distinguished from subtitles.

**Solution**: ASR is the primary source, OCR is the verifier.
- Run ASR + OCR in parallel (both pipelines)
- Cross-validate: match OCR segments against ASR window (±3s)
- Merge: matched → high confidence (use ASR text), OCR-only → discard, ASR-only → keep
- Modify: `analysis-pipeline.ts` OCR branch → add `crossValidate()` call

## Skill Docs

For detailed designs, read (in order):
1. `.claude/skills/video-analysis/README.md` — quick reference
2. `.claude/skills/video-analysis/plan.md` — full technical plan (all phases)
3. `.claude/skills/video-analysis/phase2-llm-analysis.md` — LLM prompt design

## Doc Maintenance Protocol

When told "更新 skill 文档" / "update docs" / "sync skills" — **execute without asking**:

1. Update this file (`CODEX.md`) if project structure, gotchas, or phase status changed
2. Update `.claude/skills/video-analysis/{plan.md,README.md,phase2-llm-analysis.md}` with current status
3. Sync copies: `cp .claude/skills/video-analysis/*.md .agents/skills/video-analysis/`
4. Verify: `diff .claude/skills/video-analysis/ .agents/skills/video-analysis/`
5. Keep `.claude/` and `.agents/` copies identical

## Verification

```bash
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
pnpm dev
```
