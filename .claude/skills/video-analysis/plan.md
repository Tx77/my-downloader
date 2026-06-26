# 视频内容分析工具 — 技术方案

> **更新**: 2026-06-26
> **当前阶段**: Phase 1 ✅ | Phase 2 ✅ | Phase 3 🔧

## 实现状态

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 音频提取 + ASR 转录 + GPU 加速 + 分析面板 | ✅ 完成 |
| Phase 2 | LLM 深度内容分析 (文章/可信度评分/广告过滤) | ✅ 完成 |
| Phase 3 | OCR 硬字幕提取 | 🔧 开发中 (RapidOCR + DirectML GPU) |
| Phase 4 | whisper-server 常驻 / 批量 / 问答增强 | 📋 待实现 |

---

## Phase 1: 转录生成 ✅

- ffmpeg 提取 16kHz 单声道 WAV
- whisper.cpp ASR, Vulkan GPU 加速 (7900XTX)
- 字幕优先策略: 外挂字幕 → ASR fallback
- 5 阶段进度 + 全进程追踪取消
- 输出: `{savePath}/article/{title}/` (transcript.txt, transcript.json, README.md)

## Phase 2: LLM 深度内容分析 ✅

### Providers
- DeepSeek (默认, api.deepseek.com)
- OpenAI-compatible (可配 endpoint)
- Codex CLI (本地子进程)

### 分析流程
1. **素材提取**: 转录按 8000 字符切块, 每块提取结构化笔记:
   - [FC] 可验证事实 / [OP] 观点 / [SP] 推测 / [RT] 修辞 / [FC-未给来源] 未给来源的引用
   - 广告/赞助内容在此阶段排除
2. **文章合成**: 合并笔记 → 生成 9 章深度分析文章 (max_tokens=8192)
3. **可信度五维评分**: 事实准确性 / 论证逻辑性 / 来源透明度 / 立场平衡度 / 修辞克制程度

### 输出
- `analysis.md` — 主阅读文件
- `analysis.prompt.md` — Prompt 审计 (含标记规则 + 广告过滤规则)
- `analysis.json` — 结构化缓存

### UI 改进
- 左侧 CLI 实时日志推送
- 统一顶层 Tab
- 完成提示紧凑化 + 文件路径可折叠

---

## Phase 3: OCR 硬字幕提取 🔧

### 实现状态 (2026-06-26)

**已实现**:
- OCR 策略选项已加入 UI（三选一：字幕优先 / 纯 ASR / OCR 硬字幕）
- ffmpeg 抽帧 + 纯 TypeScript pHash 去重（无外部依赖）
- RapidOCR Python 子进程（替换了原计划的 PaddleOCR）
- DirectML GPU 加速（通过 monkey-patch 强制开启）
- `cropBottom: true` 默认只识别画面底部 1/3
- 乱码过滤（URL、日期、社交账号、非中文片段）

**架构**:
```
下载视频 → ffmpeg fps=1 抽帧 → pHash 去重
→ RapidOCR (Python 子进程, stdin/stdout JSON 协议)
→ 合并时间轴 → 过滤非字幕文本 → 输出 transcript
→ Phase 2 LLM 分析 (复用)
```

### 当前问题 / Gotchas

1. **乱码**: Windows pipe 默认 GBK (cp936) 编码 → 已在 spawn 设 `PYTHONIOENCODING=utf-8` + worker 内 `sys.stdout.reconfigure(encoding='utf-8')`
2. **GPU 不工作**: RapidOCR 内部 `use_dml` 默认 false → 已 monkey-patch `ProviderConfig.is_dml_available()` 返回 True
3. **OCR 识别画面所有文字**: 不只字幕 → 已启用 `cropBottom: true` + 后置文本过滤器
4. **numpy 2.x 兼容**: `onnxruntime-directml` 需要 numpy<2 → 已降级
5. **速度慢**: DirectML 首帧 shader 编译 ~10-15s，后续帧秒级。ASR（whisper GPU）是一次性推理所以快，OCR 是 N 帧逐帧推理，本质不同

### 依赖
- Python 3.8+
- `pip install rapidocr onnxruntime-directml "numpy<2"`
- ffmpeg（已捆绑）

### 待解决
- DirectML GPU 占用率低（模型小、batch=1，GPU 利用率天然不如 ASR 大模型）
- 无硬字幕视频用 OCR 会产出噪音（需用户自行判断策略选择）
- 可考虑批量推理多帧提升 GPU 利用率

---

## Phase 3.5: ASR + OCR 交叉验证 📋

### 问题
纯 OCR 在纪录片/新闻类视频中噪音太大——画面里的日期、水印、社交账号、新闻标题等全被识别为"字幕"。即使 cropBottom + 文本过滤后，仍无法区分子幕与画面文字。但 ASR 准确度高（large-v3 在 7900XTX 上 ~20s/30min视频），只是无法捕获无声字幕。

### 方案: ASR 为主，OCR 为辅

```
用户选 "OCR 硬字幕" 策略
    ↓
同时启动两条管线:
    ├─ ASR: 下载视频 → 提取音频 → whisper large-v3 转录
    └─ OCR: ffmpeg 抽帧 → pHash 去重 → RapidOCR 识别
    ↓
交叉验证:
    对 OCR 的每个 segment，与 ASR segments 做滑动窗口语义比对
    ├─ 匹配 (相似度 > 阈值) → 高置信度，以 ASR 文本为准
    ├─ OCR 独有 → 丢弃（大概率画面噪音）
    └─ ASR 独有 → 保留（正常，不是所有字幕都在画面上）
    ↓
输出: 以 ASR 为主体的干净 transcript，OCR 验证标记
```

### 实现细节

**语义比对**: 不需要 LLM，用简单的文本相似度即可：
- 对 OCR segment 的文本，在 ASR 时间窗口 ±3s 内找匹配
- 相似度计算: Jaccard 相似度（字符级）或编辑距离
- 阈值可调，默认 0.5

**交互流程修改** (strategy = `'ocr'` 时):
```
当前: 只跑 OCR → transcript → LLM 分析
改为: 并行跑 ASR + OCR → 交叉比对 → 合并 transcript → LLM 分析
```

**进度条**: OCR 阶段新增子阶段 `cross-validating`，进度范围 70-90%

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/main/modules/analysis-pipeline.ts` | OCR 分支内改为并行启动 ASR+OCR，增加 `crossValidate()` 调用 |
| `src/main/modules/ocr-extractor.ts` | 无需改动（OCR 输出接口不变） |
| `src/main/modules/transcriber.ts` | 无需改动（ASR 接口不变） |

### 核心函数签名

```typescript
// 新增: 交叉验证函数 (放在 analysis-pipeline.ts 或新文件 cross-validator.ts)
function crossValidate(
  asrSegments: WhisperSegment[],
  ocrSegments: OcrSegment[],
  threshold: number = 0.5
): {
  merged: TranscriptSegment[]     // 以 ASR 为主的最终结果
  stats: {
    asrOnly: number               // 仅 ASR 有 (保留)
    ocrOnly: number               // 仅 OCR 有 (丢弃)
    matched: number               // 双源匹配 (高置信)
  }
}
```

### 预期效果
- 解决纯 OCR 噪音问题 → transcript 准确度接近纯 ASR
- OCR 发挥辅助作用 → 匹配到的片段标记为"双源验证"
- 用户无感知 → 策略仍叫 "OCR 硬字幕"，但实际内部是融合模式

### 验证方法
1. 对已知有硬字幕的视频运行 → transcript 应与 ASR 结果高度一致
2. 对纯旁白视频（无字幕）运行 → OCR 结果几乎全被丢弃，最终等同纯 ASR
3. 检查 stats 输出: `{asrOnly: 45, ocrOnly: 120, matched: 8}` → 说明 OCR 噪音多

---

## Phase 4: 优化 📋

- Prompt Preset Router: auto-classify transcript genre and route to genre-specific prompts/outlines. See `phase2-llm-analysis.md` section "Proposed: Prompt Preset Router".
- whisper-server 常驻模式 (见 `whisper-optimization.md`)
- 批量分析
- 跨视频问答/RAG
- 导出格式 (PDF/HTML)
