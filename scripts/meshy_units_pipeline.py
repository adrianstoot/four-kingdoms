#!/usr/bin/env python3
"""Safe, resumable Meshy pipeline for the five Four Kingdoms humanoids.

The command is a dry-run unless --confirm-spend is supplied.  It deliberately
does not cancel or recreate remote tasks when polling is interrupted.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import re
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, MutableMapping, Sequence
from urllib.parse import urlparse

try:
    import requests
except ImportError:  # --help and --offline dry-runs must still work.
    requests = None  # type: ignore[assignment]

try:
    from PIL import Image, ImageOps
except ImportError:  # --help and balance-only must still work.
    Image = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]


API_BASE = "https://api.meshy.ai"
MODEL_COST = 15.0
RIG_COST = 5.0
MAX_RIG_FACES = 300_000
SUCCESS_STATES = {"SUCCEEDED", "SUCCESS", "COMPLETED", "COMPLETE"}
FAILURE_STATES = {"FAILED", "FAILURE", "CANCELED", "CANCELLED", "EXPIRED"}
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "meshy_output"
DEFAULT_STATE = DEFAULT_OUTPUT_ROOT / "pipeline_state.json"
DEFAULT_REFERENCES = DEFAULT_OUTPUT_ROOT / "reference_sheets"


@dataclass(frozen=True)
class UnitSpec:
    slug: str
    display_name: str
    reference_file: str
    target_polycount: int
    rig_height_m: float
    final_game_height_m: float
    texture_prompt: str
    pose_mode: str = "t-pose"


UNIT_SPECS: tuple[UnitSpec, ...] = (
    UnitSpec(
        "guard",
        "Guardia",
        "guardian-turnaround.png",
        18_000,
        1.70,
        1.70,
        "Match the supplied turnaround exactly: stylized fantasy human guard, closed steel helmet with blue plume, "
        "blue tabard, brown leather belt and boots, short steel sword, empty off hand, no shield. Hand-painted "
        "painterly low-poly game texture, clean material colors, no baked dramatic lighting.",
    ),
    UnitSpec(
        "archer",
        "Arquero",
        "archer-turnaround.png",
        18_000,
        1.70,
        1.70,
        "Match the supplied turnaround exactly: stylized male elf archer with pointed ears, green hood and tunic, "
        "brown leather belt and boots, curved wooden bow, quiver and arrows. Hand-painted painterly low-poly game "
        "texture, clean material colors, no baked dramatic lighting.",
    ),
    UnitSpec(
        "giant",
        "Gigante",
        "giant-turnaround.png",
        22_000,
        2.50,
        2.50,
        "Match the supplied turnaround exactly: stylized broad muscular fantasy giant, bare chest, dark brown beard, "
        "primitive brown skirt, heavy belt, leather bracers, bare feet, empty hands, no weapon. Hand-painted painterly "
        "low-poly game texture, clean material colors, no baked dramatic lighting.",
    ),
    UnitSpec(
        "commander",
        "Comandante",
        "commander-turnaround.png",
        22_000,
        1.90,
        1.90,
        "Match the supplied turnaround exactly: stylized human king commander with brown beard, gold crown, red cape "
        "and fur collar, royal tunic and steel sword. Hand-painted painterly low-poly game texture, clean material "
        "colors, no baked dramatic lighting.",
    ),
    # Only the humanoid rider is rigged here.  The mounted assembly is scaled to 2.20 m in-game.
    UnitSpec(
        "knight",
        "Caballero (jinete)",
        "knight-rider-turnaround.png",
        22_000,
        1.78,
        2.20,
        "Match the supplied turnaround exactly: stylized human mounted-knight rider only, blue-and-gold steel armor, "
        "closed helmet with blue plume and a two-handed double-bit battle axe; no horse, no shield and no lance. "
        "Hand-painted painterly low-poly game texture, clean material colors, no baked dramatic lighting.",
    ),
)


class PipelineError(RuntimeError):
    """A recoverable pipeline failure whose state remains on disk."""


class AmbiguousSpendError(PipelineError):
    """A POST may have succeeded but its task id was not durably recorded."""


class MeshyHTTPError(PipelineError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def compact_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def safe_task_prefix(task_id: str) -> str:
    prefix = re.sub(r"[^A-Za-z0-9]", "", task_id)[:10]
    return prefix or "task"


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PipelineError(f"No se puede leer el estado {path}: {exc}") from exc


def new_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "api_base": API_BASE,
        "units": {},
    }


def save_state(path: Path, state: MutableMapping[str, Any]) -> None:
    state["updated_at"] = utc_now()
    write_json_atomic(path, state)


def parse_env_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        if separator and key.strip() == "MESHY_API_KEY":
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            return value or None
    return None


def find_api_key(explicit_env_file: Path | None) -> tuple[str | None, str | None]:
    from_environment = os.environ.get("MESHY_API_KEY", "").strip()
    if from_environment:
        return from_environment, "variable de entorno MESHY_API_KEY"

    candidates: list[Path] = []
    if explicit_env_file:
        candidates.append(explicit_env_file)
    candidates.extend(
        (
            Path.cwd() / ".env",
            Path.cwd() / ".env.local",
            REPO_ROOT / ".env",
            REPO_ROOT / ".env.local",
        )
    )
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        key = parse_env_file(resolved)
        if key:
            return key, f"archivo {resolved}"
    return None, None


def redact(value: Any, secret: str | None = None) -> Any:
    """Return a JSON-safe value without credentials or embedded source images."""
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if any(token in lowered for token in ("authorization", "api_key", "apikey", "token")):
                result[str(key)] = "<redacted>"
            else:
                result[str(key)] = redact(item, secret)
        return result
    if isinstance(value, (list, tuple)):
        return [redact(item, secret) for item in value]
    if isinstance(value, str):
        text = value.replace(secret, "<redacted>") if secret else value
        if text.startswith("data:image/"):
            return f"<embedded image: {len(text)} chars>"
        return text
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def choose_view_count(width: int, height: int) -> int:
    ratio = width / max(1, height)
    if ratio >= 1.72:
        return 4
    if ratio >= 1.28:
        return 3
    return 1


def prepare_reference_views(path: Path, max_edge: int = 1024) -> list[tuple[str, bytes]]:
    if Image is None or ImageOps is None:
        raise PipelineError("Falta Pillow. Instala la dependencia con: python -m pip install Pillow")
    if not path.is_file():
        raise PipelineError(f"No existe la hoja de referencia: {path}")

    with Image.open(path) as source:
        source = ImageOps.exif_transpose(source).convert("RGB")
        width, height = source.size
        count = choose_view_count(width, height)
        views: list[tuple[str, bytes]] = []
        for index in range(count):
            left = round(width * index / count)
            right = round(width * (index + 1) / count)
            inset = max(1, round((right - left) * 0.008))
            panel = source.crop((left + inset, 0, right - inset, height))
            panel.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            from io import BytesIO

            encoded = BytesIO()
            panel.save(encoded, format="JPEG", quality=92, optimize=True, progressive=True)
            views.append((f"view_{index + 1:02d}.jpg", encoded.getvalue()))
        return views


def data_uri(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")


def task_id_from(payload: Mapping[str, Any]) -> str:
    for key in ("id", "task_id", "taskId"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    result = payload.get("result")
    if isinstance(result, str) and result:
        return result
    if isinstance(result, Mapping):
        return task_id_from(result)
    raise PipelineError("Meshy no devolvió un task id reconocible; no se repetirá el POST automáticamente.")


def task_status(payload: Mapping[str, Any]) -> str:
    for key in ("status", "state", "task_status"):
        value = payload.get(key)
        if isinstance(value, str):
            return value.upper()
    result = payload.get("result")
    if isinstance(result, Mapping):
        return task_status(result)
    return "UNKNOWN"


def task_progress(payload: Mapping[str, Any]) -> float | None:
    for key in ("progress", "percentage", "percent"):
        value = payload.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    result = payload.get("result")
    if isinstance(result, Mapping):
        return task_progress(result)
    return None


def recursive_numbers(payload: Any, accepted_keys: set[str]) -> list[float]:
    found: list[float] = []
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in accepted_keys and isinstance(value, (int, float)):
                found.append(float(value))
            found.extend(recursive_numbers(value, accepted_keys))
    elif isinstance(payload, (list, tuple)):
        for value in payload:
            found.extend(recursive_numbers(value, accepted_keys))
    return found


def extract_balance(payload: Any) -> float:
    candidates = recursive_numbers(payload, {"balance", "credit_balance", "remaining_credits", "credits"})
    if not candidates:
        raise PipelineError(f"Respuesta de saldo no reconocida: {redact(payload)}")
    return candidates[0]


def extract_consumed_credits(payload: Any) -> float | None:
    candidates = recursive_numbers(
        payload,
        {"consumed_credits", "credits_consumed", "credit_cost", "credits_used", "cost_credits"},
    )
    return candidates[0] if candidates else None


def extract_face_count(payload: Any) -> int | None:
    candidates = recursive_numbers(
        payload,
        {"face_count", "faces_count", "polygon_count", "poly_count", "polycount"},
    )
    return round(max(candidates)) if candidates else None


def walk_items(payload: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], Any]]:
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            child_path = (*path, str(key))
            yield child_path, value
            yield from walk_items(value, child_path)
    elif isinstance(payload, (list, tuple)):
        for index, value in enumerate(payload):
            child_path = (*path, str(index))
            yield child_path, value
            yield from walk_items(value, child_path)


def url_candidates(payload: Any, required_terms: Sequence[str]) -> list[tuple[int, str]]:
    candidates: list[tuple[int, str]] = []
    for path, value in walk_items(payload):
        if not isinstance(value, str) or not value.startswith(("http://", "https://")):
            continue
        name = "/".join(path).lower()
        url_path = urlparse(value).path.lower()
        score = sum(5 for term in required_terms if term in name)
        score += sum(2 for term in required_terms if term in url_path)
        if "glb" in required_terms and url_path.endswith(".glb"):
            score += 6
        if "refined" in name or "textured" in name:
            score += 3
        candidates.append((score, value))
    return sorted(candidates, key=lambda item: item[0], reverse=True)


def find_url(payload: Any, required_terms: Sequence[str], minimum_score: int = 5) -> str | None:
    candidates = url_candidates(payload, required_terms)
    return candidates[0][1] if candidates and candidates[0][0] >= minimum_score else None


def find_thumbnail_url(payload: Any) -> str | None:
    direct = find_url(payload, ("thumbnail",), minimum_score=5)
    if direct:
        return direct
    for _, value in walk_items(payload):
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            suffix = urlparse(value).path.lower()
            if suffix.endswith((".png", ".jpg", ".jpeg", ".webp")):
                return value
    return None


class MeshyClient:
    def __init__(
        self,
        api_key: str,
        api_base: str = API_BASE,
        connect_timeout: float = 15.0,
        read_timeout: float = 90.0,
        max_retries: int = 7,
    ) -> None:
        if requests is None:
            raise PipelineError("Falta requests. Instala la dependencia con: python -m pip install requests")
        self._secret = api_key
        self.api_base = api_base.rstrip("/")
        self.timeout = (connect_timeout, read_timeout)
        self.max_retries = max_retries
        self.session = requests.Session()
        # Explicitly ignore HTTP(S)_PROXY and other ambient proxy credentials.
        self.session.trust_env = False
        self.session.headers.update({"Authorization": f"Bearer {api_key}", "Accept": "application/json"})

    def _request(
        self,
        method: str,
        endpoint: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        stream: bool = False,
    ) -> Any:
        url = endpoint if endpoint.startswith(("http://", "https://")) else self.api_base + endpoint
        headers: dict[str, str] = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        is_post = method.upper() == "POST"
        for attempt in range(self.max_retries + 1):
            try:
                response = self.session.request(
                    method,
                    url,
                    json=json_body,
                    headers=headers,
                    timeout=self.timeout,
                    stream=stream,
                )
            except requests.RequestException as exc:  # type: ignore[union-attr]
                if is_post:
                    raise AmbiguousSpendError(
                        "Network failure during a paid POST. It will not be retried because the task may exist; "
                        "adopt its task id from the Meshy dashboard before resuming."
                    ) from exc
                if attempt >= self.max_retries:
                    raise PipelineError(
                        f"Fallo de red tras {attempt + 1} intentos. El POST queda en estado ambiguo y no se repetirá: "
                        f"{type(exc).__name__}"
                    ) from exc
                self._backoff(attempt, None)
                continue

            if response.status_code == 429 or 500 <= response.status_code <= 599:
                if is_post:
                    if response.status_code == 429:
                        raise MeshyHTTPError(429, "Meshy HTTP 429: rate limited; the POST was not retried.")
                    raise AmbiguousSpendError(
                        f"Meshy returned HTTP {response.status_code} during a paid POST. It will not be retried; "
                        "check the dashboard and adopt the task id if it exists."
                    )
                if attempt >= self.max_retries:
                    raise PipelineError(
                        f"Meshy devolvió HTTP {response.status_code} tras {attempt + 1} intentos. "
                        "El estado se conserva para reanudar."
                    )
                self._backoff(attempt, response.headers.get("Retry-After"))
                continue

            if response.status_code >= 400:
                excerpt = response.text[:600].replace(self._secret, "<redacted>")
                raise MeshyHTTPError(response.status_code, f"Meshy HTTP {response.status_code}: {excerpt}")

            if stream:
                return response
            try:
                return response.json()
            except ValueError as exc:
                raise PipelineError(f"Meshy devolvió JSON inválido en {endpoint}.") from exc

        raise AssertionError("bucle de reintentos inalcanzable")

    @staticmethod
    def _backoff(attempt: int, retry_after: str | None) -> None:
        if retry_after:
            try:
                delay = min(30.0, max(0.5, float(retry_after)))
            except ValueError:
                delay = 0.0
        else:
            delay = 0.0
        if delay <= 0:
            delay = min(30.0, 1.5 * (2**attempt)) + random.uniform(0.0, 0.5)
        time.sleep(delay)

    def get_balance(self) -> tuple[float, Any]:
        payload = self._request("GET", "/openapi/v1/balance")
        return extract_balance(payload), payload

    def create_model(self, payload: Mapping[str, Any], idempotency_key: str) -> Any:
        return self._request(
            "POST",
            "/openapi/v1/multi-image-to-3d",
            json_body=payload,
            idempotency_key=idempotency_key,
        )

    def get_model(self, task_id: str) -> Any:
        return self._request("GET", f"/openapi/v1/multi-image-to-3d/{task_id}")

    def create_rig(self, payload: Mapping[str, Any], idempotency_key: str) -> Any:
        return self._request("POST", "/openapi/v1/rigging", json_body=payload, idempotency_key=idempotency_key)

    def get_rig(self, task_id: str) -> Any:
        return self._request("GET", f"/openapi/v1/rigging/{task_id}")

    def download(self, url: str, destination: Path, expect_glb: bool = False) -> None:
        if destination.is_file() and destination.stat().st_size > 0:
            if not expect_glb or has_glb_magic(destination):
                return
        destination.parent.mkdir(parents=True, exist_ok=True)
        response = self._request("GET", url, stream=True)
        temporary = destination.with_suffix(destination.suffix + ".part")
        with temporary.open("wb") as stream:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    stream.write(chunk)
        if expect_glb and not has_glb_magic(temporary):
            temporary.unlink(missing_ok=True)
            raise PipelineError(f"La descarga no es un GLB válido: {destination.name}")
        os.replace(temporary, destination)

def has_glb_magic(path: Path) -> bool:
    with path.open("rb") as stream:
        return stream.read(4) == b"glTF"



def append_history(unit: MutableMapping[str, Any], event: str, **details: Any) -> None:
    history = unit.setdefault("history", [])
    history.append({"at": utc_now(), "event": event, **redact(details)})


def output_dir_for(output_root: Path, unit: Mapping[str, Any]) -> Path:
    stored = unit.get("output_dir")
    if not isinstance(stored, str) or not stored:
        raise PipelineError("La unidad todavía no tiene directorio de salida porque no existe task id.")
    candidate = Path(stored)
    return candidate if candidate.is_absolute() else output_root / candidate


def unit_metadata(unit: Mapping[str, Any]) -> dict[str, Any]:
    model = unit.get("model", {}) if isinstance(unit.get("model"), Mapping) else {}
    rig = unit.get("rig", {}) if isinstance(unit.get("rig"), Mapping) else {}
    consumed_values = [
        value
        for value in (model.get("consumed_credits"), rig.get("consumed_credits"))
        if isinstance(value, (int, float))
    ]
    return {
        "schema_version": 1,
        "slug": unit.get("slug"),
        "display_name": unit.get("display_name"),
        "created_at": unit.get("created_at"),
        "updated_at": utc_now(),
        "reference": unit.get("reference"),
        "spec": unit.get("spec"),
        "model": redact(model),
        "rig": redact(rig),
        "expected_credits": MODEL_COST + RIG_COST,
        "consumed_credits": sum(consumed_values) if consumed_values else None,
        "downloads": unit.get("downloads", {}),
    }


def sync_unit_files(output_root: Path, unit: MutableMapping[str, Any]) -> None:
    if not unit.get("output_dir"):
        return
    directory = output_dir_for(output_root, unit)
    directory.mkdir(parents=True, exist_ok=True)
    write_json_atomic(directory / "metadata.json", unit_metadata(unit))
    write_json_atomic(directory / "history.json", unit.get("history", []))
    sync_global_history(output_root, unit)


def sync_global_history(output_root: Path, unit: Mapping[str, Any]) -> None:
    history_path = output_root / "history.json"
    history = load_json(history_path, {"version": 1, "projects": []})
    if not isinstance(history, MutableMapping) or history.get("version") != 1:
        raise PipelineError(f"Unsupported history format: {history_path}")
    projects = history.setdefault("projects", [])
    if not isinstance(projects, list):
        raise PipelineError(f"Unsupported projects format: {history_path}")

    folder = str(unit.get("output_dir", ""))
    model = unit.get("model", {}) if isinstance(unit.get("model"), Mapping) else {}
    rig = unit.get("rig", {}) if isinstance(unit.get("rig"), Mapping) else {}
    entry = next(
        (item for item in projects if isinstance(item, Mapping) and item.get("folder") == folder),
        None,
    )
    spec = unit.get("spec", {}) if isinstance(unit.get("spec"), Mapping) else {}
    payload = {
        "folder": folder,
        "slug": unit.get("slug"),
        "prompt": spec.get("texture_prompt"),
        "task_type": "multi-image-to-3d+rigging",
        "root_task_id": model.get("task_id"),
        "rig_task_id": rig.get("task_id"),
        "created_at": unit.get("created_at"),
        "updated_at": utc_now(),
        "status": unit.get("phase"),
        "task_count": sum(bool(stage.get("task_id")) for stage in (model, rig)),
        "expected_credits": MODEL_COST + RIG_COST,
        "consumed_credits": unit_metadata(unit).get("consumed_credits"),
    }
    if isinstance(entry, MutableMapping):
        entry.update(payload)
    else:
        projects.append(payload)
    write_json_atomic(history_path, history)


def poll_task(
    fetch: Callable[[str], Mapping[str, Any]],
    task_id: str,
    kind: str,
    unit: MutableMapping[str, Any],
    state: MutableMapping[str, Any],
    state_path: Path,
    output_root: Path,
    timeout_seconds: float,
) -> Mapping[str, Any]:
    started = time.monotonic()
    delay = 5.0
    last_marker: tuple[str, int | None] | None = None
    while True:
        payload = fetch(task_id)
        status = task_status(payload)
        progress = task_progress(payload)
        marker = (status, round(progress) if progress is not None else None)
        stage = unit.setdefault(kind, {})
        stage.update({"task_id": task_id, "status": status, "progress": progress, "last_checked_at": utc_now()})
        if marker != last_marker:
            print(f"  {kind} {task_id[:10]}: {status}" + (f" {progress:.0f}%" if progress is not None else ""))
            append_history(unit, f"{kind}_poll", task_id=task_id, status=status, progress=progress)
            last_marker = marker
        save_state(state_path, state)
        sync_unit_files(output_root, unit)

        if status in SUCCESS_STATES:
            return payload
        if status in FAILURE_STATES:
            error = payload.get("task_error") or payload.get("error") or payload.get("message")
            raise PipelineError(f"La tarea {kind} {task_id} terminó como {status}: {redact(error)}")
        if time.monotonic() - started >= timeout_seconds:
            raise PipelineError(
                f"Tiempo local de espera agotado para {kind} {task_id}. La tarea NO se canceló; "
                "ejecuta el mismo comando para reanudar."
            )

        # 99% is explicitly treated as still running; it is never killed or recreated.
        time.sleep(delay)
        delay = min(30.0, delay * 1.35)


def record_consumed(stage: MutableMapping[str, Any], payload: Any) -> None:
    explicit = extract_consumed_credits(payload)
    if explicit is not None:
        stage["consumed_credits"] = explicit
        stage["consumed_credits_source"] = "meshy_response"
        return
    before = stage.get("balance_before_create")
    after = stage.get("balance_after_create")
    if isinstance(before, (int, float)) and isinstance(after, (int, float)) and before >= after:
        stage["consumed_credits"] = float(before) - float(after)
        stage["consumed_credits_source"] = "balance_delta"


def assert_balance(balance: float, required: float, context: str) -> None:
    if balance + 1e-9 < required:
        raise PipelineError(
            f"Saldo insuficiente antes de {context}: {balance:g} créditos disponibles, {required:g} necesarios. "
            "No se creó ninguna tarea nueva."
        )


def create_output_folder(
    output_root: Path,
    unit: MutableMapping[str, Any],
    task_id: str,
    prepared_views: Sequence[tuple[str, bytes]] | None = None,
) -> None:
    if not unit.get("output_dir"):
        folder = f"{unit['created_at_compact']}_{unit['slug']}_{safe_task_prefix(task_id)}"
        unit["output_dir"] = folder
    directory = output_dir_for(output_root, unit)
    directory.mkdir(parents=True, exist_ok=True)
    if prepared_views:
        reference_dir = directory / "reference_views"
        reference_dir.mkdir(parents=True, exist_ok=True)
        for filename, content in prepared_views:
            destination = reference_dir / filename
            if not destination.exists():
                destination.write_bytes(content)


def initialize_unit(state: MutableMapping[str, Any], spec: UnitSpec, reference: Path) -> MutableMapping[str, Any]:
    units = state.setdefault("units", {})
    unit = units.setdefault(spec.slug, {})
    if not unit:
        created = compact_timestamp()
        unit.update(
            {
                "slug": spec.slug,
                "display_name": spec.display_name,
                "created_at": utc_now(),
                "created_at_compact": created,
                "phase": "planned",
                "reference": {
                    "path": str(reference.resolve()),
                    "sha256": sha256_file(reference),
                },
                "spec": asdict(spec),
                "model": {},
                "rig": {},
                "downloads": {},
                "history": [],
            }
        )
        append_history(unit, "planned", reference=str(reference), spec=asdict(spec))
    else:
        recorded_hash = unit.get("reference", {}).get("sha256") if isinstance(unit.get("reference"), Mapping) else None
        current_hash = sha256_file(reference)
        if recorded_hash and recorded_hash != current_hash:
            raise PipelineError(
                f"La hoja de {spec.slug} cambió desde que se creó el estado. Usa un state nuevo para evitar mezclar tareas."
            )
    return unit


def ensure_not_ambiguous(unit: Mapping[str, Any], kind: str) -> None:
    phase = str(unit.get("phase", ""))
    stage = unit.get(kind, {})
    task_id = stage.get("task_id") if isinstance(stage, Mapping) else None
    if phase == f"creating_{kind}" and not task_id:
        flag = "--adopt-model-task" if kind == "model" else "--adopt-rig-task"
        raise AmbiguousSpendError(
            f"{unit.get('slug')}: existe un POST {kind} ambiguo. No se repetirá para evitar doble gasto. "
            f"Busca el task id en el panel de Meshy y reanuda con {flag} {unit.get('slug')}=TASK_ID."
        )


def thumbnail_filename(url: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        suffix = ".png"
    return "thumbnail" + suffix


def download_results(
    client: MeshyClient,
    output_root: Path,
    unit: MutableMapping[str, Any],
    model_result: Mapping[str, Any],
    rig_result: Mapping[str, Any],
) -> None:
    directory = output_dir_for(output_root, unit)
    downloads = unit.setdefault("downloads", {})

    model_url = find_url(model_result, ("glb",), minimum_score=6)
    rigged_url = find_url(rig_result, ("rigged", "glb"), minimum_score=10)
    walking_url = find_url(rig_result, ("walking", "glb"), minimum_score=10)
    running_url = find_url(rig_result, ("running", "glb"), minimum_score=10)
    thumbnail_url = find_thumbnail_url(model_result) or find_thumbnail_url(rig_result)

    required = {
        "model_refined.glb": model_url,
        "model_rigged.glb": rigged_url,
        "animation_walking.glb": walking_url,
        "animation_running.glb": running_url,
    }
    missing = [filename for filename, url in required.items() if not url]
    if missing:
        raise PipelineError(f"Meshy completó la tarea, pero faltan URLs para: {', '.join(missing)}")

    for filename, url in required.items():
        assert url is not None
        client.download(url, directory / filename, expect_glb=True)
        downloads[filename] = {"url": url, "bytes": (directory / filename).stat().st_size}
        append_history(unit, "downloaded", file=filename, bytes=(directory / filename).stat().st_size)

    if thumbnail_url:
        filename = thumbnail_filename(thumbnail_url)
        client.download(thumbnail_url, directory / filename, expect_glb=False)
        downloads[filename] = {"url": thumbnail_url, "bytes": (directory / filename).stat().st_size}
        append_history(unit, "downloaded", file=filename, bytes=(directory / filename).stat().st_size)


def run_unit(
    client: MeshyClient,
    spec: UnitSpec,
    references_dir: Path,
    output_root: Path,
    state: MutableMapping[str, Any],
    state_path: Path,
    timeout_seconds: float,
) -> None:
    reference = references_dir / spec.reference_file
    unit = initialize_unit(state, spec, reference)
    ensure_not_ambiguous(unit, "model")
    ensure_not_ambiguous(unit, "rig")
    model = unit.setdefault("model", {})
    rig = unit.setdefault("rig", {})
    prepared_views: list[tuple[str, bytes]] | None = None

    model_task_id = model.get("task_id")
    if not isinstance(model_task_id, str) or not model_task_id:
        prepared_views = prepare_reference_views(reference)
        balance_before, _ = client.get_balance()
        assert_balance(balance_before, MODEL_COST, f"crear el modelo de {spec.slug}")
        request_id = model.get("request_id") or str(uuid.uuid4())
        model.update({"request_id": request_id, "balance_before_create": balance_before})
        unit["phase"] = "creating_model"
        append_history(unit, "model_create_intent", request_id=request_id, balance=balance_before)
        save_state(state_path, state)

        payload = {
            "image_urls": [data_uri(content) for _, content in prepared_views],
            "ai_model": "meshy-5",
            "should_texture": True,
            "enable_pbr": True,
            "texture_prompt": spec.texture_prompt,
            "target_formats": ["glb"],
            "multi_view_thumbnails": True,
            "topology": "triangle",
            "target_polycount": spec.target_polycount,
            "pose_mode": spec.pose_mode,
        }
        try:
            created = client.create_model(payload, request_id)
        except MeshyHTTPError as exc:
            # A definitive 4xx rejection did not create a task; a later corrected run may retry.
            model["last_rejection"] = {"at": utc_now(), "status": exc.status_code, "message": str(exc)}
            unit["phase"] = "model_create_rejected"
            append_history(unit, "model_create_rejected", status=exc.status_code, message=str(exc))
            save_state(state_path, state)
            raise
        model_task_id = task_id_from(created)
        model.update({"task_id": model_task_id, "create_response": redact(created), "status": "CREATED"})
        unit["phase"] = "model_created"
        create_output_folder(output_root, unit, model_task_id, prepared_views)
        save_state(state_path, state)
        sync_unit_files(output_root, unit)
        balance_after, _ = client.get_balance()
        model["balance_after_create"] = balance_after
        record_consumed(model, created)
        append_history(unit, "model_created", task_id=model_task_id, balance_after=balance_after)
        save_state(state_path, state)
        sync_unit_files(output_root, unit)
    else:
        create_output_folder(output_root, unit, model_task_id)

    print(f"[{spec.slug}] modelo {model_task_id}")
    model_result = poll_task(
        client.get_model,
        model_task_id,
        "model",
        unit,
        state,
        state_path,
        output_root,
        timeout_seconds,
    )
    model["result"] = redact(model_result)
    record_consumed(model, model_result)
    face_count = extract_face_count(model_result)
    model["face_count"] = face_count
    save_state(state_path, state)
    sync_unit_files(output_root, unit)
    if face_count is None:
        raise PipelineError(
            "Meshy did not report a face count. Rigging was not started; verify the model is at most "
            f"{MAX_RIG_FACES:,} faces before resuming."
        )
    if face_count > MAX_RIG_FACES:
        raise PipelineError(
            f"Rigging blocked: the model has {face_count:,} faces (limit {MAX_RIG_FACES:,}). Remesh it first."
        )
    unit["phase"] = "model_succeeded"
    append_history(unit, "model_succeeded", task_id=model_task_id)
    save_state(state_path, state)
    sync_unit_files(output_root, unit)

    rig_task_id = rig.get("task_id")
    if not isinstance(rig_task_id, str) or not rig_task_id:
        balance_before, _ = client.get_balance()
        assert_balance(balance_before, RIG_COST, f"riggear {spec.slug}")
        request_id = rig.get("request_id") or str(uuid.uuid4())
        rig.update({"request_id": request_id, "balance_before_create": balance_before})
        unit["phase"] = "creating_rig"
        append_history(unit, "rig_create_intent", request_id=request_id, balance=balance_before)
        save_state(state_path, state)
        try:
            created = client.create_rig(
                {"input_task_id": model_task_id, "height_meters": spec.rig_height_m},
                request_id,
            )
        except MeshyHTTPError as exc:
            rig["last_rejection"] = {"at": utc_now(), "status": exc.status_code, "message": str(exc)}
            unit["phase"] = "rig_create_rejected"
            append_history(unit, "rig_create_rejected", status=exc.status_code, message=str(exc))
            save_state(state_path, state)
            sync_unit_files(output_root, unit)
            raise
        rig_task_id = task_id_from(created)
        rig.update({"task_id": rig_task_id, "create_response": redact(created), "status": "CREATED"})
        unit["phase"] = "rig_created"
        save_state(state_path, state)
        sync_unit_files(output_root, unit)
        balance_after, _ = client.get_balance()
        rig["balance_after_create"] = balance_after
        record_consumed(rig, created)
        append_history(unit, "rig_created", task_id=rig_task_id, balance_after=balance_after)
        save_state(state_path, state)
        sync_unit_files(output_root, unit)

    print(f"[{spec.slug}] rig {rig_task_id}")
    rig_result = poll_task(
        client.get_rig,
        rig_task_id,
        "rig",
        unit,
        state,
        state_path,
        output_root,
        timeout_seconds,
    )
    rig["result"] = redact(rig_result)
    record_consumed(rig, rig_result)
    unit["phase"] = "rig_succeeded"
    append_history(unit, "rig_succeeded", task_id=rig_task_id)
    save_state(state_path, state)
    sync_unit_files(output_root, unit)

    download_results(client, output_root, unit, model_result, rig_result)
    unit["phase"] = "complete"
    append_history(unit, "unit_complete")
    save_state(state_path, state)
    sync_unit_files(output_root, unit)
    print(f"[{spec.slug}] completo en {output_dir_for(output_root, unit)}")


def parse_assignment(values: Sequence[str], flag: str) -> dict[str, str]:
    assignments: dict[str, str] = {}
    valid = {spec.slug for spec in UNIT_SPECS}
    for raw in values:
        slug, separator, task_id = raw.partition("=")
        slug = slug.strip().lower()
        task_id = task_id.strip()
        if not separator or slug not in valid or not task_id:
            raise PipelineError(f"Formato inválido para {flag}: {raw!r}. Usa SLUG=TASK_ID.")
        assignments[slug] = task_id
    return assignments


def apply_adoptions(
    state: MutableMapping[str, Any],
    model_assignments: Mapping[str, str],
    rig_assignments: Mapping[str, str],
    references_dir: Path,
    output_root: Path,
) -> None:
    by_slug = {spec.slug: spec for spec in UNIT_SPECS}
    for kind, assignments in (("model", model_assignments), ("rig", rig_assignments)):
        for slug, task_id in assignments.items():
            spec = by_slug[slug]
            unit = initialize_unit(state, spec, references_dir / spec.reference_file)
            stage = unit.setdefault(kind, {})
            existing = stage.get("task_id")
            if existing and existing != task_id:
                raise PipelineError(f"{slug} ya tiene task id {existing}; no se sustituye por seguridad.")
            stage["task_id"] = task_id
            stage["status"] = "ADOPTED"
            unit["phase"] = f"{kind}_adopted"
            if kind == "model":
                create_output_folder(output_root, unit, task_id)
            append_history(unit, f"{kind}_task_adopted", task_id=task_id)
            sync_unit_files(output_root, unit)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Genera y riggea cinco humanoides de Cuatro Reinos con Meshy. Por defecto: DRY-RUN.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Muestra el plan local; no hace llamadas de red (modo por defecto).")
    mode.add_argument(
        "--confirm-spend",
        action="store_true",
        help="CONFIRMACIÓN EXPLÍCITA: permite crear tareas de pago y reanudar las existentes.",
    )
    mode.add_argument("--balance-only", action="store_true", help="Consulta solo el saldo por GET; nunca crea tareas.")
    parser.add_argument("--offline", action="store_true", help="No realiza ninguna llamada de red; útil para revisar el plan.")
    parser.add_argument("--env-file", type=Path, help="Archivo .env alternativo que contenga MESHY_API_KEY.")
    parser.add_argument("--references", type=Path, default=DEFAULT_REFERENCES, help="Directorio de hojas turnaround.")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT, help="Raíz de artefactos Meshy.")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE, help="Estado JSON reanudable.")
    parser.add_argument(
        "--unit",
        action="append",
        choices=[spec.slug for spec in UNIT_SPECS],
        help="Limita la ejecución a un slug; se puede repetir. Sin esta opción procesa los cinco.",
    )
    parser.add_argument("--poll-timeout", type=float, default=21_600.0, help="Máximo local por tarea; jamás la cancela.")
    parser.add_argument("--connect-timeout", type=float, default=15.0)
    parser.add_argument("--read-timeout", type=float, default=90.0)
    parser.add_argument("--max-retries", type=int, default=7)
    parser.add_argument(
        "--adopt-model-task",
        action="append",
        default=[],
        metavar="SLUG=TASK_ID",
        help="Recupera un POST de modelo ambiguo sin volver a gastar.",
    )
    parser.add_argument(
        "--adopt-rig-task",
        action="append",
        default=[],
        metavar="SLUG=TASK_ID",
        help="Recupera un POST de rig ambiguo sin volver a gastar.",
    )
    return parser


def print_plan(specs: Sequence[UnitSpec], references: Path, live: bool) -> None:
    print("Meshy Five Units Pipeline")
    print(f"Modo: {'GASTO CONFIRMADO' if live else 'DRY-RUN (sin crear tareas)'}")
    print(f"Referencias: {references.resolve()}")
    print("Plan:")
    for spec in specs:
        path = references / spec.reference_file
        dimensions = ""
        if Image is not None and path.is_file():
            with Image.open(path) as source:
                dimensions = f", {choose_view_count(*source.size)} vistas desde {source.width}x{source.height}"
        print(
            f"  - {spec.slug}: meshy-5, {spec.target_polycount:,} tris, {spec.pose_mode}, "
            f"rig {spec.rig_height_m:.2f} m, juego {spec.final_game_height_m:.2f} m{dimensions}"
        )
        print(f"      texture_prompt: {spec.texture_prompt}")
    print(f"Coste esperado: {len(specs) * (MODEL_COST + RIG_COST):g} créditos ({MODEL_COST:g}+{RIG_COST:g} por unidad).")


    print("Fase 2 no incluida: caballo separado; se presupuestara con los creditos obtenidos despues.")

def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    live = bool(args.confirm_spend) and not args.balance_only
    selected = set(args.unit or [spec.slug for spec in UNIT_SPECS])
    specs = [spec for spec in UNIT_SPECS if spec.slug in selected]
    references = args.references.resolve()
    output_root = args.output_root.resolve()
    state_path = args.state.resolve()

    print_plan(specs, references, live)
    if args.poll_timeout <= 0 or args.connect_timeout <= 0 or args.read_timeout <= 0 or args.max_retries < 0:
        raise PipelineError("Timeouts must be positive and --max-retries cannot be negative.")
    if not args.balance_only:
        for spec in specs:
            if not (references / spec.reference_file).is_file():
                raise PipelineError(f"Missing required reference: {references / spec.reference_file}")
    if args.offline and (live or args.balance_only):
        raise PipelineError("--offline cannot be combined with --confirm-spend or --balance-only.")
    if args.offline:
        if live:
            raise PipelineError("--offline y --confirm-spend no se pueden combinar.")
        print("Saldo: no consultado (--offline).")
        return 0

    api_key, key_source = find_api_key(args.env_file)
    if not live and not args.balance_only:
        if api_key:
            print(f"Clave Meshy detectada en {key_source}; no se muestra ni se guarda.")
        else:
            print("Clave Meshy no detectada.")
        print("DRY-RUN local completado. No se hizo ninguna llamada de red ni se creo ninguna tarea.")
        return 0
    if api_key:
        print(f"Clave Meshy detectada en {key_source}; su valor no se mostrará ni guardará.")
    else:
        print("Clave Meshy no detectada.")
        if live or args.balance_only:
            raise PipelineError("Define MESHY_API_KEY en el entorno o en .env antes de continuar.")
        print("DRY-RUN completado sin red. No se creó ninguna tarea.")
        return 0

    client = MeshyClient(
        api_key,
        connect_timeout=args.connect_timeout,
        read_timeout=args.read_timeout,
        max_retries=args.max_retries,
    )
    balance, _ = client.get_balance()
    print(f"Saldo Meshy: {balance:g} créditos.")
    if args.balance_only:
        return 0
    if not live:
        print("DRY-RUN completado. Para gastar, el usuario debe autorizar --confirm-spend explícitamente.")
        return 0

    for spec in specs:
        if not (references / spec.reference_file).is_file():
            raise PipelineError(f"Falta la referencia obligatoria: {references / spec.reference_file}")
    if args.poll_timeout <= 0:
        raise PipelineError("--poll-timeout debe ser positivo.")

    state: MutableMapping[str, Any] = load_json(state_path, new_state())
    if not isinstance(state, MutableMapping) or state.get("schema_version") != 1:
        raise PipelineError(f"Formato de estado no compatible: {state_path}")
    model_adoptions = parse_assignment(args.adopt_model_task, "--adopt-model-task")
    rig_adoptions = parse_assignment(args.adopt_rig_task, "--adopt-rig-task")
    apply_adoptions(state, model_adoptions, rig_adoptions, references, output_root)
    save_state(state_path, state)

    selected_units = state.get("units", {})
    has_any_task = any(
        isinstance(selected_units.get(spec.slug), Mapping)
        and any(
            isinstance(selected_units[spec.slug].get(kind), Mapping)
            and bool(selected_units[spec.slug][kind].get("task_id"))
            for kind in ("model", "rig")
        )
        for spec in specs
    )
    if not has_any_task:
        # This is the all-or-nothing preflight requested by the production plan.
        assert_balance(balance, len(specs) * (MODEL_COST + RIG_COST), "el primer gasto del lote")

    for spec in specs:
        run_unit(client, spec, references, output_root, state, state_path, args.poll_timeout)

    final_balance, _ = client.get_balance()
    state["last_balance"] = {"at": utc_now(), "credits": final_balance}
    save_state(state_path, state)
    print(f"Pipeline completo. Saldo final: {final_balance:g} créditos.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrumpido. Las tareas remotas NO se cancelaron; el estado permite reanudar.", file=sys.stderr)
        raise SystemExit(130)
    except PipelineError as exc:
        print(f"ERROR SEGURO: {exc}", file=sys.stderr)
        raise SystemExit(2)
