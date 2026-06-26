# Downloader Pro — 项目总览

## 技术栈
- **框架**: Electron 39 + React 19 + TypeScript 5 + Vite 7
- **包管理**: pnpm
- **构建**: electron-vite + electron-builder
- **核心二进制**: yt-dlp.exe, ffmpeg.exe, ffprobe.exe, whisper-cli.exe (bundled in `resources/bin/`)
- **Python 依赖**: rapidocr, onnxruntime-directml, numpy<2 (OCR 模块)

## 项目结构
```
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # 入口: 窗口创建 + 模块初始化
│   └── modules/
│       ├── download.ts            # 下载引擎 (yt-dlp 子进程管理) — DO NOT TOUCH
│       ├── subtitle-parser.ts     # SRT/VTT 解析 — DO NOT TOUCH
│       ├── ipc.ts                 # IPC 处理器 (解析URL/文件/登录/文件夹选择)
│       ├── cookie.ts              # B站 Cookie 管理 — DO NOT TOUCH
│       ├── utils.ts               # 二进制路径/代理配置 — DO NOT TOUCH
│       ├── audio-extractor.ts     # ffmpeg 音频提取 (16kHz WAV)
│       ├── transcriber.ts         # whisper.cpp ASR (Vulkan GPU)
│       ├── ocr-extractor.ts       # [NEW] OCR 硬字幕提取 (RapidOCR + DirectML)
│       ├── content-analyzer.ts    # LLM 分析 (Prompt/Preset路由/文章生成)
│       └── analysis-pipeline.ts   # 分析流水线编排 (URL+已有文本+OCR)
├── prompts/                       # [NEW] Prompt 预设定义
│   ├── common.ts                  #   公共规则 + 动态字数函数
│   ├── classification.ts          #   Stage 0 内容分类 prompt
│   ├── index.ts                   #   聚合 + buildChunkNotesPrompt/buildArticlePrompt
│   └── presets/                   #   6 套预设 (news/knowledge/opinion/interview/tutorial/generic)
├── preload/
│   └── index.ts                   # contextBridge API
└── renderer/
    └── src/
        ├── App.tsx                # 主界面 (下载/访谈/视频分析)
        ├── env.d.ts               # 渲染进程类型声明 (新 API 类型加这里!)
        └── components/
            ├── VideoAnalysisPanel/ # 视频分析面板 (URL分析+已有文本+LLM设置+策略选择)
            ├── AnalysisResultCard/ # 分析结果子组件 (摘要/要点/思维导图)
            └── ...
resources/
├── bin/                           # 二进制 (whisper-cli, ffmpeg, yt-dlp)
│   └── models/                    # Whisper 模型 (large-v3 ~3GB, medium ~1.5GB)
└── ocr/
    └── ocr_worker.py              # [NEW] RapidOCR Python worker (stdin/stdout JSON)
```

## 已实现功能

### 下载模块 (稳定)
- B站/YouTube 视频/音频下载
- 外挂字幕下载 (手动/自动, SRT/VTT)
- B站 Cookie 登录
- 并发下载控制 (1-10)
- 下载后打开文件夹/删除本地文件

### 视频分析模块

**Phase 1 — 转录生成 ✅:**
- ffmpeg 提取 16kHz 单声道 WAV
- whisper.cpp ASR, Vulkan GPU 加速 (AMD 7900XTX)
- 支持模型: large-v3 (最准 ~3GB), medium (~1.5GB)
- 策略: subtitle-first (优先外挂字幕, 否则下载+ASR)
- 5 阶段进度: 获取信息→下载→提取音频→转录→分析
- 全进程追踪取消 (yt-dlp + ffmpeg + whisper, 无孤儿进程)
- 输出: `{savePath}/article/{title}/` (transcript.txt / transcript.json / README.md / analysis.md / analysis.prompt.md / analysis.json)

**Phase 2 — LLM 深度分析 ✅:**
- Provider: DeepSeek (默认), OpenAI-compatible, Codex CLI
- 两阶段分析: 先按 chunk 提取结构化素材 ([FC]/[OP]/[SP]/[RT] 标记), 再合成深度文章
- 广告/赞助内容自动过滤
- 文章含: 结论/内容概览/论证主线/事实数字表/事实观点拆分/修辞分析/可信度五维评分/追问/速读
- 输出: analysis.md (主阅读文件), analysis.prompt.md (Prompt 审计), analysis.json (结构化缓存)

**Phase 2.5 — Prompt Preset Router ✅ (新增):**
- 内容分类 (Stage 0): LLM 用 title+URL+前6000字符分类 (news/knowledge/opinion/interview/tutorial/generic)
- 6 套预设: 每种内容类型有独立的笔记标记体系和文章大纲
- 动态字数: 根据转录长度自动调整输出区间 (600-8000字, 3档)
- 跨块上下文桥接: chunk marker + synthesis 提示确保连续内容不丢失
- UI: LLM设置面板内"分析类型"下拉框, 默认"自动识别"
- 代码: `src/main/prompts/` (common.ts + classification.ts + presets/*.ts + index.ts)

**Phase 3 — OCR 硬字幕提取 ✅:**
- 引擎: RapidOCR v3 (ONNX Runtime + DirectML)
- 流程: ffmpeg 抽帧(fps=1, cropBottom=底部1/3) → pHash 去重(纯TS实现) → 批量 JSON 协议发 Python worker → 文本过滤 → 时间轴合并
- GPU: DirectML 供 AMD 7900XTX, 需 monkey-patch RapidOCR 的 `is_dml_available()`
- 进度: 7 阶段 (抽帧→去重→加载→识别→合并→过滤→完成)
- 已知限制: 新闻/纪录片类视频画面文字多，非字幕文本干扰大；GPU 利用率低(模型小)
- 依赖: `pip install rapidocr onnxruntime-directml "numpy<2"`

## 关键架构模式
- **二进制执行**: `spawn(getBinaryPath('tool'), args)` — 统一模式
- **IPC**: `ipcMain.handle` (请求-响应) + `webContents.send` (推送)
- **状态持久化**: `electron-store`
- **进程追踪**: `Set<ChildProcess>` + `processSet` 参数传递, 取消时 `taskkill /T /F`
- **路径**: `app.isPackaged` 区分 dev/packaged
- **Python 子进程**: stdin/stdout JSON 行协议, 单帧/批量两种模式

## 下一步 (Phase 3.5)

**ASR + OCR 交叉验证** — 解决纯 OCR 噪音多的问题。

方案: ASR 为主, OCR 为辅。跑 ASR 转录后, 用 OCR 文本做交叉校验。匹配的部分双源确认高置信度, OCR 独有的丢弃(大概率画面噪音), ASR 独有的保留。

详见 `.claude/skills/video-analysis/plan.md`

## 踩过的坑 (Gotchas)

1. **取消逻辑**: 所有 spawn 进程必须注册到 `processSet`, 否则取消时变孤儿进程 CPU 100%
2. **线程数**: whisper `-t` 用物理核数 (7950X=16), 不是逻辑核数。large-v3 建议 `-t 8 -p 4`
3. **模型加载**: 无进度回调, large-v3 GPU 加载 ~15-20s, medium ~8-10s
4. **输出编码**: Windows 下 whisper stdout 用 `iconv-lite` cp936 解码; Python pipe 必须设 `PYTHONIOENCODING=utf-8`
5. **类型声明**: 渲染进程类型在 `src/renderer/src/env.d.ts`, **不是** preload/index.d.ts
6. **路径污染**: `select-folder` IPC 会写 store, 分析面板选文件夹必须用 `select-analysis-folder`
7. **API Key**: 永远不要 log, UI 用 `type="password"`, 持久化必须用户 opt-in
8. **numpy 版本**: `onnxruntime-directml` 要求 `numpy<2`, 升级 numpy 会导致 DLL 加载失败
9. **RapidOCR GPU**: 内部 `use_dml` 默认 False, 需 monkey-patch `ProviderConfig.is_dml_available()`
10. **模型下载**: huggingface 需代理, 不能用两个源续传(会导致文件损坏), 用 `hf-mirror.com` 镜像稳定
11. **Prompt 维护**: 公共规则在 `common.ts` 一处修改, 不要复制粘贴到各 preset。分类 prompt 只让模型诚实分类, 0.65 阈值由代码层处理。
12. **预设文件**: 新增 preset 需在 `index.ts` 的 `PRESETS` 注册表中添加对应条目。
13. **模型部署路径**: `getModelDir()` 使用 `app.getPath('userData')`，此路径基于 `package.json` 的 `name` 字段（`my-downloader`）。模型文件必须放在 `%APPDATA%/my-downloader/whisper-models/`，**不是** `Downloader Pro/`！打包时 `electron-builder.yml` 的 `productName` 只是安装包显示名，不影响 `userData` 路径。
14. **打包前必做**: (1) 升级 `package.json` 版本号 (2) 确保 yt-dlp 是最新版 `./resources/bin/yt-dlp.exe -U`

## 文档维护规则

当用户说 "更新 skill 文档" / "更新文档" / "sync skills" 时，**无需询问，直接执行**：

1. **`CLAUDE.md`** — 如果项目结构变了（新增/删除模块）、gotchas 有新增、phase 状态变化，同步更新
2. **`.claude/skills/video-analysis/plan.md`** — 更新 phase 状态、实现细节、新增/修改的 gotchas、下一步计划
3. **`.claude/skills/video-analysis/README.md`** — 更新 phase 状态速览、关键文件索引、known issues
4. **同步副本**: `cp .claude/skills/video-analysis/*.md .agents/skills/video-analysis/`
5. **验证**: `diff .claude/skills/video-analysis/ .agents/skills/video-analysis/` 确认一致

**原则**: skill 文档是给其他 agent 看的入口，不需要全量扫描代码就能理解项目。必须保持 `.claude/` 和 `.agents/` 两份完全同步。
