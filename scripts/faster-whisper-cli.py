#!/usr/bin/env python3
"""Small faster-whisper CLI for fleet-transcribe.sh.

The project script expects a command shaped like:
  faster-whisper AUDIO --model MODEL --language LANG --output_dir DIR --output_format txt

This wrapper keeps the dependency local and writes a plain transcript file beside
the audio. It intentionally performs no action-item extraction or summarization.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe one audio file with faster-whisper")
    parser.add_argument("audio", help="Audio file to transcribe")
    parser.add_argument("--model", default="base.en", help="faster-whisper model name or path")
    parser.add_argument("--language", default="en", help="Language hint")
    parser.add_argument("--output_dir", default=".", help="Output directory")
    parser.add_argument("--output_format", default="txt", choices=["txt"], help="Only txt is supported")
    parser.add_argument("--device", default="cpu", help="faster-whisper device, default cpu")
    parser.add_argument("--compute_type", default="int8", help="faster-whisper compute type, default int8")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed in this Python environment", file=sys.stderr)
        return 2

    audio_path = Path(args.audio)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{audio_path.stem}.txt"

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        str(audio_path),
        language=args.language or None,
        vad_filter=True,
    )

    with output_path.open("w", encoding="utf-8") as handle:
        handle.write(f"# Transcript: {audio_path.name}\n\n")
        if info.language:
            handle.write(f"Language: {info.language}")
            if info.language_probability is not None:
                handle.write(f" ({info.language_probability:.2f})")
            handle.write("\n\n")
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            handle.write(f"[{segment.start:0.2f} - {segment.end:0.2f}] {text}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
