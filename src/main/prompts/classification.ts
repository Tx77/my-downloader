/**
 * Stage 0 内容分类 prompt 构建
 *
 * 输入: title, url, 转录前 6000 字符
 * 输出: JSON { type, confidence, reason, secondaryTypes, recommendedPreset }
 * max_tokens: 512
 */

export function buildClassificationPrompt(
  title: string,
  url: string,
  excerpt: string
): { system: string; user: string } {
  const system = [
    'You classify video transcripts for downstream prompt routing.',
    'Return JSON only. Do not summarize the video. Do not invent facts.',
    'Your only job is to determine the primary content type of this transcript.'
  ].join('\n')

  const user = [
    'Classify this video transcript into exactly one primary type and optional secondary types.',
    '',
    'Allowed primary types:',
    '- news: news reports, documentaries, event tracking, public affairs',
    '- knowledge: courses, explainers, lectures, educational content',
    '- opinion: commentary, argument, editorial, business/social/political analysis',
    '- interview: interviews, podcasts, roundtables, multi-speaker discussion',
    '- tutorial: technical tutorials, operational guides, tool demos, step-by-step teaching',
    '- generic: unclear, mixed, entertainment, vlog, or not enough signal',
    '',
    'Return JSON with:',
    '{',
    '  "type": "news|knowledge|opinion|interview|tutorial|generic",',
    '  "confidence": 0.0-1.0,',
    '  "reason": "short reason in Chinese",',
    '  "secondaryTypes": ["optional secondary type"],',
    '  "recommendedPreset": "news|knowledge|opinion|interview|tutorial|generic"',
    '}',
    '',
    'Classification guidelines:',
    '- Prefer interview when the structure is mainly question-answer or multi-speaker exchange.',
    '- Prefer tutorial when the transcript contains operational steps, commands, configurations, or verification.',
    '- Prefer news when the transcript centers on an event, timeline, institutions, public claims, or source reliability.',
    '- Prefer opinion when the transcript centers on a thesis, argument, interpretation, or persuasion.',
    '- Prefer knowledge when the transcript teaches concepts without step-by-step operation.',
    '- Use generic when the type is genuinely unclear or confidence is low.',
    '',
    `Title: ${title || '(no title)'}`,
    `URL: ${url || '(no URL)'}`,
    'Transcript excerpt:',
    excerpt
  ].join('\n')

  return { system, user }
}
