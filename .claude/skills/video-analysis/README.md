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

- `src/main/modules/content-analyzer.ts` — prompts, provider calls, article generation, content classification
- `src/main/modules/analysis-pipeline.ts` — URL pipeline + existing-folder pipeline
- `src/main/prompts/` — 6 套分析预设 (news/knowledge/opinion/interview/tutorial/generic)
- `src/main/prompts/common.ts` — 公共规则 + 动态字数函数 (600-8000字)
- `src/main/prompts/classification.ts` — Stage 0 内容分类 prompt
- `src/main/prompts/index.ts` — prompt builder (buildChunkNotesPrompt / buildArticlePrompt)

Providers: DeepSeek (default), OpenAI-compatible, Codex CLI

Analysis pipeline:
1. **Stage 0** — Content classification: title+URL+前6000字符 → 判别类型 (置信度 ≥0.65)
2. **Stage 1** — Per-chunk structured note extraction with preset-specific tag schema
3. **Stage 2** — Article synthesis with preset-specific outline + dynamic word count
4. Ad/sponsor content filtered at extraction stage
5. Cross-chunk context bridging: chunk markers + continuity hints

Presets:
- `auto` (default) — auto-classify, fallback to `generic` if confidence < 0.65
- `news` — [EVENT]/[TIMELINE]/[ACTOR]/[CLAIM]/[UNVERIFIED]
- `knowledge` — [CONCEPT]/[EXPLANATION]/[EXAMPLE]/[MISCONCEPTION]
- `opinion` — [THESIS]/[ARG]/[ASSUMPTION]/[COUNTER]/[WEAKNESS]
- `interview` — [SPEAKER]/[QUESTION]/[ANSWER]/[STORY]/[QUOTE]
- `tutorial` — [GOAL]/[PREREQ]/[STEP]/[COMMAND]/[PITFALL]/[VERIFY]
- `generic` — [FC]/[OP]/[SP]/[RT] (original tagging system)

Dynamic word count (based on transcript length):
- <5000 chars → 800-1500 字
- 5000-15000 chars → 1500-3500 字
- >15000 chars → 3000-8000 字

Output files:
- `analysis.md` — primary reading artifact (deep analysis article)
- `analysis.prompt.md` — prompt/rules audit trail (includes preset + classification info)
- `analysis.json` — structured cache (includes analysisPreset + classification)

Existing folder analysis:
- Candidates: `transcript.txt` > `transcript.md` > `transcript.llm.md` > README `## 转录文本` section
- Uses `select-analysis-folder` IPC (does NOT modify download path)

### CLI Logs & Progress (Phase 3.6)

- Log interval: ~10% per stage (was 25%)
- Each log line includes elapsed time
- Real progress: audio extraction uses `elapsed/duration`, download/transcription use subprocess output
- Error messages include stderr tail (last 300 chars)
- Error banner has copy button → one-click copy to clipboard
- Stage label `下载` (generic) not `下载视频` — messages disambiguate subtitle vs video download

### GUI Features
- Analysis process logs stream to left panel CLI
- Unified tabs: 分析文章 / 摘要 / 要点 / 思维导图 / 转录文本
- Single scrollbar content area
- Markdown rendering for articles
- Compact completion banner with collapsible file paths


### Phase 3 — OCR 硬字幕提取 ✅

- `src/main/modules/ocr-extractor.ts`
- `resources/ocr/ocr_worker.py`
- Engine: RapidOCR (ONNX Runtime + DirectML)

### Phase 3.5 — ASR+OCR 交叉验证 ✅

`ocr` strategy in pipeline: parallel ASR+OCR → crossValidate → merged output.

### Known Issues (OCR)

1. Encoding: `PYTHONIOENCODING=utf-8` critical
2. GPU: monkey-patch RapidOCR `is_dml_available()`
3. Noise: cropBottom + text filters needed
4. numpy<2 required
5. Models: only medium/large-v3

## Next: Phase 4 📋

whisper-server, batch, RAG, export formats

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
