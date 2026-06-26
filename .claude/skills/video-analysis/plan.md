# 视频内容分析工具 — 技术方案

> **更新**: 2026-06-26
> **当前阶段**: Phase 1 ✅ | Phase 2 ✅ | Phase 2.5 ✅ | Phase 3 ✅ | Phase 3.5 📋

## 实现状态

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 音频提取 + ASR 转录 + GPU 加速 + 分析面板 | ✅ 完成 |
| Phase 2 | LLM 深度内容分析 (文章/可信度评分/广告过滤) | ✅ 完成 |
| Phase 2.5 | Prompt Preset Router (内容分类 + 6 套预设 + 动态字数) | ✅ 完成 |
| Phase 3 | OCR 硬字幕提取 (RapidOCR + DirectML GPU) | ✅ 完成 |
| Phase 3.5 | ASR + OCR 交叉验证 | 📋 设计中 |
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

## Phase 3: OCR 硬字幕提取 ✅

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

### 打包检查清单

每次打包前必须确认：

1. **升级版本号**: `package.json` 的 `version` 字段，按语义化版本 (本次: 1.1.0 → 1.2.0)
2. **更新 yt-dlp**: `./resources/bin/yt-dlp.exe -U`（YouTube 接口频繁变动，最好打包当天更新）
3. **模型部署路径**: `getModelDir()` 使用 `app.getPath('userData')`，此路径 = `%APPDATA%/{package.json name}/`。当前 name=`my-downloader`，所以模型必须放在 `%APPDATA%/my-downloader/whisper-models/`，**不是** `Downloader Pro/`
4. **model 类型一致性**: 改 model 列表时需同步更新 transcriber.ts、analysis-pipeline.ts、env.d.ts、preload/index.d.ts、VideoAnalysisPanel 五处

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

## Phase 3.6: CLI 日志与进度优化 ✅

### 问题

1. CLI 日志太稀疏 — 只在阶段切换和 25% 间隔记录，大量进度信息被丢弃
2. 进度条是假的 — 音频提取写死 50%，LLM 分析用回调计数冒充百分比
3. 报错信息不详细 — 子进程失败只显示退出码，不显示 stderr

### 目标

- CLI 日志每 ~10% 记录一次，每条带耗时
- 有真实进度源的用真实进度（下载百分比、转录百分比、音频提取 elapsed/duration），没有的用子任务计数
- 子进程错误消息包含 stderr tail（最后 300 字符）
- 不引入新的 logger 模块、log 文件、DiagnosticError 类型——在现有框架内修

### 已做改动

**UI 端** (`VideoAnalysisPanel/index.tsx`):
- 25% 间隔 → 10% 间隔
- 每条日志带耗时 `(Xs)`
- 阶段切换全部记录，不丢消息

**Pipeline 端** (`analysis-pipeline.ts`):
- 音频提取: 写死 50% → `elapsed/duration` 实时百分比
- LLM 分析: 回调计数 → 按完成子任务数 / 总子任务数
- 视频信息: 只显标题 → 标题 + 时长(min) + 是否有字幕
- 下载错误: `退出码: 1` → `退出码: 1, {stderr tail}`

### 待做

- [ ] `decodeOutput` + `iconv-lite` 的 cp936 在部分 Windows 环境下仍可能出乱码，考虑 `chardet` 自动检测
- [ ] 已有文件夹分析路径的进度消息改进

---
## Phase 4: 优化 📋

- whisper-server 常驻模式 (见 `whisper-optimization.md`)
- 批量分析
- 跨视频问答/RAG
- 导出格式 (PDF/HTML)

