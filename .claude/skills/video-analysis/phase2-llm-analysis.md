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
- `max_tokens` = 4096 per chunk call

**Stage 2 — Article Synthesis**
- All notes merged → single LLM call to write full article
- `max_tokens` = 8192 (larger to avoid truncation)
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
