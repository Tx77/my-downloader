import { spawn, type ChildProcess } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  getPreset,
  buildChunkNotesPrompt,
  buildArticlePrompt,
  buildClassificationPrompt,
  formatWordCountGuidance
} from '../prompts'

export type LLMProvider = 'deepseek' | 'openai' | 'codex-cli'
export type AnalysisType = 'summary' | 'key-points' | 'mind-map'
export type AnalysisPreset = 'auto' | 'news' | 'knowledge' | 'opinion' | 'interview' | 'tutorial' | 'generic'

export interface ContentClassification {
  type: AnalysisPreset
  confidence: number
  reason: string
  secondaryTypes?: AnalysisPreset[]
  recommendedPreset: Exclude<AnalysisPreset, 'auto'>
}

export interface PromptPresetDefinition {
  id: Exclude<AnalysisPreset, 'auto'>
  label: string
  description: string
  notesSchema: string
  articleOutline: string
  qualityRules: string
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export interface AnalyzerOptions {
  provider?: LLMProvider
  model?: string
  apiKey?: string
  apiBase?: string
  language?: string
  processSet?: Set<ChildProcess>
  onProgress?: (message: string) => void
}

export interface SummaryResult {
  text: string
  style: 'concise' | 'detailed'
}

export interface KeyPoint {
  title: string
  description: string
  timestamp: number
  importance: 1 | 2 | 3 | 4 | 5
}

export interface MindMapNode {
  topic: string
  children: MindMapNode[]
}

export interface AnalysisResults {
  summary?: SummaryResult
  keyPoints?: KeyPoint[]
  mindMap?: MindMapNode
}

export interface ArticleAnalysisResult {
  markdown: string
  prompt: string
  preset: Exclude<AnalysisPreset, 'auto'>
  classification?: ContentClassification
}

export interface QAResponse {
  answer: string
  references: Array<{ startTime: number; endTime: number; text: string }>
}

const MAX_CHARS_PER_REQUEST = 8000

const PROVIDERS: Record<Exclude<LLMProvider, 'codex-cli'>, {
  endpoint: string
  defaultModel: string
  envKey: string
}> = {
  deepseek: {
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY'
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-5.5',
    envKey: 'OPENAI_API_KEY'
  }
}

const CODEX_DEFAULT_MODEL = 'gpt-5.5'

let envCache: Record<string, string> | null = null

async function loadProjectEnv(): Promise<Record<string, string>> {
  if (envCache) return envCache

  const env: Record<string, string> = {}
  try {
    const raw = await readFile(join(process.cwd(), '.env'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const eq = trimmed.indexOf('=')
      if (eq < 0) continue

      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      env[key] = value
    }
  } catch {}

  envCache = env
  return env
}

async function resolveApiKey(options: AnalyzerOptions, provider: Exclude<LLMProvider, 'codex-cli'>): Promise<string> {
  if (options.apiKey?.trim()) return options.apiKey.trim()
  const env = await loadProjectEnv()
  return env[PROVIDERS[provider].envKey] || ''
}

export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options: AnalyzerOptions = {},
  maxTokens = 8192
): Promise<string> {
  const provider = options.provider || 'deepseek'
  if (provider === 'codex-cli') {
    return callCodexCli(systemPrompt, userPrompt, options)
  }

  const config = PROVIDERS[provider]
  const apiKey = await resolveApiKey(options, provider)
  if (!apiKey) {
    throw new Error(`${provider} API key missing. Add ${config.envKey} to .env or enter it in LLM settings.`)
  }

  const endpoint = options.apiBase || config.endpoint
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120_000) // 120s timeout

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || config.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    })
  } catch (err) {
    clearTimeout(timeoutId)
    const msg = (err as Error).message || String(err)
    if (msg.includes('abort')) {
      throw new Error(`LLM API timeout (120s) calling ${endpoint}. DeepSeek may be slow or unreachable.`)
    }
    throw new Error(`LLM API network error calling ${endpoint}: ${msg}`)
  }
  clearTimeout(timeoutId)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`LLM API failed (${response.status}): ${text.slice(0, 300)}`)
  }

  const json = await response.json() as any
  return String(json.choices?.[0]?.message?.content || '').trim()
}

function callCodexCli(systemPrompt: string, userPrompt: string, options: AnalyzerOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = `${systemPrompt}\n\n${userPrompt}`
    const args = ['exec', '--skip-git-repo-check', '--model', options.model || CODEX_DEFAULT_MODEL, prompt]
    const proc = spawn('codex', args, { windowsHide: true })

    options.processSet?.add(proc)

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString('utf8') })
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString('utf8') })
    proc.on('close', (code) => {
      options.processSet?.delete(proc)
      if (code === 0 && stdout.trim()) resolve(stdout.trim())
      else reject(new Error(`Codex CLI failed (${code ?? 'unknown'}): ${stderr.slice(-300)}`))
    })
    proc.on('error', (err) => {
      options.processSet?.delete(proc)
      reject(new Error(`Unable to start Codex CLI: ${err.message}`))
    })
  })
}

/**
 * 将文本按最大字符数切块，优先在段落边界处切分。
 *
 * 切分优先级:
 * 1. 段落边界 (双换行 \n\n) — 最好的切分点
 * 2. 单换行 — 次优选
 * 3. 句末标点 (。！？. ! ?) + 空格 — 兜底
 * 4. 硬切 — 最后手段
 *
 * 现在 transcript 已格式化 (段落 + 时间戳)，这个函数会尽量保持段落完整。
 */
function chunkText(text: string, maxChars = MAX_CHARS_PER_REQUEST): string[] {
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    // 如果剩余部分已经小于 maxChars，直接收尾
    if (text.length - cursor <= maxChars) {
      chunks.push(text.slice(cursor).trim())
      break
    }

    const targetEnd = Math.min(cursor + maxChars, text.length)
    let breakAt: number
    let separator: string

    // Priority 1: paragraph boundary (\n\n) within range
    breakAt = text.lastIndexOf('\n\n', targetEnd)
    if (breakAt > cursor + maxChars * 0.3) {
      separator = '\n\n'
    } else {
      // Priority 2: single newline
      breakAt = text.lastIndexOf('\n', targetEnd)
      if (breakAt > cursor + maxChars * 0.5) {
        separator = '\n'
      } else {
        // Priority 3: sentence-ending punctuation
        const searchStart = cursor + Math.floor(maxChars * 0.6)
        const searchRegion = text.slice(searchStart, targetEnd)
        const punctMatch = searchRegion.match(/[。！？.!?]\s/g)
        if (punctMatch) {
          breakAt = searchStart + searchRegion.lastIndexOf(punctMatch[punctMatch.length - 1]) + 1
          separator = ' '
        } else {
          // Priority 4: hard cut
          breakAt = targetEnd
          separator = ''
        }
      }
    }

    chunks.push(text.slice(cursor, breakAt).trim())
    cursor = skipAfter(text, breakAt, separator)
  }

  return chunks.filter(Boolean)
}

/** 从 position 开始跳过指定分隔符字符，返回新的位置 */
function skipAfter(text: string, position: number, separator: string): number {
  if (!separator) return position
  let pos = position
  while (pos < text.length && separator.includes(text[pos])) {
    pos++
  }
  return pos
}

export function extractJson<T>(text: string, fallback: T): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] || text
  const firstArray = candidate.indexOf('[')
  const firstObject = candidate.indexOf('{')
  const first = firstArray >= 0 && (firstObject < 0 || firstArray < firstObject) ? firstArray : firstObject

  if (first < 0) return fallback
  const last = candidate[first] === '[' ? candidate.lastIndexOf(']') : candidate.lastIndexOf('}')
  if (last <= first) return fallback

  try {
    return JSON.parse(candidate.slice(first, last + 1)) as T
  } catch {
    return fallback
  }
}

export function getDefaultModel(provider: LLMProvider): string {
  if (provider === 'codex-cli') return CODEX_DEFAULT_MODEL
  return PROVIDERS[provider].defaultModel
}

export async function generateSummary(text: string, options: AnalyzerOptions = {}): Promise<SummaryResult> {
  options.onProgress?.('Generating summary...')
  const chunks = chunkText(text)

  const systemPrompt = [
    'You are a professional content analyst.',
    'The input transcript may be in any language (Chinese, English, Japanese, etc).',
    'Output in Chinese unless the transcript is mostly another language — then output in that language.',
    'Return concise, factual Markdown. Preserve important names, claims, numbers, and conclusions.'
  ].join('\n')

  const partials: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    options.onProgress?.(`Generating summary ${i + 1}/${chunks.length}...`)
    partials.push(await callLLM(systemPrompt, `Transcript chunk:\n${chunks[i]}`, options))
  }

  const summaryText = partials.length === 1
    ? partials[0]
    : await callLLM(systemPrompt, `Merge these partial summaries into one coherent final summary:\n\n${partials.join('\n\n---\n\n')}`, options)

  return {
    text: summaryText.trim(),
    style: text.length > 500 ? 'detailed' : 'concise'
  }
}

export async function extractKeyPoints(segments: TranscriptSegment[], options: AnalyzerOptions = {}): Promise<KeyPoint[]> {
  options.onProgress?.('Extracting key points...')
  const textWithTime = segments
    .map((s) => `[${formatTime(s.start)}] ${s.text}`)
    .join('\n')

  const chunks = chunkText(textWithTime)
  const allPoints: KeyPoint[] = []

  const systemPrompt = [
    'Extract key points from a transcript with timestamps. Input may be in any language.',
    'Return only a JSON array: [{"title":"...", "description":"...", "timestamp": seconds, "importance": 1-5}].',
    'Title and description should be in the same language as the majority of the transcript.',
    'Use timestamps that appear in the transcript. Keep 5-10 strong points total when possible.'
  ].join('\n')

  for (let i = 0; i < chunks.length; i++) {
    options.onProgress?.(`Extracting key points ${i + 1}/${chunks.length}...`)
    const response = await callLLM(systemPrompt, chunks[i], options)
    allPoints.push(...extractJson<KeyPoint[]>(response, []))
  }

  return allPoints
    .map(normalizeKeyPoint)
    .filter((point): point is KeyPoint => !!point)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 12)
}

export async function generateMindMap(text: string, options: AnalyzerOptions = {}): Promise<MindMapNode> {
  options.onProgress?.('Generating mind map...')
  const chunks = chunkText(text)

  const systemPrompt = [
    'Turn the transcript into a mind-map tree. Input may be in any language.',
    'Return only JSON: {"topic":"...", "children":[{"topic":"...", "children":[]}]}',
    'Node topics should be in the same language as the transcript. Keep depth <= 3, node topics short, and include 3-6 top-level branches.'
  ].join('\n')

  const partialMaps: MindMapNode[] = []
  for (let i = 0; i < chunks.length; i++) {
    options.onProgress?.(`Generating mind map ${i + 1}/${chunks.length}...`)
    const response = await callLLM(systemPrompt, chunks[i], options)
    partialMaps.push(normalizeMindMap(extractJson<MindMapNode>(response, { topic: '视频内容', children: [] })))
  }

  if (partialMaps.length === 1) return partialMaps[0]

  const merged = await callLLM(
    systemPrompt,
    `Merge these partial mind maps into one final map:\n${JSON.stringify(partialMaps, null, 2)}`,
    options
  )
  return normalizeMindMap(extractJson<MindMapNode>(merged, { topic: '视频内容', children: partialMaps }))
}

export async function analyzeTranscript(
  text: string,
  segments: TranscriptSegment[],
  analysisTypes: AnalysisType[],
  options: AnalyzerOptions = {}
): Promise<AnalysisResults> {
  const results: AnalysisResults = {}
  if (analysisTypes.includes('summary')) {
    results.summary = await generateSummary(text, options)
  }
  if (analysisTypes.includes('key-points')) {
    results.keyPoints = await extractKeyPoints(segments, options)
  }
  if (analysisTypes.includes('mind-map')) {
    results.mindMap = await generateMindMap(text, options)
  }
  return results
}

export async function generateAnalysisArticle(
  title: string,
  text: string,
  segments: TranscriptSegment[],
  options: AnalyzerOptions = {},
  analysisPreset: AnalysisPreset = 'auto'
): Promise<ArticleAnalysisResult> {
  options.onProgress?.('Determining analysis strategy...')

  const transcriptWithTime = segments.length
    ? segments.map((s) => `[${formatTime(s.start)}] ${s.text}`).join('\n')
    : text

  // ── Resolve preset ──
  let classification: ContentClassification | undefined
  let resolvedId: Exclude<AnalysisPreset, 'auto'>

  if (analysisPreset === 'auto') {
    options.onProgress?.('Classifying content type...')
    classification = await classifyContentType(title, title || 'video', text, options)
    resolvedId = classification.confidence >= 0.65 ? classification.recommendedPreset : 'generic'
  } else {
    resolvedId = analysisPreset as Exclude<AnalysisPreset, 'auto'>
  }

  const preset = getPreset(resolvedId)
  const wordCountGuidance = formatWordCountGuidance(
    transcriptWithTime.length,
    segments.length || Math.floor(text.length / 200)
  )

  // ── Chunking ──
  const TRANSCRIPT_DIRECT_THRESHOLD = 24000
  const useDirectTranscript = transcriptWithTime.length <= TRANSCRIPT_DIRECT_THRESHOLD
  const chunks = useDirectTranscript ? [transcriptWithTime] : chunkText(transcriptWithTime, MAX_CHARS_PER_REQUEST)

  // ── Stage 1: Note extraction (per chunk) ──
  const { system: noteSystemPrompt, user: noteUserPrompt } = buildChunkNotesPrompt(preset)

  const notes: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    options.onProgress?.(`Writing article notes ${i + 1}/${chunks.length}...`)
    const chunkMarker = chunks.length > 1
      ? `\n\n[Chunk ${i + 1}/${chunks.length}: 原文第 ${transcriptWithTime.indexOf(chunks[i]) + 1}–${transcriptWithTime.indexOf(chunks[i]) + chunks[i].length} 字符, 全文共 ${transcriptWithTime.length} 字符]\n`
      : ''
    notes.push(await callLLM(noteSystemPrompt, `${noteUserPrompt}${chunkMarker}\n\n${chunks[i]}`, options))
  }

  // ── Stage 2: Article synthesis ──
  const ARTICLE_MAX_TOKENS = 16384
  const notesText = notes.join('\n\n---\n\n')

  const { system: finalSystemPrompt, user: finalUserPrompt } = buildArticlePrompt(
    preset,
    title,
    notesText,
    wordCountGuidance,
    classification
  )

  const markdown = await callLLM(finalSystemPrompt, finalUserPrompt, options, ARTICLE_MAX_TOKENS)

  // ── Prompt audit file ──
  const transcriptInputDesc = useDirectTranscript
    ? `原始文本共 ${transcriptWithTime.length} 字符，未超过 ${TRANSCRIPT_DIRECT_THRESHOLD} 字符阈值，直接作为单块输入（未切块）。`
    : `原始文本按最多 ${MAX_CHARS_PER_REQUEST} 字符切块，共 ${chunks.length} 块。`

  const presetLabel = preset.label
  const presetInfo = analysisPreset === 'auto'
    ? [
        `- 预设请求：auto`,
        `- 实际使用：${resolvedId} (${presetLabel})`,
        `- 分类置信度：${classification ? Math.round(classification.confidence * 100) + '%' : 'N/A'}`,
        `- 分类理由：${classification?.reason || 'N/A'}`,
        ...(classification?.secondaryTypes?.length ? [`- 次要类型：${classification.secondaryTypes.join(', ')}`] : [])
      ]
    : [`- 预设请求：${analysisPreset}（用户手动选择）`, `- 实际使用：${resolvedId} (${presetLabel})`]

  const prompt = [
    '# LLM 分析 Prompt 与规则',
    '',
    '## 分析预设',
    ...presetInfo,
    '',
    '## 字数控制',
    `- ${wordCountGuidance}`,
    '',
    '## 输入组织方式',
    '',
    transcriptInputDesc,
    '- 阶段 1：每个切块先让 LLM 做结构化素材提取（按预设标记体系标注内容类型 + 事实观点拆分 + 修辞分析 + 广告过滤）。',
    '- 阶段 2：合并所有笔记，让 LLM 写成深度分析文章（含按预设大纲组织的章节）。',
    '- 若转录带时间戳，输入格式为 `[mm:ss] 文本`；已有纯文本分析会按段落生成粗略时间戳。',
    '- 文章生成阶段 max_tokens 设为 16384（比通用调用的 8192 更大，确保长文不被截断）。',
    '',
    '## 广告/赞助过滤规则',
    '',
    '- 在笔记提取阶段即识别并排除：带货文案、商品推广、课程推销、评论区链接、赞助口播、合作推广等。',
    '- 识别标志：语气突变（从内容分析转为推销）、链接/二维码提及、价格信息、限时优惠等促销语言。',
    '- 过滤后的广告内容不进入最终文章。',
    '',
    '## 跨块连续性',
    '- 转录文本较长时按最多 8000 字符切块，每个 chunk 含位置标记 [Chunk N/M: ...]。',
    '- 文章合成时提示注意跨块连续性：论证主线、人物故事、因果链条可能跨越多块。',
    '',
    '## 笔记提取 System Prompt',
    '',
    '```text',
    noteSystemPrompt,
    '```',
    '',
    '## 笔记提取 User Prompt 模板',
    '',
    '```text',
    noteUserPrompt.replace(noteUserPrompt.indexOf('文本：') >= 0 ? noteUserPrompt.slice(noteUserPrompt.indexOf('文本：')) : '', '[这里填入每个切块的原文 + Chunk 标记]'),
    '```',
    '',
    '## 最终文章 System Prompt',
    '',
    '```text',
    finalSystemPrompt,
    '```',
    '',
    '## 最终文章 User Prompt 模板',
    '',
    '```text',
    finalUserPrompt.replace(notesText, '[这里填入每个切块生成的分析笔记]'),
    '```'
  ].join('\n')

  return { markdown: markdown.trim(), prompt, preset: resolvedId, classification }
}

// ── Stage 0: Content Classification ──

const FALLBACK_CLASSIFICATION: ContentClassification = {
  type: 'generic',
  confidence: 0,
  reason: 'Classification failed or returned invalid JSON',
  recommendedPreset: 'generic'
}

export async function classifyContentType(
  title: string,
  url: string,
  transcriptText: string,
  options: AnalyzerOptions = {}
): Promise<ContentClassification> {
  const excerpt = transcriptText.slice(0, 6000)
  const { system, user } = buildClassificationPrompt(title, url, excerpt)

  try {
    const response = await callLLM(system, user, options, 512)
    const parsed = extractJson<ContentClassification>(response, FALLBACK_CLASSIFICATION)
    if (!parsed || !parsed.type) return FALLBACK_CLASSIFICATION
    // Ensure recommendedPreset is set
    if (!parsed.recommendedPreset) {
      parsed.recommendedPreset = parsed.type === 'auto' ? 'generic' : parsed.type as Exclude<AnalysisPreset, 'auto'>
    }
    return parsed
  } catch {
    return FALLBACK_CLASSIFICATION
  }
}

export async function askQuestion(
  question: string,
  transcriptText: string,
  segments: TranscriptSegment[],
  options: AnalyzerOptions = {}
): Promise<QAResponse> {
  const compactSegments = segments
    .slice(0, 300)
    .map((s) => `[${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`)
    .join('\n')

  const systemPrompt = [
    'Answer questions about the video transcript.',
    'Return only JSON: {"answer":"...", "references":[{"startTime":0,"endTime":0,"text":"..."}]}.',
    'Cite only transcript segments that directly support the answer.'
  ].join('\n')

  const response = await callLLM(
    systemPrompt,
    `Question: ${question}\n\nTranscript:\n${chunkText(compactSegments || transcriptText, 12000)[0]}`,
    options
  )

  return extractJson<QAResponse>(response, { answer: response.trim(), references: [] })
}

function normalizeKeyPoint(value: any): KeyPoint | null {
  if (!value || typeof value !== 'object') return null
  const title = String(value.title || '').trim()
  const description = String(value.description || '').trim()
  if (!title || !description) return null

  const timestamp = Number(value.timestamp || 0)
  const importance = Math.min(5, Math.max(1, Number(value.importance || 3))) as 1 | 2 | 3 | 4 | 5
  return { title, description, timestamp: Number.isFinite(timestamp) ? timestamp : 0, importance }
}

function normalizeMindMap(node: any): MindMapNode {
  const topic = String(node?.topic || '视频内容').trim().slice(0, 40) || '视频内容'
  const children = Array.isArray(node?.children)
    ? node.children.slice(0, 8).map(normalizeMindMap)
    : []
  return { topic, children }
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
