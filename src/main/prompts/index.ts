/**
 * Prompt Preset Router — 聚合 + Prompt Builder
 *
 * 用法:
 *   import { getPreset, buildChunkNotesPrompt, buildArticlePrompt, getWordCountRange } from '../prompts'
 */

import type { AnalysisPreset, ContentClassification, PromptPresetDefinition } from '../modules/content-analyzer'
import { COMMON_SYSTEM_RULES, COMMON_NOTE_TASK } from './common'
import { newsPreset } from './presets/news'
import { knowledgePreset } from './presets/knowledge'
import { opinionPreset } from './presets/opinion'
import { interviewPreset } from './presets/interview'
import { tutorialPreset } from './presets/tutorial'
import { genericPreset } from './presets/generic'

// ── Re-export ──
export { getWordCountRange, formatWordCountGuidance, COMMON_SYSTEM_RULES, COMMON_NOTE_TASK } from './common'
export { buildClassificationPrompt } from './classification'
export { newsPreset } from './presets/news'
export { knowledgePreset } from './presets/knowledge'
export { opinionPreset } from './presets/opinion'
export { interviewPreset } from './presets/interview'
export { tutorialPreset } from './presets/tutorial'
export { genericPreset } from './presets/generic'

// ── Preset registry ──

const PRESETS: Record<Exclude<AnalysisPreset, 'auto'>, PromptPresetDefinition> = {
  news: newsPreset,
  knowledge: knowledgePreset,
  opinion: opinionPreset,
  interview: interviewPreset,
  tutorial: tutorialPreset,
  generic: genericPreset
}

export function getPreset(id: Exclude<AnalysisPreset, 'auto'>): PromptPresetDefinition {
  return PRESETS[id]
}

// ── Prompt builders ──

/**
 * 构建 Stage 1 chunk 笔记提取的 system + user prompt
 * 组合公共规则 + preset 特定标记体系
 */
export function buildChunkNotesPrompt(preset: PromptPresetDefinition): {
  system: string
  user: string
} {
  return {
    system: [COMMON_SYSTEM_RULES, '', preset.qualityRules].join('\n'),
    user: [
      COMMON_NOTE_TASK,
      '',
      '─── 本内容类型的分析标记体系 ───',
      '',
      preset.notesSchema,
      '',
      '文本：'
    ].join('\n')
  }
}

/**
 * 构建 Stage 2 最终文章合成的 system + user prompt
 * 组合公共写作规则 + preset 特定大纲 + 动态字数 + 分类上下文
 */
export function buildArticlePrompt(
  preset: PromptPresetDefinition,
  title: string,
  notesText: string,
  wordCountGuidance: string,
  classification?: ContentClassification
): {
  system: string
  user: string
} {
  const system = [
    '你是一位资深编辑和深度内容分析师。',
    '你的任务是基于分析笔记写一篇**深度分析文章**（不是短摘要，不是 JSON）。',
    '输入笔记可能是从任何语言的原文中提取的；你的文章输出必须使用中文。',
    '',
    '写作要求：',
    '- 不要暴露技术细节（不提 chunk/notes/LLM/prompt/模型）。',
    '- 严格基于提供的笔记素材写作，不编造外部信息。',
    '- 对笔记中标记了 [FC-未给来源] 的内容，必须写明"原文引用了此数据但未给出可核查来源"。',
    '- 对笔记中标记了 [OP] 的内容，用"作者认为/作者声称/作者判断"来表述。',
    `- ${wordCountGuidance}`,
    '- 分析"论证链条"而非"时间线"：前提 → 证据 → 推理 → 结论 → 隐含意义。',
    '- 如果是叙事型内容（讲故事而非论证），分析其叙事策略而非强行套论证框架。',
    '- 使用清晰的中文 Markdown。',
    '',
    preset.qualityRules,
    '',
    '跨块连续性提示：',
    '这些笔记是从转录文本的连续片段中提取的。请注意跨块连续性——论证主线、人物故事、因果链条可能跨越多块。不要将各块的分析当作独立章节，而应建立整体视角。'
  ].join('\n')

  const classificationNote = classification
    ? [
        '',
        '─── 内容分类信息 ───',
        `分类类型：${preset.label}（置信度 ${Math.round(classification.confidence * 100)}%）`,
        ...(classification.secondaryTypes?.length
          ? [`次要类型：${classification.secondaryTypes.join(', ')}`, '请在主分类分析框架中适当融入次要类型的分析视角。']
          : []),
        `分类理由：${classification.reason}`
      ].join('\n')
    : ''

  const user = [
    `标题：${title}`,
    '',
    '请写一篇深度内容分析文章。原文可能是中文、英文或其他语言——素材笔记中引用的原文片段可能混有多种语言。你的文章输出必须全部用中文。',
    `严格按以下结构（每个章节都必须有充分内容，不要只写一两行）：`,
    '',
    preset.articleOutline,
    '',
    '以下是从原文提取的分析笔记，请基于这些素材写作。笔记中已用标记标注了内容类型，已在笔记层面排除了广告/推广内容：',
    classificationNote,
    '',
    notesText
  ].join('\n')

  return { system, user }
}
