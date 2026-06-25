import { spawn, type ChildProcess } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'

export type LLMProvider = 'deepseek' | 'openai' | 'codex-cli'
export type AnalysisType = 'summary' | 'key-points' | 'mind-map'

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

async function callLLM(
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

  const response = await fetch(options.apiBase || config.endpoint, {
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
    })
  })

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

function chunkText(text: string, maxChars = MAX_CHARS_PER_REQUEST): string[] {
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + maxChars, text.length)
    const breakAt = text.lastIndexOf('\n', end)
    if (breakAt > cursor + maxChars * 0.5) end = breakAt
    chunks.push(text.slice(cursor, end).trim())
    cursor = end
  }
  return chunks.filter(Boolean)
}

function extractJson<T>(text: string, fallback: T): T {
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
  options: AnalyzerOptions = {}
): Promise<ArticleAnalysisResult> {
  options.onProgress?.('Writing readable analysis article...')

  const transcriptWithTime = segments.length
    ? segments.map((s) => `[${formatTime(s.start)}] ${s.text}`).join('\n')
    : text

  // 如果总长度不大，直接使用全文；否则切块处理
  const TRANSCRIPT_DIRECT_THRESHOLD = 24000
  const useDirectTranscript = transcriptWithTime.length <= TRANSCRIPT_DIRECT_THRESHOLD
  const chunks = useDirectTranscript ? [transcriptWithTime] : chunkText(transcriptWithTime, MAX_CHARS_PER_REQUEST)

  // ── Note extraction (per chunk) ──
  const noteSystemPrompt = [
    '你是一位资深深度阅读分析师。你的任务是从原始文本中为一篇深度分析文章提取结构化素材。',
    '输入可能是中文、英文、日文或任何语言；你的分析和笔记输出必须使用中文。',
    '',
    '核心原则：',
    '- 只基于原文，不编造任何外部信息。原文中没有的内容坚决不写。',
    '- 区分以下三类内容：①可验证的事实陈述 ②作者的观点/判断/解读 ③广告/带货/赞助推广',
    '- 凡属于第③类（广告），直接忽略，不提取任何素材。',
    '',
    '素材提取规则：',
    '- 保留具体数字、机构名、人名、地名、年份、金额、比率——这些是文章的说服力来源。引用原文中的数值时保留原始语言和单位。',
    '- 对每个主张标注可信度标记：',
    '  [FC] 可验证的事实陈述（Factual Claim）',
    '  [OP] 作者的纯观点/判断（Opinion）',
    '  [SP] 推测/预测（Speculation）',
    '  [RT] 修辞手法/情绪表达（Rhetorical Technique）',
    '- 如果作者引用了第三方数据但没有给出来源，标注为”[FC-未给来源]”。',
    '- 如果有因果链条，用”→”写清：背景 → 机制 → 后果 → 作者结论。',
    '- 保留值得引用的原文片段（50词/字以内），标记其修辞功能。引用时保留原始语言，但在括号中附中文翻译。',
    '- 识别文本的语气和表达策略（科普/讽刺/煽情/数据轰炸/诉诸权威/类比/偷换概念等）。',
    '- 分析笔记全部用中文输出。'
  ].join('\n')

  const noteUserPrompt = [
    '请从以下文本中提取**详细**的结构化分析笔记。后续需要用这些素材写一篇深度分析文章——保留越丰富的细节越好。',
    '',
    '注意：如果文本末尾或中间出现带货/赞助/推广内容（如”点击链接购买””评论区下单””我的课程””合作推广”等），请完全忽略，不要提取。',
    '',
    '请按以下结构输出：',
    '',
    '### 本段核心内容（3-5 句完整段落）',
    '概括这段在说什么，并标注主要属于[FC]事实陈述还是[OP]观点论证。',
    '',
    '### 关键事实、数字与案例',
    '| 标记 | 具体内容 | 在论证中的作用 | 可信度评估 |',
    '| --- | --- | --- | --- |',
    '每行标记 [FC]/[OP]/[SP]/[RT]，并评估可信度：高/中/低/无法判断。',
    '',
    '### 论证/叙事结构',
    '用箭头描述：原文先说什么 → 然后引出什么 → 用什么支撑 → 推向什么结论。如果是叙事型内容（讲故事而非论证），描述叙事弧线。',
    '',
    '### 措辞与修辞分析',
    '摘录 3-5 处有代表性的表述，分析其修辞功能（如”用类比让复杂问题简单化””用夸张数字制造震撼感””用社区黑话拉近与读者距离”）。',
    '',
    '### 事实 vs 观点拆分',
    '| 原文说法（短摘）| 归类 | 判断依据 |',
    '| --- | --- | --- |',
    '归类选项：可验证事实 / 作者个人判断 / 未经证实的声称 / 情绪宣泄 / 广告推广',
    '',
    '文本：'
  ].join('\n')

  const notes: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    options.onProgress?.(`Writing article notes ${i + 1}/${chunks.length}...`)
    notes.push(await callLLM(noteSystemPrompt, `${noteUserPrompt}\n\n${chunks[i]}`, options))
  }

  // ── Final article generation ──
  const ARTICLE_MAX_TOKENS = 16384

  const finalSystemPrompt = [
    '你是一位资深编辑和深度内容分析师。',
    '你的任务是基于分析笔记写一篇**深度分析文章**（不是短摘要，不是 JSON）。',
    '输入笔记可能是从任何语言的原文中提取的；你的文章输出必须使用中文。',
    '',
    '写作要求：',
    '- 不要暴露技术细节（不提 chunk/notes/LLM/prompt/模型）。',
    '- 严格基于提供的笔记素材写作，不编造外部信息。',
    '- 对笔记中标记了 [FC-未给来源] 的内容，必须写明”原文引用了此数据但未给出可核查来源”。',
    '- 对笔记中标记了 [OP] 的内容，用”作者认为/作者声称/作者判断”来表述。',
    '- 正文建议 1800–2500 中文字（素材支持的话），每个章节都要有实质内容。',
    '- 引用原文的具体数字、人名、案例来支撑分析。引用非中文原文时给出中文翻译，必要时保留原文措辞。',
    '- 分析”论证链条”而非”时间线”：前提 → 证据 → 推理 → 结论 → 隐含意义。',
    '- 如果是叙事型内容（讲故事而非论证），分析其叙事策略而非强行套论证框架。',
    '- 使用清晰的中文 Markdown。'
  ].join('\n')

  const finalUserPrompt = [
    `标题：${title}`,
    '',
    '请写一篇深度内容分析文章。原文可能是中文、英文或其他语言——素材笔记中引用的原文片段可能混有多种语言。你的文章输出必须全部用中文。',
    '严格按以下结构（每个章节都必须有充分内容，不要只写一两行）：',
    '',
    '# {标题}｜深度分析',
    '',
    '## 一句话结论',
    '3-5 句话概括原文的核心判断。如果是论证型内容，写出中心论点；如果是叙事型，写出它通过什么故事让读者产生什么感受/认知。',
    '',
    '## 内容概览',
    '展开写（不少于 200 字）：主题、背景、涉及的主要对象、核心冲突或问题。读者看完这节应该能判断这篇文章与自己是否相关。',
    '',
    '## 论证/叙事主线',
    '这是文章最核心的章节。如果是论证型：按”前提 → 证据 → 推理 → 结论 → 隐含主张”展开，每步引用原文的具体说法。如果是叙事型：分析叙事弧线（铺垫→冲突→高潮→收尾），解释作者在每个阶段如何引导读者情绪。',
    '',
    '## 关键事实、数字与案例',
    '| 标记 | 内容 | 在论证/叙事中的作用 | 可信度 |',
    '| --- | --- | --- | --- |',
    '每行引用一个具体的事实/数字/案例，标注可信度标记 [FC]/[FC-未给来源]/[SP] 等，并说明它服务于什么目的（建立可信度/煽动情绪/制造对比/等）。',
    '',
    '## 事实与观点拆分',
    '| 原文说法 | 归类 | 分析 |',
    '| --- | --- | --- |',
    '对 8-15 个有代表性的原文说法做归类：可验证事实 / 作者判断 / 未经证实的声称 / 隐喻或修辞。分析栏写你如此归类的理由。',
    '',
    '## 作者的立场、情绪与表达策略',
    '分析作者如何影响读者：语气（科普/愤慨/讽刺/戏谑/中立）、修辞手法（数据轰炸/情感叙事/权威引述/类比/偷换概念/诉诸恐惧/制造焦虑等）、与目标读者的关系构建（社区黑话/内梗/人称使用等）。注意不要将作者的立场包装成客观事实。',
    '',
    '## 可信度与论证质量评估',
    '从以下维度给出 1-5 星评价并各写一句理由：',
    '- 事实准确性',
    '- 论证逻辑性',
    '- 信息来源透明度',
    '- 立场平衡度',
    '- 修辞克制程度',
    '总结：这篇内容的整体可信度如何？读者应该带着怎样的警觉度来阅读？',
    '',
    '## 可以追问的问题',
    '4-8 个值得进一步核实或思考的问题。每个问题说明追问理由。',
    '',
    '## 速读版',
    '6-12 条 bullet，每条一句话，覆盖全文关键信息。',
    '',
    '以下是从原文提取的分析笔记，请基于这些素材写作。笔记中已用 [FC]/[OP]/[SP]/[RT] 标记了内容类型，已在笔记层面排除了广告/推广内容：',
    '',
    notes.join('\n\n---\n\n')
  ].join('\n')

  const markdown = await callLLM(finalSystemPrompt, finalUserPrompt, options, ARTICLE_MAX_TOKENS)

  // ── Prompt audit file ──
  const transcriptInputDesc = useDirectTranscript
    ? `原始文本共 ${transcriptWithTime.length} 字符，未超过 ${TRANSCRIPT_DIRECT_THRESHOLD} 字符阈值，直接作为单块输入（未切块）。`
    : `原始文本按最多 ${MAX_CHARS_PER_REQUEST} 字符切块，共 ${chunks.length} 块。`

  const prompt = [
    '# LLM 分析 Prompt 与规则',
    '',
    '## 输入组织方式',
    '',
    transcriptInputDesc,
    '- 阶段 1：每个切块先让 LLM 做”结构化素材提取”（含 [FC]/[OP]/[SP]/[RT] 可信度标记 + 事实观点拆分 + 修辞分析 + 广告过滤）。',
    '- 阶段 2：合并所有笔记，让 LLM 写成深度分析文章（含可信度评分）。',
    '- 若转录带时间戳，输入格式为 `[mm:ss] 文本`；已有纯文本分析会按段落生成粗略时间戳。',
    '- 文章生成阶段 max_tokens 设为 16384（比通用调用的 8192 更大，确保长文不被截断）。',
    '',
    '## 广告/赞助过滤规则',
    '',
    '- 在笔记提取阶段即识别并排除：带货文案、商品推广、课程推销、”评论区链接”、赞助口播、合作推广等。',
    '- 识别标志：语气突变（从内容分析转为推销）、链接/二维码提及、价格信息、”限时优惠”等促销语言。',
    '- 过滤后的广告内容不进入最终文章。',
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
    noteUserPrompt,
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
    finalUserPrompt.replace(notes.join('\n\n---\n\n'), '[这里填入每个切块生成的分析笔记]'),
    '```'
  ].join('\n')

  return { markdown: markdown.trim(), prompt }
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
