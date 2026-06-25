# Whisper 模型加载优化方案

## 问题现状

当前 `transcriber.ts` 每次转录都重新 `spawn whisper-cli.exe`：
1. **466MB 模型每次从磁盘冷加载**，耗时 15-40 秒，此阶段无进度
2. **7950X 16核只用 16 线程**，模型加载内存密集型，等内存时显示 100% CPU
3. **取消需跨多层进程追踪**，容易漏
4. **7900XTX 24GB 显卡完全没用**

## 推荐方案：Whisper Server 常驻

**核心思路**：模型只加载一次，后续转录秒级响应。

```
当前:
  request → spawn whisper-cli → 加载模型(30s) → 转录(2min) → 退出
  request → spawn whisper-cli → 加载模型(30s) → 转录(2min) → 退出

改为:
  app启动 → spawn whisper-server → 加载模型一次(30s) → 保持运行
  request → HTTP POST 音频 → 转录(2min) → 返回
  request → HTTP POST 音频 → 转录(2min) → 返回
```

whisper.cpp 自带 `whisper-server.exe`（已在 `resources/bin/Release/` 中）。

---

## 实现步骤

### Step 1: 新建 `whisper-server-manager.ts`

位置: `src/main/modules/whisper-server-manager.ts`

职责：
- 应用启动时 spawn `whisper-server.exe` 加载模型
- 提供 `transcribe(audioPath)` 方法，内部 HTTP POST 到 server
- 健康检查 + 自动重启
- app quit 时 kill server
- 单例模式，整个应用共享

关键 API 设计:
```typescript
class WhisperServerManager {
  port: number = 18080
  status: 'stopped' | 'loading' | 'ready' | 'error'

  start(model: string): Promise<void>
  transcribe(audioPath: string): Promise<{ segments, fullText }>
  stop(): void
  onStatusChange: (status) => void
}
```

whisper-server HTTP API:
```
POST /inference
Content-Type: multipart/form-data
file=@audio.wav
Response: { "text": "...", "segments": [...] }

GET /health  → 200 OK 表示就绪
```

### Step 2: 改造 `transcriber.ts`

```typescript
// 改为调用 server, 不再 spawn whisper-cli
import { whisperServer } from './whisper-server-manager'

export async function transcribe(audioPath: string, options) {
  return whisperServer.transcribe(audioPath)
}
```

### Step 3: 在 `index.ts` 初始化

```typescript
// src/main/index.ts createWindow()
import { whisperServer } from './modules/whisper-server-manager'
whisperServer.start('small')  // 异步预加载, 不阻塞窗口
```

### Step 4: 前端模型状态

VideoAnalysisPanel 中展示:
- 模型加载中 (显示进度)
- 模型就绪，可以分析

---

## GPU 加速（备选）

whisper.cpp 支持 Vulkan，7900XTX 可用。需编译:
```bash
cmake -B build -DGGML_VULKAN=ON
cmake --build build --config Release
```
GPU server: `whisper-server.exe -m models/ggml-large-v3.bin -l zh --port 8080`
7900XTX跑 large-v3: 加载 ~5s, 10分钟转录 ~20s

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `resources/bin/whisper-server.exe` | 复制 | 从 Release/ 复制 |
| `src/main/modules/whisper-server-manager.ts` | **新增** | 核心模块 |
| `src/main/modules/transcriber.ts` | **修改** | 改为调用 server |
| `src/main/modules/analysis-pipeline.ts` | **修改** | 简化进程追踪 |
| `src/main/index.ts` | **修改** | 启动 server |
| `src/preload/index.ts` | **修改** | 加 onModelReady |

## 开始前准备

从已有的 Release 目录复制 whisper-server：
```bash
cp resources/bin/Release/whisper-server.exe resources/bin/
```
