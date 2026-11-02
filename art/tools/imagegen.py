#!/usr/bin/env python3
"""Generate or edit images through an OpenAI-compatible Images API.

Credentials are resolved in this order:
  1. IMAGEGEN_BASE_URL / IMAGEGEN_API_KEY environment variables
  2. OPENAI_BASE_URL / OPENAI_API_KEY environment variables
  3. The local Codex config (~/.codex/config.toml provider base_url + ~/.codex/auth.json)

Examples:
  python art/tools/imagegen.py generate --prompt-file art/prompts/clawd.md --out art/raw/clawd.png
  python art/tools/imagegen.py edit --image art/raw/clawd.png --prompt-file art/prompts/x.md --out art/raw/x.png
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import tomllib
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def resolve_credentials() -> tuple[str, str]:
    base = os.environ.get("IMAGEGEN_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
    key = os.environ.get("IMAGEGEN_API_KEY") or os.environ.get("OPENAI_API_KEY")
    home = codex_home()
    if not base:
        cfg_path = home / "config.toml"
        if cfg_path.exists():
            cfg = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
            provider = cfg.get("model_provider")
            providers = cfg.get("model_providers") or {}
            if provider and provider in providers:
                base = providers[provider].get("base_url")
    if not key:
        auth_path = home / "auth.json"
        if auth_path.exists():
            key = json.loads(auth_path.read_text(encoding="utf-8")).get("OPENAI_API_KEY")
    if not base:
        base = "https://api.openai.com/v1"
    if not key:
        sys.exit("No API key found (set IMAGEGEN_API_KEY or configure Codex).")
    base = base.rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    return base, key


def read_prompt(args: argparse.Namespace) -> str:
    if args.prompt_file:
        return Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if args.prompt:
        return args.prompt
    sys.exit("--prompt or --prompt-file is required")


def post(url: str, key: str, body: bytes, content_type: str, timeout: int) -> dict:
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:2000]
        sys.exit(f"HTTP {e.code} from {url}: {detail}")


def multipart(fields: dict[str, str], files: list[tuple[str, Path]]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    out = bytearray()
    for name, value in fields.items():
        out += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
    for name, path in files:
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        out += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        out += path.read_bytes() + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def save_images(result: dict, out: Path) -> list[Path]:
    data = result.get("data") or []
    if not data:
        sys.exit(f"No image data in response: {json.dumps(result)[:1000]}")
    out.parent.mkdir(parents=True, exist_ok=True)
    saved = []
    for i, item in enumerate(data):
        target = out if len(data) == 1 else out.with_name(f"{out.stem}-{i + 1}{out.suffix}")
        if item.get("b64_json"):
            target.write_bytes(base64.b64decode(item["b64_json"]))
        elif item.get("url"):
            with urllib.request.urlopen(item["url"], timeout=120) as resp:
                target.write_bytes(resp.read())
        else:
            sys.exit(f"Unrecognised image item: {json.dumps(item)[:500]}")
        saved.append(target)
    return saved


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("generate", "edit"):
        p = sub.add_parser(name)
        p.add_argument("--prompt")
        p.add_argument("--prompt-file")
        p.add_argument("--out", required=True)
        p.add_argument("--model", default="gpt-image-2")
        p.add_argument("--size", default="1024x1024")
        p.add_argument("--quality", default="high")
        p.add_argument("--n", type=int, default=1)
        p.add_argument("--timeout", type=int, default=600)
        if name == "edit":
            p.add_argument("--image", action="append", required=True, help="reference/edit image (repeatable)")
    args = ap.parse_args()

    base, key = resolve_credentials()
    prompt = read_prompt(args)
    started = time.time()
    if args.cmd == "generate":
        body = json.dumps(
            {"model": args.model, "prompt": prompt, "size": args.size, "quality": args.quality, "n": args.n}
        ).encode()
        result = post(f"{base}/images/generations", key, body, "application/json", args.timeout)
    else:
        fields = {"model": args.model, "prompt": prompt, "size": args.size, "quality": args.quality, "n": str(args.n)}
        files = [("image[]", Path(p)) for p in args.image]
        body, ctype = multipart(fields, files)
        result = post(f"{base}/images/edits", key, body, ctype, args.timeout)
    saved = save_images(result, Path(args.out))
    for path in saved:
        print(f"saved {path} ({time.time() - started:.0f}s)")
    if result.get("data") and result["data"][0].get("revised_prompt"):
        print("revised_prompt:", result["data"][0]["revised_prompt"][:400])


if __name__ == "__main__":
    main()
