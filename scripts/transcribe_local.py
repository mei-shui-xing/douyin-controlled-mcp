#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe a local media file with faster-whisper.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--transcript-id", required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--author", default="")
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--initial-prompt", default="")
    return parser.parse_args()


def has_nvidia() -> bool:
    try:
        result = subprocess.run(
            ["nvidia-smi"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=4,
            check=False,
        )
        return result.returncode == 0
    except Exception:
        return False


def model_attempts() -> list[tuple[str, str]]:
    requested = os.environ.get("FW_DEVICE", "auto").strip().lower()
    compute = os.environ.get("FW_COMPUTE_TYPE", "").strip()
    if requested in {"cuda", "gpu"}:
        return [("cuda", compute or "float16"), ("cpu", "int8")]
    if requested == "cpu":
        return [("cpu", compute or "int8")]
    attempts: list[tuple[str, str]] = []
    if has_nvidia():
        attempts.append(("cuda", compute or "float16"))
    attempts.append(("cpu", "int8" if not compute or compute == "float16" else compute))
    return attempts


def transcribe_with_fallback(input_path: Path, model_name: str, cache_dir: str, initial_prompt: str):
    from faster_whisper import WhisperModel

    errors: list[str] = []
    for device, compute_type in model_attempts():
        try:
            print(f"Loading model={model_name} device={device} compute_type={compute_type}", file=sys.stderr)
            model = WhisperModel(
                model_name,
                device=device,
                compute_type=compute_type,
                download_root=cache_dir,
            )
            segments_iter, info = model.transcribe(
                str(input_path),
                beam_size=5,
                vad_filter=True,
                word_timestamps=False,
                condition_on_previous_text=True,
                temperature=0.0,
                initial_prompt=initial_prompt or None,
            )
            # Inference is lazy. Materialize it inside the fallback block so a
            # missing CUDA runtime also retries on CPU.
            return list(segments_iter), info, device, compute_type
        except Exception as exc:
            errors.append(f"{device}/{compute_type}: {exc}")
            print(f"Transcription failed on {device}; trying the next runtime: {exc}", file=sys.stderr)
    raise RuntimeError("Unable to transcribe with faster-whisper. " + " | ".join(errors))


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    cache_dir = Path(args.model_cache)
    if not input_path.exists():
        raise FileNotFoundError(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    segments_iter, info, device, compute_type = transcribe_with_fallback(
        input_path,
        args.model,
        str(cache_dir),
        args.initial_prompt,
    )

    segments: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for index, segment in enumerate(segments_iter):
        text = (segment.text or "").strip()
        if not text:
            continue
        segments.append(
            {
                "index": index,
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": text,
            }
        )
        text_parts.append(text)

    record = {
        "transcriptId": args.transcript_id,
        "workId": args.work_id,
        "sourceUrl": args.source_url,
        "title": args.title,
        "author": args.author or None,
        "model": args.model,
        "method": "local-faster-whisper",
        "language": getattr(info, "language", None),
        "durationSeconds": round(float(getattr(info, "duration", 0.0)), 3) if getattr(info, "duration", None) is not None else None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "device": device,
        "computeType": compute_type,
        "text": "\n".join(text_parts),
        "segments": segments,
    }
    output_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "segments": len(segments), "language": record["language"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"TRANSCRIBE_ERROR: {exc}", file=sys.stderr)
        raise
