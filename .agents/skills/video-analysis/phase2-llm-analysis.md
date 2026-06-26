# Phase 2 LLM Analysis — Design Notes

Current Phase 2 behavior. Agents should read this before modifying prompts or pipeline.

## What Phase 2 Does

Takes transcript text from either:
- URL pipeline after subtitle/ASR transcript generation
- Existing article folder selected in UI

Then calls LLM to produce a **deep analysis article** (`analysis.md`) plus structured UI data.

## Providers

```ts
type LLMProvider = 'deepseek' | 'openai' | 'codex-cli'
```

### DeepSeek (default)
- Endpoint: `https://api.deepseek.com/v1/chat/completions`
- Models: `deepseek-chat` (pro), `deepseek-chat-flash` (flash)
- Key lookup: request/UI key → saved store key (if opt-in) → `.env` `DEEPSEEK_API_KEY`

### OpenAI-compatible
- Default model: `gpt-5.5`
- Key lookup: request/UI key → saved store key → `.env` `OPENAI_API_KEY`
- Configurable base URL for compatible endpoints

### Codex CLI
- Local subprocess: `spawn('codex', ['exec', '--skip-git-repo-check', '--model', model, prompt])`
- Must be tracked in `processSet` for cancellation

## Analysis Pipeline

### Two-Stage Architecture

**Stage 1 — Structured Note Extraction (per chunk)**
- Chunk size: 8000 chars (or direct if ≤24000 chars)
- Each chunk: call LLM to extract structured notes
- Notes include:
  - Core content summary
  - Key facts/numbers/cases table (with [FC]/[OP]/[SP]/[RT] inline tags)
  - Argument/narrative structure (causal chain or story arc)
  - Rhetoric & wording analysis (3-5 representative quotes with function analysis)
  - Fact vs opinion split table (verifiable fact / author judgment / unverified claim / emotional expression / ad)
- **Ad filtering**: Sponsor/merchandise/promotional content identified and excluded
- `max_tokens` = 8192 per chunk call

**Stage 2 — Article Synthesis**
- All notes merged → single LLM call to write full article
- `max_tokens` = 16384 (generous headroom for long-form analysis)
- Article structure (9 sections):
  1. 一句话结论 (bottom-line takeaway)
  2. 内容概览 (what it's about, ≥200 chars)
  3. 论证/叙事主线 (premise→evidence→reasoning→conclusion, OR story arc)
  4. 关键事实、数字与案例 (table with credibility tags)
  5. 事实与观点拆分 (8-15 entries, each classified)
  6. 作者的立场、情绪与表达策略 (tone, rhetorical devices, community techniques)
  7. 可信度与论证质量评估 (5-dimension star rating + overall assessment)
  8. 可以追问的问题 (4-8 verification questions with reasons)
  9. 速读版 (6-12 one-line bullets)

## Inline Tagging System

Used in note extraction. Based on media literacy frameworks.

| Tag | Meaning | Example |
|-----|---------|---------|
| [FC] | Factual Claim — verifiable | "2024年英国GDP增速1.4%" |
| [FC-未给来源] | Factual Claim without source | "据网友统计..." |
| [OP] | Opinion — author's judgment | "这政策彻底失败了" |
| [SP] | Speculation — prediction | "明年增速可能跌破1%" |
| [RT] | Rhetorical Technique — emotional/persuasive | "日落帝国啊天黑了" |

## Ad/Sponsor Filtering

Detection signals (applied at note extraction):
- Tone shift from analysis to promotion
- Keywords: "点击链接", "评论区下单", "我的课程", "合作推广", "限时优惠", "点击购买"
- Price mentions, QR code references
- The phrase "接下来到了晚宴时间" is a known B站 ad transition marker

Filtered content does not enter the article.

## Credibility Scoring

Five dimensions, 1-5 stars each:
1. **事实准确性** — Are factual claims verifiable?
2. **论证逻辑性** — Does the reasoning hold?
3. **信息来源透明度** — Are sources cited?
4. **立场平衡度** — Are opposing views fairly represented?
5. **修辞克制程度** — Emotional manipulation vs rational persuasion

## Existing Folder Input Rules

Candidate files (searched in order):
1. `transcript.txt`
2. `transcript.md`
3. `transcript.llm.md`
4. `README.md` — only the section after `## 转录文本` or `## Transcript`, stopping at next `##`

Rationale: arbitrary `.md` files may contain old analyses/drafts that pollute LLM input.

## Output Files

| File | Purpose | Reader |
|------|---------|--------|
| `analysis.md` | Primary deep analysis article | Human |
| `analysis.prompt.md` | Full prompts + rules + chunking info | Human audit |
| `analysis.json` | Structured data (summary, keyPoints, mindMap, analysis metadata) | UI cache |

## Key Constraints

- Never log API keys
- API key UI = `type="password"`
- Persistence = opt-in only (checkbox)
- DeepSeek is default provider
- Codex CLI must be in `processSet`
- Do not invent external facts
- Use "作者认为/作者声称" for unverified claims
- Handle both argument-style and narrative-style content

---

## Proposed: Prompt Preset Router

Status: design proposal. Not implemented yet.

### Problem

The current LLM analysis prompt and article outline are fixed. This works for some videos, but different video genres need different analysis shapes:

- News/reporting needs timeline, actors, claims, source transparency, and unverified information.
- Knowledge/course videos need concepts, explanations, examples, misconceptions, and learning checklist.
- Opinion/commentary needs thesis, argument chain, assumptions, counterarguments, and rhetoric analysis.
- Interviews/podcasts need speakers, questions, answers, stories, disagreements, and quotable insights.
- Tutorials need goals, prerequisites, steps, commands/config, pitfalls, and verification methods.

A single prompt flattens all of these into the same article structure and can produce awkward or low-signal output.

### Goal

Introduce a prompt preset router while preserving the current two-stage architecture:

```text
transcript
  -> classifyContentType()
  -> selectPromptPreset()
  -> extractChunkNotes(preset)
  -> synthesizeArticle(preset)
  -> write analysis.md / analysis.prompt.md / analysis.json
```

V1 scope:

- Apply preset routing to the deep article path (`analysis.md`) first.
- Keep existing summary / key-points / mind-map prompts unchanged in V1.
- Keep the current two-stage chunk notes -> synthesis architecture.
- Preserve ad filtering, fact/opinion/speculation/rhetoric handling, and credibility assessment across all presets.

Token cost estimate:

- Classification uses title, URL, and the first 3000-6000 transcript characters.
- Expected classification cost is roughly 2000-3000 input tokens plus ~200 output tokens.
- This is small relative to chunk extraction and article synthesis, and can be treated as negligible for normal analysis.

### Presets

```ts
type AnalysisPreset =
  | 'auto'
  | 'news'
  | 'knowledge'
  | 'opinion'
  | 'interview'
  | 'tutorial'
  | 'generic'
```

- `auto`: default. Classify transcript, then choose a preset.
- `news`: news reports, documentaries, event tracking.
- `knowledge`: courses, explainers, lectures, educational content.
- `opinion`: commentary, business/social/political analysis.
- `interview`: interviews, podcasts, roundtables.
- `tutorial`: technical tutorials, operational guides, tool demos.
- `generic`: fallback, close to the current fixed prompt.

### Stage 0: Content Classification

Before chunk note extraction, run a small classification call using the title, URL, and the first 3000-6000 transcript characters.

Expected JSON:

```json
{
  "type": "news",
  "confidence": 0.82,
  "reason": "Transcript contains event reporting, named organizations, time references, and multiple claims.",
  "secondaryTypes": ["opinion"],
  "recommendedPreset": "news"
}
```

Type:

```ts
interface ContentClassification {
  type: AnalysisPreset
  confidence: number
  reason: string
  secondaryTypes?: AnalysisPreset[]
  recommendedPreset: Exclude<AnalysisPreset, 'auto'>
}
```

Routing:

```text
if userPreset !== 'auto':
  use userPreset
else if classification.confidence >= 0.65:
  use classification.recommendedPreset
else:
  use generic
```

If classification fails or JSON parsing fails, fall back to `generic` and continue analysis.

Suggested classification prompt:

```text
System:
You classify video transcripts for downstream prompt routing.
Return JSON only. Do not summarize the video. Do not invent facts.

User:
Classify this video into exactly one primary type and optional secondary types.

Allowed primary types:
- news: news reports, documentaries, event tracking, public affairs
- knowledge: courses, explainers, lectures, educational content
- opinion: commentary, argument, editorial, business/social/political analysis
- interview: interviews, podcasts, roundtables, multi-speaker discussion
- tutorial: technical tutorials, operational guides, tool demos, step-by-step teaching
- generic: unclear, mixed, entertainment, vlog, or not enough signal

Return JSON with:
{
  "type": "news|knowledge|opinion|interview|tutorial|generic",
  "confidence": 0.0-1.0,
  "reason": "short reason",
  "secondaryTypes": ["optional secondary type"],
  "recommendedPreset": "news|knowledge|opinion|interview|tutorial|generic"
}

Routing rules:
- Choose generic when confidence is below 0.65.
- Prefer interview when the structure is mainly question-answer or multi-speaker exchange.
- Prefer tutorial when the transcript contains operational steps, commands, configurations, or verification.
- Prefer news when the transcript centers on an event, timeline, institutions, public claims, or source reliability.
- Prefer opinion when the transcript centers on a thesis, argument, interpretation, or persuasion.
- Prefer knowledge when the transcript teaches concepts without step-by-step operation.

Title: {title}
URL: {url}
Transcript excerpt:
{excerpt}
```

### Stage 1: Preset-Specific Chunk Notes

Keep the current chunking strategy, but switch the note schema by preset.

Common rules for all presets:

- Filter ads, sponsorships, self-promotion, and calls to buy/follow/subscribe.
- Preserve timestamps or segment references when available.
- Do not invent external facts.
- Separate facts, opinions, speculation, rhetoric, and unsupported claims.
- Prefer concise structured notes over polished prose.

`news` notes:

```text
[EVENT] event
[TIMELINE] timeline point
[ACTOR] person or organization
[FC] verifiable factual claim
[CLAIM] stated claim
[UNVERIFIED] unverified statement
[OP] commentary or stance
[CONTEXT] background context
[RISK] controversy or risk
```

`knowledge` notes:

```text
[CONCEPT] core concept
[EXPLANATION] explanation
[EXAMPLE] example
[RELATION] relationship between concepts
[MISCONCEPTION] common misunderstanding
[TAKEAWAY] transferable takeaway
[OPEN] unresolved or undeveloped question
```

`opinion` notes:

```text
[THESIS] central thesis
[ARG] supporting argument
[ASSUMPTION] implicit assumption
[FC] factual support
[OP] judgment
[COUNTER] possible counterargument
[WEAKNESS] weakness in reasoning
[RHETORIC] rhetorical technique
```

`interview` notes:

```text
[SPEAKER] speaker
[QUESTION] question
[ANSWER] answer
[STORY] story or case
[INSIGHT] insight
[DISAGREE] disagreement or tension
[QUOTE] quotable expression
[ACTION] practical advice
```

`tutorial` notes:

```text
[GOAL] learning or task goal
[PREREQ] prerequisite
[STEP] operation step
[COMMAND] command or code
[CONFIG] configuration
[PITFALL] common pitfall
[VERIFY] verification method
[CHECKLIST] checklist item
```

`generic` keeps the current `[FC] / [OP] / [SP] / [RT]` tagging system.

### Stage 2: Preset-Specific Article

`analysis.md` remains the main reader-facing artifact, but the outline changes by preset.

`news` outline:

```markdown
# Title

## One-Sentence Summary
## Event Overview
## Key Timeline
## People and Organizations
## Confirmed Facts
## Claims and Unverified Information
## Background and Context
## Controversies and Risks
## Credibility Assessment
## What Still Needs Verification
```

`knowledge` outline:

```markdown
# Title

## One-Sentence Summary
## Who This Is For
## Core Concepts
## Key Explanations
## Examples and Analogies
## Common Misunderstandings
## Transferable Takeaways
## Learning Checklist
## Open Questions
```

`opinion` outline:

```markdown
# Title

## One-Sentence Summary
## Central Thesis
## Argument Chain
## Factual Support
## Hidden Assumptions
## Counterarguments
## Reasoning Quality
## Useful Judgments
## What To Be Careful About
```

`interview` outline:

```markdown
# Title

## One-Sentence Summary
## Guest and Topic
## Key Questions
## Core Answers
## Stories and Cases
## Main Insights
## Disagreements and Tensions
## Quotable Lines
## Actionable Advice
```

`tutorial` outline:

```markdown
# Title

## One-Sentence Summary
## Goal and Audience
## Prerequisites
## Step-by-Step Process
## Key Commands or Configuration
## Verification Method
## Common Pitfalls
## Final Checklist
## Next Learning Steps
```

`generic` uses the current deep-analysis article structure.

Classification context should be injected into the article synthesis prompt:

```text
Content classification:
- Primary preset: news
- Confidence: 0.82
- Secondary types: opinion
- Routing note: This is primarily news/reporting but includes commentary. Clearly separate reported facts from the author's interpretation.
```

`secondaryTypes` are not only audit metadata; they should guide Stage 2 synthesis. They are especially useful for mixed content such as news plus opinion, interview plus knowledge, or tutorial plus product review.

### UI

Add an `Analysis Type` dropdown inside the LLM settings panel, because preset choice is an LLM behavior setting rather than a video-processing strategy.

```text
Auto
News/Event
Knowledge/Course
Opinion/Commentary
Interview/Podcast
Tutorial/How-to
Generic
```

Default: `Auto`.

If auto classification succeeds, show:

```text
Analysis type: News/Event, confidence 82%
```

If the user selects a preset manually, show:

```text
Analysis type: Tutorial/How-to (user selected)
```

Do not add a free-form prompt editor in the first version.

If auto classification confidence is below threshold, show:

```text
Analysis type: Generic (auto classification uncertain)
```

### API and Data Model

Renderer and main request:

```ts
analysisPreset?: AnalysisPreset
```

`analysis.json` should include:

```json
{
  "analysisPreset": "news",
  "classification": {
    "type": "news",
    "confidence": 0.82,
    "reason": "...",
    "secondaryTypes": ["opinion"],
    "recommendedPreset": "news"
  }
}
```

`analysis.prompt.md` should include:

```markdown
# Prompt Audit

- Preset requested: auto
- Preset used: news
- Classification confidence: 0.82
- Classification reason: ...
- Provider: deepseek
- Model: deepseek-chat

## Classification Prompt
...

## Chunk Notes Prompt
...

## Article Prompt
...
```

### Code Touch Points

- `src/main/modules/content-analyzer.ts`
  - Add `AnalysisPreset`
  - Add `ContentClassification`
  - Add `classifyContentType()`
  - Import prompt builders from `src/main/prompts/`
  - Pass preset/classification through `analyzeTranscript()`
  - Pass preset/classification through `generateAnalysisArticle()`

- `src/main/modules/analysis-pipeline.ts`
  - Thread `analysisPreset` through URL and existing-folder analysis.
  - Run classification before LLM analysis when preset is `auto`.
  - Save preset/classification into `analysis.json`.
  - Include preset/classification in `analysis.prompt.md`.

- `src/preload/index.ts`
  - No new IPC needed; expose the new request field.

- `src/renderer/src/env.d.ts`
  - Add `AnalysisPreset`.
  - Add `analysisPreset` to `startAnalysis` and `analyzeExistingFolder`.

- `src/renderer/src/components/VideoAnalysisPanel/`
  - Add preset dropdown inside LLM settings.
  - Show preset used and confidence after completion.

### Prompt Organization

Create `src/main/prompts/` from the first implementation. Do not put all preset prompt text into `content-analyzer.ts`; preset prompts will be tuned independently and should be easy to review.

```ts
interface PromptPresetDefinition {
  id: Exclude<AnalysisPreset, 'auto'>
  label: string
  description: string
  notesSchema: string
  articleOutline: string
  qualityRules: string
  sharedRules?: string[]
}
```

Directory:

```text
src/main/prompts/
  common.ts
  classification.ts
  index.ts
  presets/news.ts
  presets/knowledge.ts
  presets/opinion.ts
  presets/interview.ts
  presets/tutorial.ts
  presets/generic.ts
```

`common.ts` owns shared rules:

- Ad/sponsor/self-promotion filtering.
- No invented external facts.
- Separate facts, opinions, speculation, rhetoric, and unsupported claims.
- Use cautious attribution for unverified claims.
- Preserve timestamps or segment references where useful.
- Handle multilingual transcripts.

Prompt builders should compose common rules with preset-specific schema/outline instead of duplicating common rules in every preset file.

Example:

```ts
function buildChunkNotesPrompt(preset: PromptPresetDefinition): { system: string; user: string } {
  return {
    system: [COMMON_SYSTEM_RULES, preset.qualityRules].join('\n\n'),
    user: [COMMON_NOTE_TASK, preset.notesSchema].join('\n\n')
  }
}
```

### Compatibility

- Missing `analysisPreset` defaults to `auto`.
- Classification failure falls back to `generic`.
- Manual preset can skip classification in v1 to reduce cost.
- URL analysis can classify after transcript acquisition in V1; do not block the pipeline for user confirmation.
- Existing-folder analysis may classify immediately after folder/transcript selection in a later UX pass because transcript text is already available.
- Provider behavior stays unchanged for DeepSeek, OpenAI-compatible, and Codex CLI.
- `analysis.md` remains the primary reader artifact.
- `analysis.prompt.md` remains the audit artifact.

### Risks

1. Classification may choose the wrong preset.
   - Mitigation: confidence threshold and `generic` fallback.
2. Prompt maintenance cost increases.
   - Mitigation: shared common rules plus preset definitions.
3. Output structures diverge.
   - Mitigation: frontend renders `analysis.md` as Markdown and does not depend on section names.
4. Token cost increases.
   - Mitigation: classify only title, URL, and first 3000-6000 transcript chars.
5. JSON parsing may fail on some providers.
   - Mitigation: fallback to `generic`.

### Implementation Order

1. Add `AnalysisPreset` and `ContentClassification` types.
2. Add UI dropdown and request fields.
3. Add `src/main/prompts/` with common rules, classification prompt, and preset files.
4. Add `classifyContentType()` and write classification to `analysis.json`.
5. Switch chunk-note prompts by preset.
6. Switch article prompts by preset and inject `secondaryTypes`.
7. Expand `analysis.prompt.md` audit.
8. Typecheck both main and renderer.
9. Test with sample videos:
   - news
   - tutorial
   - interview
   - opinion/commentary
   - knowledge/course

### Acceptance Criteria

- `auto` chooses reasonable presets for different videos.
- Manual preset overrides auto routing.
- `analysis.md` structure clearly fits the content type.
- Ad filtering remains active.
- Fact/opinion/speculation/rhetoric handling remains active.
- `analysis.prompt.md` records preset and classification data.
- Existing URL and existing-folder analysis still work.
- Low-confidence auto classification is visible to the user and falls back to `generic`.
- V1 does not change summary / key-points / mind-map prompts.
- `news` output includes a timeline section with at least 3 time/order points when the transcript contains enough event chronology.
- `tutorial` output includes steps and a final checklist when the transcript contains operational instructions.
- `interview` output identifies speakers/questions/answers when the transcript contains speaker-like turns.
- `opinion` output identifies thesis, assumptions, counterarguments, and reasoning quality.
- `knowledge` output identifies concepts, explanations, examples, and misconceptions when present.
- Typecheck passes:

```bash
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
```
