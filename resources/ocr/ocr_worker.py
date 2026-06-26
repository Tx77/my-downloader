"""
RapidOCR Worker — stdin/stdout JSON 行协议
基于 ONNX Runtime DirectML，支持单帧/批量模式。

协议:
  → {"id": N, "path": "..."}          单帧请求
  → {"ids": [0,1,2], "paths": [...]}  批量请求
  ← {"id": N, "text": "...", "lines": [...], "time_ms": 123}
  ← {"results": [{"id": 0, ...}, ...]}

用法: python ocr_worker.py [--lang ch]
"""

import sys
import json
import argparse
import os
import logging
import time

# Windows pipe 默认 GBK (cp936), 强制 UTF-8
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

os.environ['RAPIDOCR_LOG_LEVEL'] = 'ERROR'
logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format='%(message)s')

# Monkey-patch: 强制 RapidOCR 使用 DirectML GPU
def _patch_dml():
    try:
        from rapidocr.inference_engine.onnxruntime import provider_config
        provider_config.ProviderConfig.is_dml_available = lambda self: True
    except Exception:
        pass

_patch_dml()


def create_engine():
    """创建 RapidOCR 引擎，优先新版 rapidocr v3"""
    for pkg_name, import_path in [
        ('rapidocr', 'rapidocr'),
        ('rapidocr-onnxruntime', 'rapidocr_onnxruntime'),
    ]:
        try:
            mod = __import__(import_path, fromlist=['RapidOCR'])
            engine = mod.RapidOCR()
            return engine, import_path
        except Exception:
            continue
    return None, None


def extract_texts(engine, img_path: str):
    """返回 (texts, elapsed_ms)"""
    t0 = time.time()
    result = engine(img_path)
    elapsed = int((time.time() - t0) * 1000)

    texts = []
    if hasattr(result, 'txts') and result.txts:
        for t in result.txts:
            if t and t.strip():
                texts.append(t.strip())
    elif isinstance(result, tuple) and len(result) >= 1:
        items = result[0]
        if items:
            for item in items:
                text = item[1] if len(item) >= 2 else ''
                if text and text.strip():
                    texts.append(text.strip())
    return texts, elapsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lang', default='ch')
    args = parser.parse_args()

    engine, mode = create_engine()
    if engine is None:
        print(json.dumps({"error": "RapidOCR 未安装。pip install rapidocr onnxruntime-directml"}),
              flush=True)
        sys.exit(1)

    import onnxruntime as ort
    providers = ort.get_available_providers()
    gpu = 'DmlExecutionProvider' in providers

    print(json.dumps({
        "ready": True, "lang": args.lang, "mode": mode,
        "gpu": gpu, "providers": providers
    }), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"error": f"Invalid JSON: {line[:80]}"}), flush=True)
            continue

        # 批量模式
        if 'paths' in req:
            paths = req['paths']
            ids = req.get('ids', list(range(len(paths))))
            results = []
            total_time = 0
            for i, (req_id, img_path) in enumerate(zip(ids, paths)):
                if not img_path:
                    results.append({"id": req_id, "text": "", "error": "empty path"})
                    continue
                try:
                    txts, elapsed = extract_texts(engine, img_path)
                    total_time += elapsed
                    results.append({
                        "id": req_id,
                        "text": " ".join(txts),
                        "lines": txts,
                        "time_ms": elapsed
                    })
                except Exception as e:
                    results.append({"id": req_id, "text": "", "error": str(e)})

            print(json.dumps({
                "results": results,
                "total_time_ms": total_time,
                "count": len(paths)
            }, ensure_ascii=False), flush=True)
            continue

        # 单帧模式
        req_id = req.get('id')
        img_path = req.get('path', '')
        if not img_path:
            print(json.dumps({"id": req_id, "text": "", "error": "empty path"}), flush=True)
            continue

        try:
            txts, elapsed = extract_texts(engine, img_path)
            print(json.dumps({
                "id": req_id,
                "text": " ".join(txts),
                "lines": txts,
                "time_ms": elapsed
            }, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"id": req_id, "text": "", "error": str(e)}), flush=True)


if __name__ == '__main__':
    main()
