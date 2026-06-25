# Downloader Pro - Codex Project Guide

Quick handoff for agents working in `D:\Code\my-downloader`.

## Stack

- Electron 39 + React 19 + TypeScript 5 + Vite 7
- Package manager: `pnpm`
- Build: `electron-vite`, `electron-builder`
- Bundled: `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, `whisper-cli.exe`
- Typecheck: `npx tsc --noEmit -p tsconfig.node.json --composite false`
- Renderer: `npx tsc --noEmit -p tsconfig.web.json --composite false`

## Important Files

### Main Process

| File | Purpose | Status |
| --- | --- | --- |
| `src/main/index.ts` | Window creation, module init | Stable |
| `src/main/modules/download.ts` | yt-dlp download engine | DO NOT TOUCH |
| `src/main/modules/subtitle-parser.ts` | SRT/VTT parser | DO NOT TOUCH |
| `src/main/modules/ipc.ts` | IPC handlers (URL parse, file, folder, login) | Add handlers only |
| `src/main/modules/cookie.ts` | Bilibili cookie helpers | DO NOT TOUCH |
| `src/main/modules/utils.ts` | Binary paths, proxy args | DO NOT TOUCH |
| `src/main/modules/audio-extractor.ts` | ffmpeg audio → 16kHz WAV | Stable |
| `src/main/modules/transcriber.ts` | whisper.cpp ASR (Vulkan GPU) | Stable |
| `src/main/modules/content-analyzer.ts` | LLM prompts, provider calls, article gen | Phase 2 core |
| `src/main/modules/analysis-pipeline.ts` | URL + existing-text pipeline orchestration | Phase 2 core |

### Renderer

| File | Purpose |
| --- | --- |
| `src/renderer/src/App.tsx` | Main layout: left panel (download + CLI logs), right panel (tabs) |
| `src/renderer/src/env.d.ts` | Renderer-side `window.electron` types. **Add new types HERE.** |
| `src/preload/index.ts` | contextBridge implementation |
| `src/renderer/src/components/VideoAnalysisPanel/` | URL analysis + existing folder analysis + LLM settings UI |
| `src/renderer/src/components/AnalysisResultCard/` | Summary/KeyPoints/MindMap content renderers |

## Current Features

### Download (Phase 1)

- Bilibili/YouTube video and audio download.
- External subtitle download (manual/auto, SRT/VTT).
- Bilibili Cookie login.
- Concurrent download (1-10).
- Open folder / delete local files.

### Video Analysis (Phase 1 + 2 ✅)

**Transcript Pipeline:**
- ffmpeg → 16kHz mono WAV
- whisper.cpp ASR with Vulkan GPU (AMD 7900XTX)
- Strategy: `subtitle-first` → ASR fallback
- Output: `{savePath}/article/{safeTitle}/`

Files in article folder:
- `transcript.txt` — raw transcript
- `transcript.json` — metadata + segments
- `README.md` — overview (includes transcript + appended summary/key-points/mind-map)
- `analysis.md` — **primary reader-facing deep analysis article**
- `analysis.prompt.md` — exact prompts/rules used (audit trail)
- `analysis.json` — structured cache for UI (NOT the main reading artifact)

**LLM Analysis:**
- Providers: `deepseek` (default), `openai` (OpenAI-compatible), `codex-cli` (local subprocess)
- Two-stage: chunk notes extraction → full article synthesis
- `max_tokens`: 8192 for notes, **16384 for article**
- Notes stage: [FC]/[OP]/[SP]/[RT] inline fact/opinion tagging + ad filtering
- Article: 9 sections — conclusion, overview, argument flow, facts table, fact/opinion split, rhetoric, credibility score (5-dim), follow-up questions, speed-read
- Ad/sponsor content filtered at note extraction stage

**GUI:**
- Analysis logs stream to left panel CLI (via `onLog` prop)
- Unified top-level tabs: 分析文章 / 摘要 / 要点 / 思维导图 / 转录文本
- Single scrollbar, no nested scrolling
- Markdown rendering for analysis article
- Compact completion banner with collapsible file paths

**Existing-folder analysis:**
- Candidate files: `transcript.txt` > `transcript.md` > `transcript.llm.md` > `README.md` transcript section
- Uses `select-analysis-folder` IPC (does NOT pollute download path!)
- Output: same article files, written directly into the selected folder

**API Key rules:**
- `.env` fallback (DEEPSEEK_API_KEY / OPENAI_API_KEY)
- UI password input (`type="password"`)
- Persisted ONLY if user checks save box
- **Never log API keys**

## Known Quality Decisions

1. Article generation uses extracted notes, not raw transcript. Notes preserve evidence with fact/opinion labels.
2. Short transcripts (≤24000 chars) bypass chunking — go directly to notes.
3. `analysis.json` is for UI cache. `analysis.md` is for humans.
4. DeepSeek is default. Codex CLI is subprocess-based and tracked in processSet.

## Critical Gotchas

1. **Every spawned process must be tracked.**
```ts
const proc = spawn(binary, args)
processSet?.add(proc)
proc.on('close', () => processSet?.delete(proc))
proc.on('error', () => processSet?.delete(proc))
```

2. **whisper thread count** = physical cores, not logical. `Math.min(16, Math.max(8, Math.floor(cpuCores / 2)))`.

3. **Windows whisper stdout** needs `iconv-lite` cp936 decoding.

4. **File writes must be utf8**.

5. **Renderer API types** go in `src/renderer/src/env.d.ts`, **NOT** `src/preload/index.d.ts`.

6. **Path pollution**: The `select-folder` IPC handler writes to store. Use `select-analysis-folder` for any folder selection that should NOT change the user's download path.

7. **Use `getBinaryPath()`** for bundled binaries. Never hardcode paths.

8. **Never log API keys**. UI key input = `type="password"`. Persistence = opt-in only.

## Do Not Touch Unless Explicitly Asked

- `download.ts`, `subtitle-parser.ts`, `cookie.ts`, `utils.ts`
- Current provider/key handling logic in `analysis-pipeline.ts`

## Safe Edit Areas

- `content-analyzer.ts` — prompts, provider config, chunking
- `analysis-pipeline.ts` — pipeline steps, IPC handlers, file I/O
- `preload/index.ts` — new API exposure
- `renderer/src/env.d.ts` — new type declarations
- `VideoAnalysisPanel/` — UI
- `AnalysisResultCard/` — content renderers

## Verification

```bash
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
pnpm dev
```
