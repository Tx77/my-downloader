# Downloader Pro - Agent Instructions

This repository is an Electron desktop app for downloading videos and generating transcript + LLM deep analysis.

## Quick Start for New Agents

Read these in order:

1. `CLAUDE.md` — project overview, tech stack, gotchas
2. `CODEX.md` — file map, current features, safe edit areas
3. `.claude/skills/video-analysis/README.md` — video analysis skill entrypoint
4. `.claude/skills/video-analysis/phase2-llm-analysis.md` — Phase 2 LLM design notes

## Current State

**Phase 1 (转录生成)** ✅ — ffmpeg + whisper.cpp ASR (Vulkan GPU), subtitle-first strategy

**Phase 2 (LLM 深度分析)** ✅ — DeepSeek/OpenAI/Codex CLI, two-stage analysis (chunk notes → synthesized article), ad filtering, fact/opinion tagging, credibility scoring

**Phase 3 (OCR 硬字幕)** 📋 — Planned. Frame extraction + PaddleOCR for burned-in subtitles.

## Safe Edit Areas

- `src/main/modules/content-analyzer.ts` — LLM prompts, providers, article generation
- `src/main/modules/analysis-pipeline.ts` — pipeline steps, IPC handlers, file output
- `src/preload/index.ts` — new API exposure
- `src/renderer/src/env.d.ts` — **new renderer types go here**
- `src/renderer/src/components/VideoAnalysisPanel/` + `AnalysisResultCard/` — UI

## Do Not Touch Unless Asked

- `src/main/modules/download.ts`
- `src/main/modules/subtitle-parser.ts`
- `src/main/modules/cookie.ts`
- `src/main/modules/utils.ts`
- Current API key handling logic in `analysis-pipeline.ts`

## Key Rules for LLM Analysis

- Reader-facing output = `analysis.md` (Markdown article, not JSON)
- Prompt audit output = `analysis.prompt.md`
- `analysis.json` = machine cache, not for humans
- Existing folder candidate files: `transcript.txt` > `transcript.md` > `transcript.llm.md` > README `## 转录文本` section only
- Ad/sponsor content must be filtered out
- Article `max_tokens` = 8192
- Never log API keys

## Non-Negotiable Gotchas

- Track every spawned process in the task `processSet`
- Windows whisper stdout → `iconv-lite` cp936
- Renderer types → `src/renderer/src/env.d.ts`
- API key persistence = opt-in only, `type="password"`
- Use `select-analysis-folder` for folder selection in analysis panel (not `select-folder`!)

## Typecheck

```bash
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
```
