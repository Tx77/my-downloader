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

Prompt roadmap:
- Prompt Preset Router proposal: classify content type, select preset, and generate genre-specific notes/articles. See `phase2-llm-analysis.md` section "Proposed: Prompt Preset Router".

Existing folder analysis:
- Candidates: `transcript.txt` > `transcript.md` > `transcript.llm.md` > README `## 转录文本` section
- Uses `select-analysis-folder` IPC (does NOT modify download path)

### GUI Features
- Analysis process logs stream to left panel CLI
- Unified tabs: 分析文章 / 摘要 / 要点 / 思维导图 / 转录文本
- Single scrollbar content area
- Markdown rendering for articles
- Compact completion banner with collapsible file paths

## Next: Phase 3.5 — ASR+OCR 交叉验证 📋

See `plan.md` for full design.

### Phase 3 Current Status (2026-06-26)

**Engine**: RapidOCR (ONNX Runtime + DirectML) — replaced PaddleOCR for AMD GPU support.

**Implementation**:
- `src/main/modules/ocr-extractor.ts` — ffmpeg frame extraction + pHash dedup + Python subprocess communication
- `resources/ocr/ocr_worker.py` — RapidOCR stdin/stdout JSON worker (single + batch mode)
- UI: "OCR 硬字幕" option in strategy dropdown
- ASR: whisper large-v3 model supported (~3GB, 最准)

**Known issues** (see plan.md for details):
1. **Encoding**: `PYTHONIOENCODING=utf-8` is critical — Windows pipes default to GBK
2. **GPU**: RapidOCR's `use_dml` must be monkey-patched to `True`
3. **Noise**: `cropBottom: true` + text filters needed to exclude non-subtitle text
4. **numpy**: Requires `numpy<2` for onnxruntime-directml compatibility
5. **Speed**: Per-frame OCR is inherently slower than single-run ASR

### Phase 3.5 Design (next step)
**ASR 为主, OCR 为辅**: 并行跑 ASR+OCR, 用语义比对去 OCR 噪音。
- 匹配 → 双源确认
- OCR 独有 → 丢弃
- ASR 独有 → 保留
- 修改范围: `analysis-pipeline.ts` (新增 `crossValidate()` 调用)
- 详见 plan.md Phase 3.5 节

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
