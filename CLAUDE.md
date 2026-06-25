# Downloader Pro — 项目总览

## 技术栈
- **框架**: Electron 39 + React 19 + TypeScript 5 + Vite 7
- **包管理**: pnpm
- **构建**: electron-vite + electron-builder
- **核心二进制**: yt-dlp.exe, ffmpeg.exe, ffprobe.exe, whisper-cli.exe (bundled in `resources/bin/`)

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
│       ├── content-analyzer.ts    # LLM 分析 (Prompt/Provider/文章生成)
│       └── analysis-pipeline.ts   # 分析流水线编排 (URL+已有文本)
├── preload/
│   └── index.ts                   # contextBridge API
└── renderer/
    └── src/
        ├── App.tsx                # 主界面 (下载/访谈/视频分析)
        ├── env.d.ts               # 渲染进程类型声明 (新 API 类型加这里!)
        └── components/
            ├── VideoAnalysisPanel/ # 视频分析面板 (URL分析+已有文本+LLM设置)
            ├── AnalysisResultCard/ # 分析结果子组件 (摘要/要点/思维导图)
            └── ...
```

## 已实现功能

### 下载模块 (稳定)
- B站/YouTube 视频/音频下载
- 外挂字幕下载 (手动/自动, SRT/VTT)
- B站 Cookie 登录
- 并发下载控制 (1-10)
- 下载后打开文件夹/删除本地文件

### 视频分析模块 (Phase 1 + Phase 2 ✅)

**Phase 1 — 转录生成:**
- ffmpeg 提取 16kHz 单声道 WAV
- whisper.cpp ASR, Vulkan GPU 加速 (AMD 7900XTX)
- 策略: subtitle-first (优先外挂字幕, 否则下载+ASR)
- 5 阶段进度: 获取信息→下载→提取音频→转录→分析
- 全进程追踪取消 (yt-dlp + ffmpeg + whisper, 无孤儿进程)
- 输出: `{savePath}/article/{title}/` (transcript.txt / transcript.json / README.md / analysis.md / analysis.prompt.md / analysis.json)

**Phase 2 — LLM 深度分析:**
- Provider: DeepSeek (默认), OpenAI-compatible, Codex CLI
- 两阶段分析: 先按 chunk 提取结构化素材 ([FC]/[OP]/[SP]/[RT] 标记), 再合成深度文章
- 广告/赞助内容自动过滤
- 文章含: 结论/内容概览/论证主线/事实数字表/事实观点拆分/修辞分析/可信度五维评分/追问/速读
- 输出: analysis.md (主阅读文件), analysis.prompt.md (Prompt 审计), analysis.json (结构化缓存)
- 支持 URL 分析和已有文本文件夹分析
- API Key: `.env` fallback + UI 输入 + 勾选保存才持久化

**GUI 改进:**
- 分析日志实时推送到左侧 CLI 面板
- 统一顶层 Tab: 分析文章/摘要/要点/思维导图/转录文本
- 单滚动条, 不嵌套
- Markdown 渲染分析文章
- 完成提示紧凑化 + 文件路径可折叠

## 关键架构模式
- **二进制执行**: `spawn(getBinaryPath('tool'), args)` — 统一模式
- **IPC**: `ipcMain.handle` (请求-响应) + `webContents.send` (推送)
- **状态持久化**: `electron-store`
- **进程追踪**: `Set<ChildProcess>` + `processSet` 参数传递
- **路径**: `app.isPackaged` 区分 dev/packaged

## 下一步 (Phase 3)

OCR 硬字幕提取 — 当外挂字幕和 ASR 都不可用时，通过 ffmpeg 抽帧 + PaddleOCR 识别视频中烧录的文字。

详见 `.claude/skills/video-analysis/plan.md`

## 踩过的坑 (Gotchas)

1. **取消逻辑**: 所有 spawn 进程必须注册到 `processSet`, 否则取消时变孤儿进程 CPU 100%
2. **线程数**: whisper `-t` 用物理核数 (7950X=16), 不是逻辑核数
3. **模型加载**: 无进度回调, medium 模型 GPU 加载 ~8-10s
4. **输出编码**: Windows 下 whisper stdout 用 `iconv-lite` cp936 解码
5. **类型声明**: 渲染进程类型在 `src/renderer/src/env.d.ts`, **不是** preload/index.d.ts
6. **路径污染**: `select-folder` IPC 会写 store, 分析面板选文件夹必须用 `select-analysis-folder`
7. **API Key**: 永远不要 log, UI 用 `type="password"`, 持久化必须用户 opt-in
