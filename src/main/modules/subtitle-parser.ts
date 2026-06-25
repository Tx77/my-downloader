import { ipcMain } from 'electron'
import * as fs from 'fs/promises'
import iconv from 'iconv-lite'

interface SubtitleSegment {
  id: string
  index: number
  startTime: number
  endTime: number
  text: string
  speaker?: string
  speakerSource?: 'detected' | 'manual' | 'ai' | 'unknown'
}

function decodeSubtitle(buf: Buffer): string {
  const utf8 = buf.toString('utf8').replace(/^\uFEFF/, '')
  const badChars = (utf8.match(/\uFFFD/g) || []).length
  if (badChars > 2 && process.platform === 'win32') {
    return iconv.decode(buf, 'cp936').replace(/^\uFEFF/, '')
  }
  return utf8
}

function parseTime(value: string): number {
  const normalized = value.trim().replace(',', '.')
  const match = normalized.match(/(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
  if (!match) return 0

  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  const millis = Number((match[4] || '0').padEnd(3, '0').slice(0, 3))

  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

function detectSpeaker(
  text: string
): { text: string; speaker?: string; speakerSource: 'detected' | 'unknown' } {
  const clean = text.replace(/\s+/g, ' ').trim()
  const patterns = [
    /^【([^】]{1,24})】\s*(.+)$/,
    /^\[([^\]]{1,24})\]\s*(.+)$/,
    /^>>\s*([^:：]{1,30})[:：]\s*(.+)$/,
    /^([^:：\n]{1,24})[:：]\s*(.+)$/
  ]

  for (const pattern of patterns) {
    const match = clean.match(pattern)
    if (!match) continue

    const speaker = match[1].trim()
    const rest = match[2].trim()
    if (!speaker || !rest) continue

    return { speaker, text: rest, speakerSource: 'detected' as const }
  }

  return { text: clean, speakerSource: 'unknown' as const }
}

function makeSegment(index: number, startTime: number, endTime: number, text: string): SubtitleSegment {
  const detected = detectSpeaker(text)
  return {
    id: `${index}-${startTime}-${endTime}`,
    index,
    startTime,
    endTime,
    text: detected.text,
    speaker: detected.speaker,
    speakerSource: detected.speakerSource
  }
}

function parseSrt(content: string): SubtitleSegment[] {
  const blocks = content
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  const segments: SubtitleSegment[] = []

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue

    const index = Number(lines[0]) || segments.length + 1
    const [start, end] = lines[timeIndex].split('-->').map((part) => part.trim().split(/\s+/)[0])
    const text = lines.slice(timeIndex + 1).join(' ').trim()
    if (!text) continue

    segments.push(makeSegment(index, parseTime(start), parseTime(end), text))
  }

  return segments
}

function parseVtt(content: string): SubtitleSegment[] {
  const withoutHeader = content
    .replace(/^\uFEFF?WEBVTT[^\n]*(?:\n|$)/, '')
    .replace(/\r/g, '')

  const blocks = withoutHeader
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  const segments: SubtitleSegment[] = []

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^NOTE\b/.test(line))
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue

    const [start, end] = lines[timeIndex].split('-->').map((part) => part.trim().split(/\s+/)[0])
    const text = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (!text) continue

    segments.push(makeSegment(segments.length + 1, parseTime(start), parseTime(end), text))
  }

  return segments
}

export function setupSubtitleParserHandlers(): void {
  ipcMain.handle('parse-subtitle-file', async (_event, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') return []

    const buf = await fs.readFile(filePath)
    const content = decodeSubtitle(buf)
    const lower = filePath.toLowerCase()

    if (lower.endsWith('.vtt')) return parseVtt(content)
    return parseSrt(content)
  })
}
