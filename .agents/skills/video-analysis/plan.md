# 视频内容分析工具 — 技术方案

> **更新**: 2026-06-25
> **当前阶段**: Phase 1 ✅ | Phase 2 ✅ | Phase 3 📋

## 实现状态

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 音频提取 + ASR 转录 + GPU 加速 + 分析面板 | ✅ 完成 |
| Phase 2 | LLM 深度内容分析 (文章/可信度评分/广告过滤) | ✅ 完成 |
| Phase 3 | OCR 硬字幕提取 | 📋 待实现 |
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

## Phase 3: OCR 硬字幕提取 📋

### 问题
当前 subtitle-first 策略依赖 yt-dlp 提取外挂字幕。部分视频的字幕是"烧录"在画面中的（硬字幕），yt-dlp 无法提取。ASR 对某些场景效果差（背景音乐、多人重叠、方言）。

### 方案
新增第三种策略: subtitle-first → ASR → **OCR**

```
策略选择 (VideoAnalysisPanel strategy dropdown):
  subtitle-first (默认) — 优先外挂字幕, 无字幕则 ASR
  asr-only           — 下载视频 → ASR
  ocr                 — [NEW] 下载视频 → OCR 硬字幕提取
```

OCR 作为独立策略而非 fallback，因为：
- 用户清楚自己面对的是硬字幕视频
- OCR 和 ASR 的适用场景不同，不需要自动切换

### 技术选型

**OCR 引擎: PaddleOCR**
- Python 库，中文识别 SOTA（State of the Art）
- 支持中英文混合、竖排文字、多角度
- 轻量模型可在 CPU 上运行，有 GPU 加速选项
- 安装: `pip install paddlepaddle paddleocr`

**帧提取: ffmpeg**
- 项目已捆绑 `ffmpeg.exe`，直接用 `getBinaryPath('ffmpeg')`
- 抽帧命令:
  ```
  ffmpeg -i input.mp4 -vf "fps=1" -q:v 2 frame_%04d.png
  ```
- `fps=1` = 每秒 1 帧
- `-q:v 2` = 高质量 PNG 输出

**去重: 感知哈希 (pHash)**
- 库: `imghash` 或手写（~50 行）
- 原理: 缩放 → 灰度 → DCT → 二值化 → 汉明距离比较
- 相邻帧汉明距离 < 阈值 → 视为重复，跳过 OCR
- 只 OCR 有字幕变化的帧：~600 原始帧 → 100-200 有效帧

**字幕区域裁剪 (可选优化)**
- 只裁剪画面底部 1/3 给 OCR
- ffmpeg 可直接裁剪: `-vf "fps=1,crop=iw:ih/3:0:ih*2/3"`
- 减少 OCR 误识别（不会被画面内容干扰）

### 新增文件

#### `src/main/modules/ocr-extractor.ts`

```typescript
// 核心接口
export interface OcrOptions {
  videoPath: string
  language?: string        // 'ch' | 'en' | 'ch_en'
  fps?: number             // 抽帧间隔, 默认 1
  cropBottom?: boolean     // 是否只识别底部 1/3
  onProgress?: (message: string) => void
  processSet?: Set<ChildProcess>
}

export interface OcrResult {
  fullText: string
  segments: Array<{ start: number; end: number; text: string }>
  frameCount: number       // 总抽帧数
  uniqueFrameCount: number // 去重后帧数
  processingTime: number   // ms
}

// 核心函数
export async function extractSubtitles(options: OcrOptions): Promise<OcrResult>
```

**实现流程**:
1. `spawn(ffmpeg, [...])` 抽帧到临时目录 → 加入 processSet
2. 遍历 PNG 文件，计算 pHash，去重
3. 对去重后的帧，逐帧调用 PaddleOCR:
   - 方式 A: `spawn('python', ['-c', '...'])` 子进程
   - 方式 B: HTTP 调用本地 PaddleOCR service
   - 方式 C: 用 `child_process.execFile` 调 Python 脚本
4. 合并 OCR 文本，按时间轴（帧序号 → 秒数）生成 segments
5. 清理临时 PNG 文件

**PaddleOCR Python 子进程方案** (推荐方式 C):

创建 `resources/ocr/ocr_worker.py`:
```python
import sys, json
from paddleocr import PaddleOCR

ocr = PaddleOCR(lang='ch')  # 初始化一次

for line in sys.stdin:
    req = json.loads(line)
    result = ocr.ocr(req['path'], cls=False)
    # 提取文本
    texts = []
    for page in result:
        if page:
            for box in page:
                texts.append(box[1][0])
    print(json.dumps({'id': req['id'], 'text': ' '.join(texts)}), flush=True)
```

主进程用 `spawn('python', ['resources/ocr/ocr_worker.py'])` 启动，通过 stdin/stdout JSON 行协议通信。进程必须加入 processSet。

**pHash 实现** (~50 行，写在 ocr-extractor.ts 内):
```typescript
// 不需要额外依赖，纯 TypeScript
function pHash(buf: Buffer, width: number, height: number): string {
  // 1. 缩放至 8x8
  // 2. 转灰度
  // 3. 计算 DCT
  // 4. 取左上角 8x8
  // 5. 与均值比较 → 64-bit hash
}
```

### 修改现有文件

#### `src/main/modules/analysis-pipeline.ts`

在 `runPipeline` 中添加 OCR 分支:
```typescript
// 在下载视频步骤之后 (Step 3 结束), 添加:
if (strategy === 'ocr') {
  emitProgress('extracting-audio', 0, 55, '正在 OCR 提取硬字幕...')
  const ocrResult = await extractSubtitles({
    videoPath,
    language,
    onProgress: (msg) => emitProgress('extracting-audio', 50, 60, msg),
    processSet: procSet
  })
  // ocrResult 格式与 TranscriberResult 兼容，直接作为 transcript 使用
  // ...
}
```

`AnalysisRequest.strategy` 类型扩展:
```typescript
strategy?: 'subtitle-first' | 'asr-only' | 'ocr'
```

#### `src/renderer/src/components/VideoAnalysisPanel/index.tsx`

策略下拉添加选项:
```tsx
<select value={strategy} onChange={...}>
  <option value="subtitle-first">字幕优先</option>
  <option value="asr-only">纯 ASR</option>
  <option value="ocr">OCR 硬字幕</option>  {/* NEW */}
</select>
```

### PaddleOCR 部署方式

| 方式 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| Python 子进程 | 简单，不需要额外服务 | 首次加载慢 (~3s)，需要 Python 环境 | ⭐⭐⭐ |
| HTTP Service | 一次加载，多次使用 | 需要额外启动/管理服务 | ⭐⭐ |
| ONNX 导出 + Node.js 推理 | 不需要 Python | 工作量大，模型兼容性差 | ⭐ |

**推荐**: 先用 Python 子进程方案快速跑通，后续可优化为 HTTP service 常驻（类似 whisper-server 模式）。

### 依赖
- Python 3.8+
- `pip install paddlepaddle paddleocr`
- ffmpeg（已捆绑）
- 不需要 GPU（PaddleOCR CPU 模式即可）

### 验证方法
```bash
# 手动测试 OCR
ffmpeg -i test_video.mp4 -vf "fps=1" -q:v 2 frames/test_%04d.png
python -c "from paddleocr import PaddleOCR; ocr = PaddleOCR(lang='ch'); print(ocr.ocr('frames/test_0001.png'))"
```

### 验收标准
1. 对已知有硬字幕的视频（如 B站 老视频），选择 "OCR" 策略能成功提取字幕文本
2. 提取的文本存入 `article/{title}/`，文件名与 ASR 模式一致
3. OCR 进度显示在 UI 进度条上
4. 取消时能 kill ffmpeg + Python 进程
5. OCR 输出的 transcript 能被 Phase 2 LLM 分析正常处理

---

## Phase 4: 优化 📋

- whisper-server 常驻模式 (见 `whisper-optimization.md`)
- 批量分析
- 跨视频问答/RAG
- 导出格式 (PDF/HTML)
