import argparse
import base64
import json
import mimetypes
import os
import statistics
import time
import urllib.error
import urllib.request
from datetime import datetime
from difflib import SequenceMatcher


DEFAULT_ENGINES = ["auto", "paddle", "doctr", "mangaocr"]


def normalize_text(value):
    return " ".join(str(value or "").split()).strip().lower()


def similarity(a, b):
    if not a or not b:
        return None
    return SequenceMatcher(None, normalize_text(a), normalize_text(b)).ratio()


def load_manifest(manifest_path):
    if not manifest_path:
        return {}

    with open(manifest_path, "r", encoding="utf-8") as handle:
      raw = json.load(handle)

    if isinstance(raw, dict) and "images" in raw and isinstance(raw["images"], list):
        return {
            entry["path"]: entry
            for entry in raw["images"]
            if isinstance(entry, dict) and entry.get("path")
        }

    if isinstance(raw, dict):
        return raw

    raise ValueError("Unsupported manifest format")


def discover_images(images_root, manifest_index):
    if manifest_index:
        entries = []
        for relative_path, meta in manifest_index.items():
            absolute_path = os.path.join(images_root, relative_path)
            if os.path.isfile(absolute_path):
                entries.append((absolute_path, relative_path, meta if isinstance(meta, dict) else {}))
        return entries

    image_paths = []
    for root, _, files in os.walk(images_root):
        for filename in files:
            if filename.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp")):
                absolute_path = os.path.join(root, filename)
                relative_path = os.path.relpath(absolute_path, images_root)
                image_paths.append((absolute_path, relative_path, {}))
    return sorted(image_paths, key=lambda item: item[1])


def call_endpoint(endpoint, image_path, engine):
    mime_type = mimetypes.guess_type(image_path)[0] or "image/jpeg"
    with open(image_path, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")

    payload = {
        "image": {
            "base64": encoded,
            "mimeType": mime_type,
        },
        "ocrEngine": engine,
        "context": {
            "benchmark": True,
            "pageTitle": os.path.basename(image_path),
        },
    }

    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=180) as response:
        body = json.loads(response.read().decode("utf-8"))
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    return body, elapsed_ms


def summarize(results):
    grouped = {}
    for row in results:
        grouped.setdefault(row["engine"], []).append(row)

    summary = {}
    for engine, rows in grouped.items():
        durations = [row["durationMs"] for row in rows if row.get("durationMs") is not None]
        block_counts = [row["blockCount"] for row in rows]
        similarities = [row["similarity"] for row in rows if row.get("similarity") is not None]
        successes = [row for row in rows if row["success"]]

        summary[engine] = {
            "images": len(rows),
            "successes": len(successes),
            "successRate": round(len(successes) / len(rows), 4) if rows else 0.0,
            "avgDurationMs": round(statistics.mean(durations), 2) if durations else None,
            "medianDurationMs": round(statistics.median(durations), 2) if durations else None,
            "avgBlocks": round(statistics.mean(block_counts), 2) if block_counts else 0.0,
            "avgSimilarity": round(statistics.mean(similarities), 4) if similarities else None,
        }
    return summary


def summarize_by_site(results):
    site_map = {}
    for row in results:
        site = row.get("site") or "unknown"
        site_map.setdefault(site, []).append(row)

    output = {}
    for site, rows in site_map.items():
        output[site] = summarize(rows)
    return output


def to_markdown(report):
    lines = [
        "# OCR benchmark",
        "",
        f"- timestamp: {report['timestamp']}",
        f"- images: {report['meta']['imageCount']}",
        f"- endpoint: {report['meta']['endpoint']}",
        "",
        "## Overall",
        "",
        "| Engine | Success | Avg ms | Median ms | Avg blocks | Avg similarity |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]

    for engine, data in report["summary"].items():
        lines.append(
            f"| {engine} | {data['successes']}/{data['images']} | "
            f"{data['avgDurationMs'] or '-'} | {data['medianDurationMs'] or '-'} | "
            f"{data['avgBlocks']} | {data['avgSimilarity'] or '-'} |"
        )

    if report["bySite"]:
        lines.append("")
        lines.append("## By site")
        for site, site_summary in report["bySite"].items():
            lines.append("")
            lines.append(f"### {site}")
            lines.append("")
            lines.append("| Engine | Success | Avg ms | Avg blocks | Avg similarity |")
            lines.append("| --- | ---: | ---: | ---: | ---: |")
            for engine, data in site_summary.items():
                lines.append(
                    f"| {engine} | {data['successes']}/{data['images']} | "
                    f"{data['avgDurationMs'] or '-'} | {data['avgBlocks']} | {data['avgSimilarity'] or '-'} |"
                )

    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Benchmark OCR manga pipeline")
    parser.add_argument("--images", required=True, help="Directory containing chapter images")
    parser.add_argument("--manifest", help="Optional JSON manifest with expected_text/site per image")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8788/ocr/manga", help="OCR endpoint")
    parser.add_argument("--engines", default=",".join(DEFAULT_ENGINES), help="Comma separated engines")
    parser.add_argument("--output-dir", default="benchmarks", help="Directory for JSON/MD reports")
    args = parser.parse_args()

    manifest_index = load_manifest(args.manifest)
    images = discover_images(args.images, manifest_index)
    if not images:
        raise SystemExit("No images found for benchmark")

    engines = [engine.strip() for engine in args.engines.split(",") if engine.strip()]
    results = []

    for engine in engines:
        for absolute_path, relative_path, meta in images:
            expected_text = meta.get("expected_text") or meta.get("expectedText") or meta.get("reference")
            site = meta.get("site") or relative_path.split(os.sep)[0]

            row = {
                "engine": engine,
                "image": relative_path,
                "site": site,
                "success": False,
                "durationMs": None,
                "blockCount": 0,
                "similarity": None,
                "error": None,
            }

            try:
                payload, elapsed_ms = call_endpoint(args.endpoint, absolute_path, engine)
                blocks = payload.get("blocks") or []
                ocr_text = " ".join(
                    normalize_text(block.get("original") or block.get("text"))
                    for block in blocks
                    if isinstance(block, dict)
                ).strip()

                row.update({
                    "success": True,
                    "durationMs": elapsed_ms,
                    "blockCount": len(blocks),
                    "engineResolved": payload.get("engine"),
                    "ocrText": ocr_text,
                    "similarity": similarity(expected_text, ocr_text),
                })
            except urllib.error.HTTPError as exc:
                row["error"] = f"HTTP {exc.code}"
            except Exception as exc:
                row["error"] = str(exc)

            results.append(row)
            print(f"[{engine}] {relative_path} -> {'ok' if row['success'] else row['error']}")

    report = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "meta": {
            "endpoint": args.endpoint,
            "imageCount": len(images),
            "engines": engines,
        },
        "summary": summarize(results),
        "bySite": summarize_by_site(results),
        "results": results,
    }

    os.makedirs(args.output_dir, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    json_path = os.path.join(args.output_dir, f"ocr-benchmark-{stamp}.json")
    md_path = os.path.join(args.output_dir, f"ocr-benchmark-{stamp}.md")

    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    with open(md_path, "w", encoding="utf-8") as handle:
        handle.write(to_markdown(report))

    print(json_path)
    print(md_path)


if __name__ == "__main__":
    main()
