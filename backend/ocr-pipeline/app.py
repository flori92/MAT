import base64
import importlib.util
import io
import os
import re
import threading
from statistics import mean
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from PIL import Image


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, ".cache")
os.makedirs(CACHE_DIR, exist_ok=True)
os.environ.setdefault("PADDLE_HOME", os.path.join(CACHE_DIR, "paddle"))
os.environ.setdefault("PADDLEX_HOME", os.path.join(CACHE_DIR, "paddlex"))
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", os.path.join(CACHE_DIR, "paddlex"))
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("HF_HOME", os.path.join(CACHE_DIR, "huggingface"))
os.environ.setdefault("TRANSFORMERS_CACHE", os.path.join(CACHE_DIR, "transformers"))


ENGINE_CACHE: dict[str, Any] = {}
ENGINE_LOCK = threading.Lock()
SUPPORTED_ENGINES = {"auto", "manga-stack", "paddle", "mangaocr", "doctr"}


class ImagePayload(BaseModel):
    base64: str
    mimeType: str = Field(..., alias="mimeType")


class OcrRequest(BaseModel):
    image: ImagePayload
    ocrEngine: str = Field(default="auto", alias="ocrEngine")
    context: dict[str, Any] | None = None


class TranslateRequest(BaseModel):
    text: str
    source: str = "en"
    target: str = "fr"
    context: dict[str, Any] | None = None


class BatchTranslateRequest(BaseModel):
    texts: list[str]
    source: str = "en"
    target: str = "fr"
    context: dict[str, Any] | None = None


app = FastAPI(title="Manwha OCR Pipeline", version="0.1.0")


def module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def normalize_text(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def clamp_score(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


def is_japanese_text(text: str) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u9fff]", text or ""))


def clip_bbox(bbox: dict[str, float]) -> dict[str, float] | None:
    try:
        x = max(0.0, min(1.0, float(bbox["x"])))
        y = max(0.0, min(1.0, float(bbox["y"])))
        width = max(0.0, min(1.0, float(bbox["width"])))
        height = max(0.0, min(1.0, float(bbox["height"])))
    except Exception:
        return None

    if width <= 0 or height <= 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def bbox_from_points(points: list[list[float]], width: int, height: int) -> dict[str, float] | None:
    if not points:
        return None

    xs = [float(point[0]) for point in points if len(point) >= 2]
    ys = [float(point[1]) for point in points if len(point) >= 2]
    if not xs or not ys:
        return None

    left = min(xs)
    right = max(xs)
    top = min(ys)
    bottom = max(ys)
    return clip_bbox({
        "x": left / max(width, 1),
        "y": top / max(height, 1),
        "width": max(1.0, right - left) / max(width, 1),
        "height": max(1.0, bottom - top) / max(height, 1),
    })


def bbox_from_xyxy(box: list[float], width: int, height: int) -> dict[str, float] | None:
    if len(box) < 4:
        return None

    left, top, right, bottom = [float(value) for value in box[:4]]
    return clip_bbox({
        "x": left / max(width, 1),
        "y": top / max(height, 1),
        "width": max(1.0, right - left) / max(width, 1),
        "height": max(1.0, bottom - top) / max(height, 1),
    })


def geometry_to_bbox(geometry: Any) -> dict[str, float] | None:
    if not geometry:
        return None

    if isinstance(geometry, (list, tuple)) and len(geometry) == 2 and all(isinstance(item, (list, tuple)) for item in geometry):
        try:
            (x0, y0), (x1, y1) = geometry
            return clip_bbox({
                "x": float(x0),
                "y": float(y0),
                "width": float(x1) - float(x0),
                "height": float(y1) - float(y0),
            })
        except Exception:
            return None

    return None


def decode_image(payload: ImagePayload) -> Image.Image:
    try:
      raw = base64.b64decode(payload.base64)
    except Exception as exc:
      raise HTTPException(status_code=400, detail=f"Invalid base64 image: {exc}") from exc

    try:
      image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
      raise HTTPException(status_code=400, detail=f"Invalid image payload: {exc}") from exc

    return image


def bbox_to_pixels(bbox: dict[str, float], image: Image.Image) -> tuple[int, int, int, int]:
    width, height = image.size
    left = max(0, int(bbox["x"] * width))
    top = max(0, int(bbox["y"] * height))
    right = min(width, int((bbox["x"] + bbox["width"]) * width))
    bottom = min(height, int((bbox["y"] + bbox["height"]) * height))
    return left, top, max(left + 1, right), max(top + 1, bottom)


def sort_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(blocks, key=lambda block: (block["bbox"]["y"], block["bbox"]["x"]))


def iou(a: dict[str, float], b: dict[str, float]) -> float:
    ax1 = a["x"]
    ay1 = a["y"]
    ax2 = a["x"] + a["width"]
    ay2 = a["y"] + a["height"]
    bx1 = b["x"]
    by1 = b["y"]
    bx2 = b["x"] + b["width"]
    by2 = b["y"] + b["height"]

    inter_left = max(ax1, bx1)
    inter_top = max(ay1, by1)
    inter_right = min(ax2, bx2)
    inter_bottom = min(ay2, by2)
    if inter_right <= inter_left or inter_bottom <= inter_top:
        return 0.0

    intersection = (inter_right - inter_left) * (inter_bottom - inter_top)
    area_a = a["width"] * a["height"]
    area_b = b["width"] * b["height"]
    union = area_a + area_b - intersection
    return intersection / union if union > 0 else 0.0


def center_inside(inner: dict[str, float], outer: dict[str, float]) -> bool:
    cx = inner["x"] + inner["width"] / 2
    cy = inner["y"] + inner["height"] / 2
    return (
        outer["x"] <= cx <= outer["x"] + outer["width"]
        and outer["y"] <= cy <= outer["y"] + outer["height"]
    )


def bbox_union(a: dict[str, float], b: dict[str, float]) -> dict[str, float]:
    left = min(a["x"], b["x"])
    top = min(a["y"], b["y"])
    right = max(a["x"] + a["width"], b["x"] + b["width"])
    bottom = max(a["y"] + a["height"], b["y"] + b["height"])
    return {
        "x": left,
        "y": top,
        "width": max(0.0, right - left),
        "height": max(0.0, bottom - top),
    }


def horizontal_overlap_ratio(a: dict[str, float], b: dict[str, float]) -> float:
    left = max(a["x"], b["x"])
    right = min(a["x"] + a["width"], b["x"] + b["width"])
    overlap = max(0.0, right - left)
    return overlap / max(1e-6, min(a["width"], b["width"]))


def vertical_overlap_ratio(a: dict[str, float], b: dict[str, float]) -> float:
    top = max(a["y"], b["y"])
    bottom = min(a["y"] + a["height"], b["y"] + b["height"])
    overlap = max(0.0, bottom - top)
    return overlap / max(1e-6, min(a["height"], b["height"]))


def vertical_gap(a: dict[str, float], b: dict[str, float]) -> float:
    top_gap = b["y"] - (a["y"] + a["height"])
    bottom_gap = a["y"] - (b["y"] + b["height"])
    return max(0.0, top_gap, bottom_gap)


def horizontal_gap(a: dict[str, float], b: dict[str, float]) -> float:
    left_gap = b["x"] - (a["x"] + a["width"])
    right_gap = a["x"] - (b["x"] + b["width"])
    return max(0.0, left_gap, right_gap)


def normalized_text_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", normalize_text(text).lower()).strip()


def join_unique_texts(texts: list[str]) -> str:
    seen: set[str] = set()
    ordered: list[str] = []
    for text in texts:
        normalized = normalized_text_key(text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalize_text(text))
    return normalize_text(" ".join(ordered))


def is_wide_strip_bbox(bbox: dict[str, float]) -> bool:
    return float(bbox.get("width") or 0.0) >= 0.45 and float(bbox.get("height") or 0.0) <= 0.12


def same_bubble_candidate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    bbox_a = a["bbox"]
    bbox_b = b["bbox"]
    if iou(bbox_a, bbox_b) >= 0.25:
        return True
    if center_inside(bbox_a, bbox_b) or center_inside(bbox_b, bbox_a):
        return True

    overlap_x = horizontal_overlap_ratio(bbox_a, bbox_b)
    gap_y = vertical_gap(bbox_a, bbox_b)
    center_ax = bbox_a["x"] + (bbox_a["width"] / 2)
    center_bx = bbox_b["x"] + (bbox_b["width"] / 2)
    center_dx = abs(center_ax - center_bx)
    width_scale = max(bbox_a["width"], bbox_b["width"])
    height_scale = max(bbox_a["height"], bbox_b["height"])

    if is_wide_strip_bbox(bbox_a) and is_wide_strip_bbox(bbox_b):
        return (
            overlap_x >= 0.60
            and gap_y <= min(0.028, height_scale * 0.65)
            and center_dx <= width_scale * 0.22
        )

    if (is_wide_strip_bbox(bbox_a) or is_wide_strip_bbox(bbox_b)) and gap_y > min(0.04, height_scale * 0.95):
        return False

    return (
        overlap_x >= 0.34
        and gap_y <= height_scale * 1.65
        and center_dx <= width_scale * 0.42
    )


def same_line_candidate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    bbox_a = a["bbox"]
    bbox_b = b["bbox"]
    overlap_y = vertical_overlap_ratio(bbox_a, bbox_b)
    gap_x = horizontal_gap(bbox_a, bbox_b)
    height_scale = max(bbox_a["height"], bbox_b["height"])
    center_ay = bbox_a["y"] + (bbox_a["height"] / 2)
    center_by = bbox_b["y"] + (bbox_b["height"] / 2)
    center_dy = abs(center_ay - center_by)

    if (
        center_dy <= height_scale * 0.75
        and gap_x <= max(0.02, height_scale * 1.8)
        and (
            overlap_y >= 0.30
            or is_wide_strip_bbox(bbox_a)
            or is_wide_strip_bbox(bbox_b)
        )
    ):
        return True

    return (
        overlap_y >= 0.58
        and gap_x <= max(0.05, height_scale * 3.5)
    )


def duplicate_candidate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if (
        iou(a["bbox"], b["bbox"]) >= 0.3
        or center_inside(a["bbox"], b["bbox"])
        or center_inside(b["bbox"], a["bbox"])
    ):
        return True

    if normalized_text_key(a.get("text", "")) and normalized_text_key(a.get("text", "")) == normalized_text_key(b.get("text", "")):
        overlap_y = vertical_overlap_ratio(a["bbox"], b["bbox"])
        center_ax = a["bbox"]["x"] + (a["bbox"]["width"] / 2)
        center_bx = b["bbox"]["x"] + (b["bbox"]["width"] / 2)
        center_dx = abs(center_ax - center_bx)
        width_scale = max(a["bbox"]["width"], b["bbox"]["width"])
        if overlap_y >= 0.45 and center_dx <= width_scale * 0.45:
            return True

    return False


def guess_block_type(text: str) -> str:
    normalized = normalize_text(text)
    if not normalized:
        return "dialogue"
    if len(normalized) >= 18:
        return "narration"
    if len(normalized) <= 8 and normalized.upper() == normalized:
        return "sfx"
    return "dialogue"


def bbox_area(bbox: dict[str, float]) -> float:
    return max(0.0, float(bbox.get("width", 0.0))) * max(0.0, float(bbox.get("height", 0.0)))


def text_quality_score(text: str) -> float:
    normalized = normalize_text(text)
    if not normalized:
        return 0.0

    compact = re.sub(r"\s+", "", normalized)
    alpha_count = sum(1 for char in compact if char.isalpha())
    digit_count = sum(1 for char in compact if char.isdigit())
    punctuation_count = sum(1 for char in compact if not char.isalnum())
    length = len(compact)

    score = 0.25
    score += min(0.22, length * 0.012)
    score += min(0.14, alpha_count * 0.01)

    if is_japanese_text(normalized):
        score += 0.16
    elif alpha_count > 0:
        score += 0.10

    if digit_count and digit_count >= alpha_count:
        score -= 0.08

    if punctuation_count > max(3, length // 2):
        score -= 0.08

    if re.search(r"[a-zA-Z]{2,}", normalized):
        score += 0.06

    if len(normalized.split()) >= 2:
        score += 0.05

    return clamp_score(score)


def score_candidate(block: dict[str, Any]) -> float:
    score = float(block.get("confidence") or 0.0) * 0.6
    text = normalize_text(block.get("text"))
    if not text:
        return -1.0

    score += text_quality_score(text) * 0.35
    score += min(0.08, bbox_area(block.get("bbox") or {}) * 1.6)

    engine = block.get("sourceEngine") or ""
    if "mangaocr" in engine:
        score += 0.15
    elif "paddle" in engine:
        score += 0.07
    elif "doctr" in engine:
        score += 0.05
    return score


def should_refine_with_mangaocr(text: str, confidence: float, requested_engine: str) -> bool:
    if requested_engine == "mangaocr":
        return True

    normalized = normalize_text(text)
    if not normalized:
        return False

    if is_japanese_text(normalized):
        return True

    return False


def summarize_quality(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    if not blocks:
        return {
            "score": 0.0,
            "avgConfidence": 0.0,
            "avgTextQuality": 0.0,
            "blockCount": 0,
            "needsVisionFallback": True,
        }

    confidences = [float(block.get("confidence") or 0.0) for block in blocks]
    text_scores = [text_quality_score(block.get("original") or block.get("text") or "") for block in blocks]
    coverage = sum(bbox_area(block.get("bbox") or {} ) for block in blocks)
    block_count = len(blocks)

    avg_confidence = mean(confidences) if confidences else 0.0
    avg_text_quality = mean(text_scores) if text_scores else 0.0
    block_bonus = min(0.12, block_count * 0.02)
    coverage_bonus = min(0.08, coverage * 0.8)
    score = clamp_score((avg_confidence * 0.48) + (avg_text_quality * 0.40) + block_bonus + coverage_bonus)

    needs_vision_fallback = (
        block_count == 0
        or score < 0.52
        or (block_count <= 1 and avg_confidence < 0.70)
        or (avg_text_quality < 0.42 and avg_confidence < 0.76)
    )

    return {
        "score": round(score, 4),
        "avgConfidence": round(avg_confidence, 4),
        "avgTextQuality": round(avg_text_quality, 4),
        "blockCount": block_count,
        "coverage": round(coverage, 4),
        "needsVisionFallback": needs_vision_fallback,
    }


def should_short_circuit_with_paddle(blocks: list[dict[str, Any]], quality: dict[str, Any]) -> bool:
    if not blocks or quality.get("needsVisionFallback"):
        return False
    if quality.get("score", 0.0) < 0.72 or quality.get("blockCount", 0) < 2:
        return False

    for block in blocks:
        text_quality = text_quality_score(block.get("original") or block.get("text") or "")
        width = float((block.get("bbox") or {}).get("width") or 0.0)
        if width >= 0.55 and text_quality < 0.72:
            return False
        if len(normalize_text(block.get("original") or block.get("text") or "")) >= 18 and text_quality < 0.68:
            return False

    return True


def get_engine(name: str, factory):
    with ENGINE_LOCK:
        if name not in ENGINE_CACHE:
            ENGINE_CACHE[name] = factory()
        return ENGINE_CACHE[name]


def create_paddle_engine():
    from paddleocr import PaddleOCR

    return PaddleOCR(
        use_angle_cls=True,
        lang=os.getenv("PADDLE_LANG", "en"),
    )


def run_paddle_page(image: Image.Image) -> list[dict[str, Any]]:
    if not module_available("paddleocr"):
        return []

    import numpy as np
    ocr = get_engine("paddle", create_paddle_engine)
    raw_result = ocr.ocr(np.array(image)) or []

    blocks: list[dict[str, Any]] = []
    width, height = image.size
    for page in raw_result:
        if isinstance(page, dict):
            texts = page.get("rec_texts") or []
            scores = page.get("rec_scores") or []
            polys = page.get("rec_polys") or page.get("dt_polys") or []
            for index, text_value in enumerate(texts):
                text = normalize_text(text_value)
                if not text:
                    continue
                polygon = polys[index] if index < len(polys) else None
                bbox = None
                if polygon is not None:
                    try:
                        bbox = bbox_from_points(polygon.tolist(), width, height)
                    except Exception:
                        bbox = None
                if not bbox:
                    continue
                confidence = float(scores[index]) if index < len(scores) else 0.0
                blocks.append({
                    "text": text,
                    "bbox": bbox,
                    "confidence": confidence,
                    "sourceEngine": "paddle",
                    "type": guess_block_type(text),
                })
            continue

        for line in page or []:
            if not isinstance(line, (list, tuple)) or len(line) < 2:
                continue
            bbox = bbox_from_points(line[0], width, height)
            if not bbox:
                continue
            text = normalize_text(line[1][0] if isinstance(line[1], (list, tuple)) else "")
            confidence = float(line[1][1]) if isinstance(line[1], (list, tuple)) and len(line[1]) > 1 else 0.0
            if not text:
                continue
            blocks.append({
                "text": text,
                "bbox": bbox,
                "confidence": confidence,
                "sourceEngine": "paddle",
                "type": guess_block_type(text),
            })
    return blocks


def run_doctr_page(image: Image.Image) -> list[dict[str, Any]]:
    if not module_available("doctr"):
        return []

    from doctr.io import DocumentFile
    from doctr.models import ocr_predictor

    def factory():
        return ocr_predictor(
            det_arch=os.getenv("DOCTR_DET_ARCH", "db_resnet50"),
            reco_arch=os.getenv("DOCTR_RECO_ARCH", "parseq"),
            pretrained=True,
        )

    predictor = get_engine("doctr", factory)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    doc = DocumentFile.from_images([encoded.getvalue()])
    export = predictor(doc).export()

    blocks: list[dict[str, Any]] = []
    for page in export.get("pages", []):
        for block in page.get("blocks", []):
            for line in block.get("lines", []):
                words = [normalize_text(word.get("value")) for word in line.get("words", [])]
                words = [word for word in words if word]
                text = normalize_text(" ".join(words))
                bbox = geometry_to_bbox(line.get("geometry") or block.get("geometry"))
                if not text or not bbox:
                    continue
                confidences = [float(word.get("confidence") or 0.0) for word in line.get("words", [])]
                confidence = sum(confidences) / len(confidences) if confidences else 0.0
                blocks.append({
                    "text": text,
                    "bbox": bbox,
                    "confidence": confidence,
                    "sourceEngine": "doctr",
                    "type": guess_block_type(text),
                })
    return blocks


def upscale_image(image: Image.Image, scale: int = 2) -> Image.Image:
    if scale <= 1:
        return image
    resampling = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
    return image.resize((image.width * scale, image.height * scale), resample=resampling)


def expand_bbox(bbox: dict[str, float], pad_x: float = 0.02, pad_y: float = 0.02) -> dict[str, float] | None:
    return clip_bbox({
        "x": bbox["x"] - pad_x,
        "y": bbox["y"] - pad_y,
        "width": bbox["width"] + (pad_x * 2),
        "height": bbox["height"] + (pad_y * 2),
    })


def project_crop_bbox_to_image(crop_bbox: dict[str, float], region_bbox: dict[str, float]) -> dict[str, float] | None:
    return clip_bbox({
        "x": region_bbox["x"] + (crop_bbox["x"] * region_bbox["width"]),
        "y": region_bbox["y"] + (crop_bbox["y"] * region_bbox["height"]),
        "width": crop_bbox["width"] * region_bbox["width"],
        "height": crop_bbox["height"] * region_bbox["height"],
    })


def run_doctr_crop(image: Image.Image, region_bbox: dict[str, float]) -> list[dict[str, Any]]:
    crop = image.crop(bbox_to_pixels(region_bbox, image))
    blocks = run_doctr_page(crop)
    remapped: list[dict[str, Any]] = []
    for block in blocks:
        bbox = project_crop_bbox_to_image(block["bbox"], region_bbox)
        if not bbox:
            continue
        remapped.append({
            **block,
            "bbox": bbox,
            "sourceEngine": "doctr-crop",
        })
    return remapped


def run_paddle_crop(image: Image.Image, region_bbox: dict[str, float], scale: int = 2) -> list[dict[str, Any]]:
    crop = image.crop(bbox_to_pixels(region_bbox, image))
    crop = upscale_image(crop, scale)
    blocks = run_paddle_page(crop)
    remapped: list[dict[str, Any]] = []
    for block in blocks:
        bbox = project_crop_bbox_to_image(block["bbox"], region_bbox)
        if not bbox:
            continue
        remapped.append({
            **block,
            "bbox": bbox,
            "sourceEngine": f'paddle-crop-x{scale}',
        })
    return remapped


def run_manga_ocr_crop(image: Image.Image, bbox: dict[str, float]) -> str | None:
    if not module_available("manga_ocr"):
        return None

    from manga_ocr import MangaOcr

    def factory():
        return MangaOcr()

    recognizer = get_engine("mangaocr", factory)
    crop = image.crop(bbox_to_pixels(bbox, image))
    text = normalize_text(recognizer(crop))
    return text or None


def collapse_duplicate_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[list[dict[str, Any]]] = []
    for candidate in sort_blocks(candidates):
        matched_cluster = None
        for cluster in clusters:
            if any(duplicate_candidate(candidate, other) for other in cluster):
                matched_cluster = cluster
                break
        if matched_cluster is None:
            clusters.append([candidate])
        else:
            matched_cluster.append(candidate)

    return [max(cluster, key=score_candidate) for cluster in clusters]


def split_wide_strip_cluster(cluster: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    ordered = sort_blocks(cluster)
    if sum(1 for block in ordered if is_wide_strip_bbox(block["bbox"])) < 2:
        return [ordered]

    groups: list[list[dict[str, Any]]] = []
    for block in ordered:
        if not groups:
            groups.append([block])
            continue

        previous = groups[-1][-1]
        gap_y = vertical_gap(previous["bbox"], block["bbox"])
        overlap_x = horizontal_overlap_ratio(previous["bbox"], block["bbox"])
        height_scale = max(previous["bbox"]["height"], block["bbox"]["height"])
        can_stay_in_group = (
            overlap_x >= 0.55
            and gap_y <= min(0.026, height_scale * 0.60)
        )

        if can_stay_in_group:
            groups[-1].append(block)
        else:
            groups.append([block])

    return groups


def should_merge_adjacent_fragments(a: dict[str, Any], b: dict[str, Any]) -> bool:
    bbox_a = a["bbox"]
    bbox_b = b["bbox"]
    overlap_y = vertical_overlap_ratio(bbox_a, bbox_b)
    gap_x = horizontal_gap(bbox_a, bbox_b)
    center_ay = bbox_a["y"] + (bbox_a["height"] / 2)
    center_by = bbox_b["y"] + (bbox_b["height"] / 2)
    center_dy = abs(center_ay - center_by)
    height_scale = max(bbox_a["height"], bbox_b["height"])

    if center_dy > height_scale * 0.75:
        return False
    if gap_x > max(0.02, height_scale * 1.8):
        return False
    if overlap_y < 0.20:
        return False

    text_a = normalize_text(a.get("text") or "")
    text_b = normalize_text(b.get("text") or "")
    if not text_a or not text_b:
        return False

    combined_text = join_unique_texts([text_a, text_b])
    combined_quality = text_quality_score(combined_text)
    current_quality = max(text_quality_score(text_a), text_quality_score(text_b))
    if combined_quality <= current_quality + 0.05:
        return False

    return True


def merge_adjacent_fragments(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sort_blocks(blocks)
    if len(ordered) < 2:
        return ordered

    merged: list[dict[str, Any]] = []
    index = 0
    while index < len(ordered):
        current = { **ordered[index] }
        next_index = index + 1
        while next_index < len(ordered) and should_merge_adjacent_fragments(current, ordered[next_index]):
            following = ordered[next_index]
            current = {
                **current,
                "text": join_unique_texts([current.get("text", ""), following.get("text", "")]),
                "bbox": bbox_union(current["bbox"], following["bbox"]),
                "confidence": mean([
                    float(current.get("confidence") or 0.0),
                    float(following.get("confidence") or 0.0),
                ]),
                "type": "narration" if (
                    current.get("type") == "narration"
                    or following.get("type") == "narration"
                    or len(join_unique_texts([current.get("text", ""), following.get("text", "")])) >= 18
                ) else (current.get("type") or following.get("type") or "dialogue"),
            }
            next_index += 1

        merged.append(current)
        index = next_index

    return sort_blocks(merged)


def merge_same_line_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[list[dict[str, Any]]] = []
    for candidate in sort_blocks(candidates):
        matched_cluster = None
        for cluster in clusters:
            if any(same_line_candidate(candidate, other) for other in cluster):
                matched_cluster = cluster
                break
        if matched_cluster is None:
            clusters.append([candidate])
        else:
            matched_cluster.append(candidate)

    merged: list[dict[str, Any]] = []
    for cluster in clusters:
        ordered = sorted(cluster, key=lambda block: block["bbox"]["x"])
        representative = max(ordered, key=score_candidate)

        union_bbox = ordered[0]["bbox"]
        for block in ordered[1:]:
            union_bbox = bbox_union(union_bbox, block["bbox"])

        spanning_blocks = [
            block for block in ordered
            if float(block["bbox"]["width"]) >= float(union_bbox["width"]) * 0.72
        ]
        if spanning_blocks:
            merged_text = normalize_text(max(spanning_blocks, key=score_candidate).get("text", ""))
        else:
            merged_text = join_unique_texts([block.get("text", "") for block in ordered])

        if not merged_text:
            continue

        avg_confidence = mean([float(block.get("confidence") or 0.0) for block in ordered])
        merged.append({
            **representative,
            "text": merged_text,
            "bbox": union_bbox,
            "confidence": avg_confidence,
        })

    return sort_blocks(merged)


def merge_multiline_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[list[dict[str, Any]]] = []
    for candidate in sort_blocks(candidates):
        matched_cluster = None
        for cluster in clusters:
            if any(same_bubble_candidate(candidate, other) for other in cluster):
                matched_cluster = cluster
                break
        if matched_cluster is None:
            clusters.append([candidate])
        else:
            matched_cluster.append(candidate)

    merged: list[dict[str, Any]] = []
    for cluster in clusters:
        for split_cluster in split_wide_strip_cluster(cluster):
            ordered = sort_blocks(split_cluster)
            representative = max(ordered, key=score_candidate)
            merged_text = join_unique_texts([block.get("text", "") for block in ordered])
            if not merged_text:
                continue

            union_bbox = ordered[0]["bbox"]
            for block in ordered[1:]:
                union_bbox = bbox_union(union_bbox, block["bbox"])

            avg_confidence = mean([float(block.get("confidence") or 0.0) for block in ordered])
            merged.append({
                **representative,
                "text": merged_text,
                "bbox": union_bbox,
                "confidence": avg_confidence,
                "type": "narration" if any(block.get("type") == "narration" for block in ordered) else (representative.get("type") or "dialogue"),
            })

    return sort_blocks(merged)


def collect_wide_strip_regions(candidates: list[dict[str, Any]]) -> list[dict[str, float]]:
    clusters: list[list[dict[str, Any]]] = []
    for candidate in sort_blocks(candidates):
        if not candidate.get("text"):
            continue

        matched_cluster = None
        for cluster in clusters:
            if any(same_line_candidate(candidate, other) for other in cluster):
                matched_cluster = cluster
                break

        if matched_cluster is None:
            clusters.append([candidate])
        else:
            matched_cluster.append(candidate)

    regions: list[dict[str, float]] = []
    for cluster in clusters:
        ordered = sorted(cluster, key=lambda block: block["bbox"]["x"])
        union_bbox = ordered[0]["bbox"]
        for block in ordered[1:]:
            union_bbox = bbox_union(union_bbox, block["bbox"])

        single_wide_candidate = (
            len(cluster) == 1
            and union_bbox["width"] >= 0.80
            and union_bbox["height"] <= 0.08
        )

        if (len(cluster) < 2 and not single_wide_candidate) or union_bbox["width"] < 0.55 or union_bbox["height"] > 0.10:
            continue

        text = join_unique_texts([block.get("text", "") for block in ordered])
        if len(text) < 14:
            continue

        region = expand_bbox(union_bbox, 0.04, 0.03)
        if region:
            regions.append(region)

    deduped: list[dict[str, float]] = []
    for region in regions:
        if any(iou(region, existing) >= 0.55 or center_inside(region, existing) or center_inside(existing, region) for existing in deduped):
            continue
        deduped.append(region)
    return deduped


def overlay_repair_candidates(
    grouped_candidates: list[dict[str, Any]],
    repair_candidates: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    remaining = list(grouped_candidates)
    for repair in repair_candidates:
        overlapping_indices = [
            index for index, existing in enumerate(remaining)
            if (
                iou(existing["bbox"], repair["bbox"]) >= 0.05
                or center_inside(existing["bbox"], repair["bbox"])
                or center_inside(repair["bbox"], existing["bbox"])
                or (
                    vertical_overlap_ratio(existing["bbox"], repair["bbox"]) >= 0.22
                    and horizontal_gap(existing["bbox"], repair["bbox"]) <= 0.03
                )
            )
        ]

        if not overlapping_indices:
            remaining.append(repair)
            continue

        existing_blocks = [remaining[index] for index in overlapping_indices]
        existing_text = join_unique_texts([block.get("text", "") for block in existing_blocks])
        existing_quality = text_quality_score(existing_text)
        repair_quality = text_quality_score(repair.get("text") or "")

        if repair_quality <= existing_quality + 0.06 and len(normalize_text(repair.get("text") or "")) <= len(existing_text):
            continue

        remaining = [
            block for index, block in enumerate(remaining)
            if index not in overlapping_indices
        ]
        remaining.append(repair)

    return sort_blocks(remaining)


def apply_caption_repairs_with_doctr(
    image: Image.Image,
    grouped_candidates: list[dict[str, Any]],
    raw_candidates: list[dict[str, Any]],
    requested_engine: str
) -> list[dict[str, Any]]:
    if requested_engine not in {"auto", "manga-stack"}:
        return grouped_candidates

    regions = collect_wide_strip_regions(raw_candidates)
    if not regions:
        return grouped_candidates

    doctr_full_page = run_doctr_page(image)
    if not doctr_full_page:
        return grouped_candidates

    merged_doctr_full_page = merge_adjacent_fragments(
        merge_multiline_candidates(
            merge_same_line_candidates(
                collapse_duplicate_candidates(doctr_full_page)
            )
        )
    )

    repair_candidates: list[dict[str, Any]] = []
    for region in regions:
        region_candidates = []

        overlapping = [
            candidate for candidate in merged_doctr_full_page
            if (
                iou(candidate["bbox"], region) >= 0.12
                or center_inside(candidate["bbox"], region)
            )
        ]
        region_candidates.extend(overlapping)

        crop_candidates = merge_adjacent_fragments(
            merge_multiline_candidates(
                merge_same_line_candidates(
                    collapse_duplicate_candidates(run_paddle_crop(image, region, 2) + run_doctr_crop(image, region))
                )
            )
        )
        region_candidates.extend([
            candidate for candidate in crop_candidates
            if (
                iou(candidate["bbox"], region) >= 0.12
                or center_inside(candidate["bbox"], region)
            )
        ])

        if not region_candidates:
            continue

        best = max(
            region_candidates,
            key=lambda candidate: (
                score_candidate(candidate)
                + text_quality_score(candidate.get("text") or "")
                + min(0.25, bbox_area(candidate["bbox"]))
            )
        )

        if len(normalize_text(best.get("text") or "")) < 14:
            continue

        repair_candidates.append({
            **best,
            "type": "narration",
            "sourceEngine": f'{best.get("sourceEngine", "doctr-crop")}+caption-repair',
        })

    if not repair_candidates:
        return grouped_candidates

    return overlay_repair_candidates(grouped_candidates, repair_candidates)


def repair_wide_strip_with_doctr(image: Image.Image, winner: dict[str, Any]) -> dict[str, Any]:
    if "doctr" in str(winner.get("sourceEngine") or ""):
        return winner
    if not is_wide_strip_bbox(winner["bbox"]):
        return winner
    if text_quality_score(winner.get("text") or "") >= 0.86:
        return winner

    region_bbox = expand_bbox(winner["bbox"], 0.04, 0.03)
    if not region_bbox:
        return winner

    doctr_candidates = run_doctr_crop(image, region_bbox)
    if not doctr_candidates:
        return winner

    doctr_merged = merge_multiline_candidates(
        merge_same_line_candidates(
            collapse_duplicate_candidates(doctr_candidates)
        )
    )
    overlapping = [
        block for block in doctr_merged
        if (
            iou(block["bbox"], winner["bbox"]) >= 0.18
            or center_inside(block["bbox"], winner["bbox"])
            or center_inside(winner["bbox"], block["bbox"])
        )
    ]
    if not overlapping:
        return winner

    best = max(
        overlapping,
        key=lambda block: score_candidate(block) + iou(block["bbox"], winner["bbox"]) + (text_quality_score(block.get("text") or "") * 0.2)
    )
    current_quality = text_quality_score(winner.get("text") or "")
    best_quality = text_quality_score(best.get("text") or "")
    if best_quality <= current_quality + 0.08:
        return winner

    return {
        **winner,
        "text": normalize_text(best.get("text") or winner.get("text") or ""),
        "bbox": best["bbox"],
        "confidence": max(float(winner.get("confidence") or 0.0), float(best.get("confidence") or 0.0)),
        "sourceEngine": f'{winner.get("sourceEngine", "unknown")}+doctr-crop',
        "type": guess_block_type(best.get("text") or winner.get("text") or ""),
    }


def merge_candidates(image: Image.Image, candidates: list[dict[str, Any]], requested_engine: str) -> list[dict[str, Any]]:
    if not candidates:
        return []

    grouped_candidates = merge_adjacent_fragments(merge_multiline_candidates(
        merge_same_line_candidates(
            collapse_duplicate_candidates(candidates)
        )
    ))
    grouped_candidates = apply_caption_repairs_with_doctr(image, grouped_candidates, candidates, requested_engine)
    merged: list[dict[str, Any]] = []
    for winner in grouped_candidates:
        text = winner["text"]

        if should_refine_with_mangaocr(text, float(winner.get("confidence") or 0.0), requested_engine):
            refined = run_manga_ocr_crop(image, winner["bbox"])
            if refined and (score_candidate({**winner, "text": refined, "sourceEngine": "mangaocr"}) >= score_candidate(winner)):
                winner = {
                    **winner,
                    "text": refined,
                    "confidence": max(float(winner.get("confidence") or 0.0), 0.9),
                    "sourceEngine": f'{winner.get("sourceEngine", "unknown")}+mangaocr',
                    "type": guess_block_type(refined),
                }

        merged.append({
            "original": winner["text"],
            "translated": "",
            "bbox": winner["bbox"],
            "confidence": winner.get("confidence"),
            "sourceEngine": winner.get("sourceEngine"),
            "type": winner.get("type") or "dialogue",
            "tone": "neutral",
            "style": None,
        })

    return sort_blocks(merged)


def build_plan(requested_engine: str) -> list[str]:
    if requested_engine == "paddle":
        return ["paddle"]
    if requested_engine == "doctr":
        return ["doctr"]
    if requested_engine == "mangaocr":
        return ["paddle", "doctr"]
    return ["paddle", "doctr"]


def execute_plan(image: Image.Image, requested_engine: str) -> dict[str, Any]:
    if requested_engine not in SUPPORTED_ENGINES:
        requested_engine = "auto"

    plan = build_plan(requested_engine)
    candidates: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    per_engine: dict[str, dict[str, Any]] = {}

    for engine_name in plan:
        try:
            if engine_name == "paddle":
                engine_candidates = run_paddle_page(image)
            elif engine_name == "doctr":
                engine_candidates = run_doctr_page(image)
            else:
                engine_candidates = []
            candidates.extend(engine_candidates)
            per_engine[engine_name] = {
                "candidateCount": len(engine_candidates),
                "avgConfidence": round(mean([float(block.get("confidence") or 0.0) for block in engine_candidates]), 4) if engine_candidates else 0.0,
            }
            if engine_name == "paddle" and requested_engine in {"auto", "manga-stack"}:
                paddle_blocks = merge_candidates(image, engine_candidates, requested_engine)
                paddle_quality = summarize_quality(paddle_blocks)
                per_engine[engine_name]["quality"] = paddle_quality
                if should_short_circuit_with_paddle(paddle_blocks, paddle_quality):
                    return {
                        "engine": "manga-stack",
                        "blocks": paddle_blocks,
                        "quality": paddle_quality,
                        "diagnostics": {
                            "plan": plan,
                            "available": available_engines(),
                            "errors": errors,
                            "perEngine": per_engine,
                            "quality": paddle_quality,
                            "shortCircuit": "paddle",
                        },
                    }
        except Exception as exc:
            errors[engine_name] = str(exc)
            per_engine[engine_name] = {
                "candidateCount": 0,
                "error": str(exc),
            }

    blocks = merge_candidates(image, candidates, requested_engine)
    quality = summarize_quality(blocks)
    engine_label = requested_engine if requested_engine not in {"auto", "manga-stack"} else "manga-stack"

    return {
        "engine": engine_label,
        "blocks": blocks,
        "quality": quality,
        "diagnostics": {
            "plan": plan,
            "available": available_engines(),
            "errors": errors,
            "perEngine": per_engine,
            "quality": quality,
        },
    }


def argos_available() -> bool:
    try:
        from argostranslate import translate as argos_translate
        langs = argos_translate.get_installed_languages()
        en = next((l for l in langs if l.code == "en"), None)
        fr = next((l for l in langs if l.code == "fr"), None)
        return en is not None and fr is not None
    except Exception:
        return False


def get_argos_translator():
    from argostranslate import translate as argos_translate
    langs = argos_translate.get_installed_languages()
    en = next(l for l in langs if l.code == "en")
    fr = next(l for l in langs if l.code == "fr")
    return en.get_translation(fr)


def translate_text_argos(text: str) -> str | None:
    normalized = normalize_text(text)
    if not normalized:
        return None
    try:
        translator = get_engine("argos_en_fr", get_argos_translator)
        result = translator.translate(normalized)
        return normalize_text(result) or None
    except Exception:
        return None


def translate_texts_argos(texts: list[str]) -> list[str | None]:
    results: list[str | None] = []
    for text in texts:
        results.append(translate_text_argos(text))
    return results


def translate_blocks(blocks: list[dict[str, Any]], source: str = "en", target: str = "fr") -> list[dict[str, Any]]:
    """Translate all blocks using the best available translation engine."""
    texts_to_translate = [block.get("original") or block.get("text") or "" for block in blocks]
    if not any(texts_to_translate):
        return blocks

    # Try local Helsinki model first, then Argos
    translations: list[str | None] = [None] * len(texts_to_translate)
    if can_translate_locally(source, target):
        translations = translate_texts_local(texts_to_translate, source, target)

    # Fill gaps with Argos
    if argos_available():
        for i, (text, tr) in enumerate(zip(texts_to_translate, translations)):
            if not tr and text:
                translations[i] = translate_text_argos(text)

    translated_blocks = []
    for block, tr in zip(blocks, translations):
        translated_blocks.append({
            **block,
            "translated": tr or block.get("translated") or "",
        })
    return translated_blocks


def available_engines() -> dict[str, bool]:
    return {
        "paddle": module_available("paddleocr"),
        "mangaocr": module_available("manga_ocr"),
        "doctr": module_available("doctr"),
        "translator": module_available("transformers") and module_available("sentencepiece"),
        "argos": argos_available(),
    }


def can_translate_locally(source: str, target: str) -> bool:
    return source == "en" and target == "fr" and available_engines()["translator"]


def get_local_translation_model_name() -> str:
    return os.getenv("LOCAL_TRANSLATION_MODEL", "Helsinki-NLP/opus-mt-en-fr")


def create_translation_engine():
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    model_name = get_local_translation_model_name()
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSeq2SeqLM.from_pretrained(model_name)
    model.eval()
    return tokenizer, model, torch


def translate_texts_local(texts: list[str], source: str = "en", target: str = "fr") -> list[str | None]:
    if not can_translate_locally(source, target):
        return [None for _ in texts]

    normalized_texts = [normalize_text(text) for text in texts]
    indexed_texts = [(index, text) for index, text in enumerate(normalized_texts) if text]
    if not indexed_texts:
        return [None for _ in texts]

    tokenizer, model, torch = get_engine("translator_en_fr", create_translation_engine)
    try:
        encoded = tokenizer(
            [text for _, text in indexed_texts],
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=256
        )
        with torch.no_grad():
            generated = model.generate(
                **encoded,
                max_new_tokens=256,
                num_beams=2
            )
    except Exception:
        return [None for _ in texts]

    if generated is None:
        return [None for _ in texts]

    decoded = [
        normalize_text(item)
        for item in tokenizer.batch_decode(generated, skip_special_tokens=True)
    ]
    results: list[str | None] = [None for _ in texts]
    for output_index, (input_index, _) in enumerate(indexed_texts):
        translated = decoded[output_index] if output_index < len(decoded) else ""
        results[input_index] = translated or None
    return results


def translate_text_local(text: str, source: str = "en", target: str = "fr") -> str | None:
    return translate_texts_local([text], source, target)[0]


def warmup_engines() -> None:
    try:
        if module_available("paddleocr"):
            get_engine("paddle", create_paddle_engine)
    except Exception:
        pass

    try:
        if available_engines()["translator"]:
            get_engine("translator_en_fr", create_translation_engine)
    except Exception:
        pass

    try:
        if argos_available():
            get_engine("argos_en_fr", get_argos_translator)
    except Exception:
        pass


@app.on_event("startup")
def schedule_warmup() -> None:
    threading.Thread(target=warmup_engines, daemon=True).start()


@app.get("/health")
def health() -> dict[str, Any]:
    engines = available_engines()
    return {
        "ok": True,
        "engines": engines,
        "recommended": "manga-stack",
        "translation": {
            "localModel": get_local_translation_model_name(),
            "localAvailable": engines["translator"],
            "argosAvailable": engines["argos"],
        },
    }


@app.get("/ocr/engines")
def list_engines() -> dict[str, Any]:
    return {
        "supported": sorted(SUPPORTED_ENGINES),
        "available": available_engines(),
    }


@app.post("/translate/local")
def translate_local(payload: TranslateRequest) -> dict[str, Any]:
    translated = translate_text_local(payload.text, payload.source, payload.target)
    if not translated:
        raise HTTPException(status_code=503, detail="Local translation model unavailable")

    return {
        "translation": translated,
        "engine": "local-translation-model",
        "model": get_local_translation_model_name(),
    }


@app.post("/translate/local-batch")
def translate_local_batch(payload: BatchTranslateRequest) -> dict[str, Any]:
    translations = translate_texts_local(payload.texts or [], payload.source, payload.target)
    if not any(translations):
        raise HTTPException(status_code=503, detail="Local translation model unavailable")

    return {
        "translations": translations,
        "engine": "local-translation-model",
        "model": get_local_translation_model_name(),
    }


@app.post("/translate/argos")
def translate_argos(payload: TranslateRequest) -> dict[str, Any]:
    translated = translate_text_argos(payload.text)
    if not translated:
        raise HTTPException(status_code=503, detail="Argos translation unavailable")
    return {
        "translation": translated,
        "engine": "argos",
    }


@app.post("/translate/argos-batch")
def translate_argos_batch(payload: BatchTranslateRequest) -> dict[str, Any]:
    translations = translate_texts_argos(payload.texts or [])
    if not any(translations):
        raise HTTPException(status_code=503, detail="Argos translation unavailable")
    return {
        "translations": translations,
        "engine": "argos",
    }


@app.post("/ocr/manga")
def ocr_manga(payload: OcrRequest) -> dict[str, Any]:
    image = decode_image(payload.image)
    result = execute_plan(image, payload.ocrEngine)
    target_lang = (payload.context or {}).get("targetLang", "fr")
    source_lang = (payload.context or {}).get("sourceLang", "en")
    blocks = translate_blocks(result["blocks"], source_lang, target_lang)
    return {
        "engine": result["engine"],
        "blocks": blocks,
        "diagnostics": result["diagnostics"],
    }
