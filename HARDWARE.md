# Downloader Pro — 硬件与软件环境说明

> 这份文档说明本项目涉及的所有硬件、二进制文件、系统软件的位置、用途和清理方法。
> 无论是接手这台电脑还是 clone 仓库，读完本文就能跑起来。

---

## 1. 硬件配置

| 组件 | 型号 | 用途 |
|------|------|------|
| CPU | AMD Ryzen 9 7950X (16核32线程) | whisper ASR CPU 模式用 16 线程 |
| GPU | AMD Radeon RX 7900 XTX (24GB VRAM) | whisper Vulkan GPU 加速, 10分钟音频 ~20s |
| RAM | 建议 ≥32GB | 模型加载 + 多任务并行 |
| 磁盘 | 建议 ≥50GB 可用空间 | 模型文件 ~2GB + 视频下载临时文件 |

**GPU 驱动**: 需安装 AMD Adrenalin 驱动（Vulkan 支持）。验证:
```bash
# 查看 GPU
wmic path win32_VideoController get name
# 应输出: AMD Radeon RX 7900 XTX
```

---

## 2. 项目自带二进制文件

所有文件位于 `resources/bin/`，**不上传 Git**（已在 `.gitignore` 中排除）。

### 工具

| 文件 | 大小 | 用途 |
|------|------|------|
| `yt-dlp.exe` | 18 MB | 视频/音频/字幕下载 (YouTube, B站等) |
| `ffmpeg.exe` | 202 MB | 音频提取、格式转换、抽帧 |
| `ffprobe.exe` | 202 MB | 媒体信息探测 |

### whisper.cpp (语音识别)

| 文件 | 大小 | 用途 |
|------|------|------|
| `whisper-cli.exe` | 480 KB | ASR 转录 (命令行模式) |
| `whisper-server.exe` | 712 KB | ASR 转录 (HTTP 服务模式, 暂未启用) |
| `whisper.dll` | 1.3 MB | whisper 核心库 |
| `ggml.dll` | 66 KB | 底层张量计算 |
| `ggml-cpu.dll` | 812 KB | CPU 后端 |
| `ggml-base.dll` | 626 KB | 基础后端 |
| `ggml-vulkan.dll` | **71 MB** | Vulkan GPU 后端 (7900XTX 必须用这个) |

### 模型

| 文件 | 大小 | 说明 |
|------|------|------|
| `models/ggml-small.bin` | 466 MB | small 模型 (快速, 精度一般) |
| `models/ggml-medium.bin` | 1.5 GB | **medium 模型 (推荐, 默认)** |

> 模型文件最大，不上传 Git。从 [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) 下载。

### CPU 备用

| 目录 | 大小 | 说明 |
|------|------|------|
| `backup-cpu/` | ~4 MB | CPU 版 whisper 二进制 (GPU 不可用时的备用) |

---

## 3. 系统软件

### Node.js + pnpm

| 软件 | 版本 | 位置 |
|------|------|------|
| Node.js | v22.12.0 | `C:\Program Files\nodejs\` |
| pnpm | 8.13.1 | `C:\Users\Admin\AppData\Roaming\npm\pnpm` |

安装 (如果换机器):
```bash
# 下载 Node.js: https://nodejs.org
# 然后:
npm install -g pnpm
```

### Python / Miniconda

| 软件 | 位置 |
|------|------|
| Miniconda3 | `C:\Users\Admin\miniconda3\` |
| Python 3.x | `C:\Users\Admin\miniconda3\python.exe` |

当前**没有安装**额外的 Python 包（PaddleOCR 等）。Phase 3 OCR 需要时再装，见下文。

---

## 4. 项目目录结构

```
D:\Code\my-downloader\
├── CLAUDE.md            # 项目总览 (给 AI agent 看)
├── CODEX.md             # 代码地图 + gotchas (给 AI agent 看)
├── AGENTS.md            # 新 agent 快速上手指南
├── HARDWARE.md          # 本文档
├── .gitignore           # Git 排除规则
├── .env                 # API Key (不传 Git)
├── package.json         # 项目依赖
├── tsconfig.*.json      # TypeScript 配置
├── electron.vite.config.ts
│
├── resources/
│   ├── bin/             # ⚠️ 2.4GB 二进制 (不传 Git)
│   │   ├── *.exe        # yt-dlp, ffmpeg, whisper
│   │   ├── *.dll        # ggml, whisper 库
│   │   ├── models/      # whisper 模型 (.bin)
│   │   └── backup-cpu/  # CPU 备用
│   └── ocr/             # (Phase 3) OCR worker 脚本
│
├── src/
│   ├── main/            # Electron 主进程
│   │   └── modules/     # 核心模块
│   ├── preload/         # contextBridge
│   └── renderer/        # React 前端
│       └── src/
│           └── components/
│
├── .claude/             # Claude Code 配置 (skills, settings)
├── .agents/             # 其他 AI agent 镜像配置
├── .cursor/             # Cursor IDE 配置
│
└── node_modules/        # npm 依赖 (不传 Git)
```

**磁盘占用**:
- 项目源码 + node_modules: ~3.5GB
- `resources/bin/`: ~2.4GB
- 总计: ~6GB

---

## 5. 安装步骤 (换机器 / 首次 clone)

```bash
# 1. Clone 仓库
git clone <gitee-url> downloader
cd downloader

# 2. 安装 npm 依赖
pnpm install

# 3. 准备二进制文件
# 创建 resources/bin/ 目录，放入以下文件:
mkdir -p resources/bin/models resources/bin/backup-cpu

# yt-dlp (从 https://github.com/yt-dlp/yt-dlp/releases 下载 yt-dlp.exe)
# ffmpeg + ffprobe (从 https://ffmpeg.org/download.html 下载 Windows build)
# whisper-cli + whisper-server + DLLs (从 whisper.cpp Releases 下载, 选 Vulkan 版本)
# 模型 (从 https://huggingface.co/ggerganov/whisper.cpp 下载 ggml-medium.bin)

# 4. 配置 API Key (可选)
# 创建 .env 文件:
echo DEEPSEEK_API_KEY=sk-your-key-here > .env

# 5. 启动
pnpm dev
```

---

## 6. 运行

```bash
# 开发模式 (热重载)
pnpm dev

# 类型检查
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false

# 构建分发包
pnpm build
# 输出在 out/ 目录
```

---

## 7. 各组件用途速查

| 你想做什么 | 用的工具 | 命令/入口 |
|-----------|---------|----------|
| 下载视频 | yt-dlp | `spawn(getBinaryPath('yt-dlp'), [url, ...])` |
| 下载字幕 | yt-dlp | `--write-subs --sub-langs zh.*` |
| 提取音频 | ffmpeg | `spawn(getBinaryPath('ffmpeg'), ['-i', video, '-ar', '16000', ...])` |
| 语音转文字 | whisper-cli | `spawn(getBinaryPath('whisper-cli'), ['-m', model, '-f', audio, ...])` |
| 抽视频帧 (OCR) | ffmpeg | `-vf "fps=1" frame_%04d.png` |
| OCR 识别 (Phase 3) | PaddleOCR | Python 子进程, 见 plan.md Phase 3 |
| LLM 分析 | DeepSeek API | `callLLM(systemPrompt, userPrompt, options)` |

---

## 8. PaddleOCR 安装 (Phase 3 需要)

当前**未安装**。需要时执行:

```bash
# 用 Miniconda
conda create -n paddleocr python=3.10 -y
conda activate paddleocr
pip install paddlepaddle paddleocr

# 验证
python -c "from paddleocr import PaddleOCR; print('OK')"
```

安装后额外占用约 1-2GB (PaddlePaddle + 模型)。

---

## 9. 如何卸载 / 清理

### 只想删项目
```bash
# 删除项目文件夹即可
rm -rf D:\Code\my-downloader
# 磁盘释放 ~6GB
```

### 想把整个开发环境清干净

| 要删的东西 | 在哪里 | 怎么删 | 释放空间 |
|-----------|--------|--------|---------|
| 项目代码 + node_modules | `D:\Code\my-downloader\` | 删除整个文件夹 | ~6GB |
| 下载的视频/article | `C:\Users\Admin\Downloads\article\` | 删除 article 文件夹 | 取决于下载量 |
| Node.js | `C:\Program Files\nodejs\` | 控制面板 → 卸载程序 | ~100MB |
| pnpm (全局) | `C:\Users\Admin\AppData\Roaming\npm\` | `npm uninstall -g pnpm` | ~50MB |
| pnpm 缓存 | `C:\Users\Admin\AppData\Local\pnpm\` | `pnpm store prune` 或删除文件夹 | ~2GB |
| Miniconda3 | `C:\Users\Admin\miniconda3\` | 运行 `Uninstall-Miniconda3.exe` | ~3GB |
| AMD 驱动 | 系统驱动 | 控制面板 → AMD Software | ~2GB |
| whisper 模型 | `resources/bin/models/` | 删除 .bin 文件 | 466MB-1.5GB 每个 |
| API Key (.env) | `D:\Code\my-downloader\.env` | 删除文件 | 几字节 |

**最干净的卸载顺序**:
1. 删除 `D:\Code\my-downloader\`
2. 控制面板卸载 Node.js
3. 运行 `C:\Users\Admin\miniconda3\Uninstall-Miniconda3.exe`
4. (可选) 控制面板卸载 AMD Software
5. 删除 `C:\Users\Admin\Downloads\article\`

---

## 10. 注意事项

- **GPU 驱动不要随便升级/降级**，Vulkan 兼容性敏感。当前版本已验证可用。
- **模型文件 (ggml-*.bin) 很大**，clone 仓库不会下载它们，需要单独获取。
- **`.env` 文件包含 API Key**，不要上传、不要分享、不要提交到 Git。
- **ffmpeg.exe / ffprobe.exe 各 202MB**，从 ffmpeg 官网下载 Windows build 的 `bin/` 目录提取。
- 项目内所有二进制通过 `getBinaryPath('name')` 统一引用，路径自动区分 dev/packaged 环境。
