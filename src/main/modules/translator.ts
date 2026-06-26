/**
 * 段落翻译模块 — 使用 LLM 将转录段落翻译为目标语言
 *
 * 设计原则:
 * - 翻译失败不阻塞分析流水线（上层 catch 后 graceful degrade）
 * - 单次 LLM 调用翻译所有段落（减少延迟）
 * - Prompt 强调保真度：语气、修辞、专有名词不翻译
 */

import type { TranscriptParagraph } from './transcriber'
import { callLLM, extractJson, type AnalyzerOptions } from './content-analyzer'

export interface TranslationOptions extends AnalyzerOptions {
  sourceLanguage: string
  targetLanguage: string
}

export interface TranslationResult {
  translations: string[]
  processingTimeMs: number
}

/**
 * 将段落数组翻译为目标语言。
 *
 * 所有段落合为一次 LLM 调用，返回 JSON 字符串数组。
 * 用 context paragraph (前一段) 提供跨段连贯性。
 */
export async function translateParagraphs(
  paragraphs: TranscriptParagraph[],
  options: TranslationOptions
): Promise<TranslationResult> {
  const { sourceLanguage, targetLanguage } = options
  const startTime = Date.now()

  if (!paragraphs.length) {
    return { translations: [], processingTimeMs: 0 }
  }

  // Build numbered paragraph list with optional context
  const items: string[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    const ctx = i > 0 ? `(context: ${paragraphs[i - 1].text.slice(0, 200)})\n` : ''
    items.push(`${ctx}${i + 1}: ${paragraphs[i].text}`)
  }

  const systemPrompt = [
    `You are a professional translator. Translate the following numbered transcript paragraphs from ${sourceLanguage} to ${targetLanguage}.`,
    '',
    'Rules:',
    '- Preserve the original meaning, tone, and rhetorical style.',
    '- Keep proper names, brand names, and technical terms unchanged.',
    '- For idioms or culture-specific references, use the closest natural equivalent in the target language.',
    '- If a paragraph contains numbers, dates, or amounts, reproduce them exactly.',
    '- Maintain the paragraph structure — output exactly the same number of translations as input.',
    '- If a paragraph is already mostly in the target language, return it as-is (do not double-translate).',
    '',
    `Return ONLY a JSON array of strings: ["translated paragraph 1", "translated paragraph 2", ...]`,
    'No markdown fences, no commentary, no numbering. Pure JSON array.'
  ].join('\n')

  const userPrompt = [
    `Translate the following ${paragraphs.length} paragraphs from ${sourceLanguage} to ${targetLanguage}.`,
    'Each paragraph is numbered. The optional "(context: ...)" line is the preceding paragraph — use it for coherence but do NOT include it in the output.',
    '',
    items.join('\n\n')
  ].join('\n')

  const raw = await callLLM(systemPrompt, userPrompt, options, 8192)

  // Parse JSON array from response
  const translations = extractJson<string[]>(raw, [])

  if (!Array.isArray(translations) || translations.length === 0) {
    throw new Error(
      `Translation response could not be parsed as JSON array. ` +
      `Expected ${paragraphs.length} items, got: ${raw.slice(0, 200)}`
    )
  }

  // Pad or trim to match paragraph count
  while (translations.length < paragraphs.length) {
    translations.push(paragraphs[translations.length].text)
  }

  return {
    translations: translations.slice(0, paragraphs.length),
    processingTimeMs: Date.now() - startTime
  }
}
