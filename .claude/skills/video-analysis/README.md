# Video Analysis Skill

Use this skill when working on Downloader Pro video analysis: transcript generation, LLM deep analysis, existing folder analysis, or analysis UI.

## Current Implementation

### Phase 1 — Transcript Generation ✅

- `src/main/modules/audio-extractor.ts` — ffmpeg 16kHz WAV extraction
- `src/main/modules/transcriber.ts` — whisper.cpp ASR (Vulkan GPU)
- `src/main/modules/analysis-pipeline.ts` — pipeline orchestration

Capabilities:
- Subtitle-first strategy: external subtitles → ASR fallback
- GPU: whisper.cpp Vulkan backend (AMD 7900XTX)
- Output: `{savePath}/article/{safeTitle}/` (transcript.txt, transcript.json, README.md)

### Phase 2 — LLM Deep Analysis ✅

- `src/main/modules/content-analyzer.ts` — prompts, provider calls, article generation
- `src/main/modules/analysis-pipeline.ts` — URL pipeline + existing-folder pipeline

Providers: DeepSeek (default), OpenAI-compatible, Codex CLI

Analysis pipeline:
1. Chunk transcript (~8000 chars) or direct input (≤24000 chars)
2. Per-chunk structured note extraction with [FC]/[OP]/[SP]/[RT] inline tagging
3. Ad/sponsor content filtered at extraction stage
4. Final article synthesis (max_tokens=8192)

Article sections: 结论 → 内容概览 → 论证/叙事主线 → 关键事实表格 → 事实观点拆分 → 修辞策略 → 可信度五维评分 → 追问 → 速读版

Output files:
- `analysis.md` — primary reading artifact (deep analysis article)
- `analysis.prompt.md` — prompt/rules audit trail
- `analysis.json` — structured cache for UI

Existing folder analysis:
- Candidates: `transcript.txt` > `transcript.md` > `transcript.llm.md` > README `## 转录文本` section
- Uses `select-analysis-folder` IPC (does NOT modify download path)

### GUI Features
- Analysis process logs stream to left panel CLI
- Unified tabs: 分析文章 / 摘要 / 要点 / 思维导图 / 转录文本
- Single scrollbar content area
- Markdown rendering for articles
- Compact completion banner with collapsible file paths

## Next: Phase 3 — OCR

See `plan.md` for OCR design.

## Reference Files

- `plan.md` — overall technical plan (all phases)
- `phase2-llm-analysis.md` — Phase 2 design notes and prompt strategy
- `whisper-optimization.md` — whisper-server persistent mode (future optimization)

## Verification

```bash
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
pnpm dev
```
