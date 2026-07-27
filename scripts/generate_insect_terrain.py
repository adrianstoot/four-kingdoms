"""Generate the forest-floor battlefield without external textures or assets."""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "packages" / "content" / "data" / "map.json"
OUTPUT = ROOT / "apps" / "client" / "src" / "assets" / "insect-terrain-map.png"
SIZE = 2048
HALF_WORLD = 72.0
SEED = 0x1A5EC7


def world_to_pixel(x: float, z: float) -> tuple[float, float]:
    return (
        (x + HALF_WORLD) / (HALF_WORLD * 2.0) * SIZE,
        (z + HALF_WORLD) / (HALF_WORLD * 2.0) * SIZE,
    )


def catmull_rom(points: list[dict[str, float]], samples_per_segment: int = 56) -> list[tuple[float, float]]:
    control = [(float(point["x"]), float(point["z"])) for point in points]
    if len(control) == 2:
        return [
            (
                control[0][0] + (control[1][0] - control[0][0]) * index / samples_per_segment,
                control[0][1] + (control[1][1] - control[0][1]) * index / samples_per_segment,
            )
            for index in range(samples_per_segment + 1)
        ]
    result: list[tuple[float, float]] = []
    extended = [control[0], *control, control[-1]]
    for segment in range(1, len(extended) - 2):
        p0, p1, p2, p3 = extended[segment - 1 : segment + 3]
        for index in range(samples_per_segment):
            t = index / samples_per_segment
            t2 = t * t
            t3 = t2 * t
            x = 0.5 * (
                2 * p1[0]
                + (-p0[0] + p2[0]) * t
                + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
            )
            z = 0.5 * (
                2 * p1[1]
                + (-p0[1] + p2[1]) * t
                + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
            )
            result.append((x, z))
    result.append(control[-1])
    return result


def fractal_noise(seed: int) -> np.ndarray:
    generator = np.random.default_rng(seed)
    noise = np.zeros((SIZE, SIZE), dtype=np.float32)
    total = 0.0
    for resolution, amplitude in [(18, 1.0), (42, 0.55), (96, 0.28), (230, 0.12)]:
        small = generator.random((resolution, resolution), dtype=np.float32)
        image = Image.fromarray(np.uint8(small * 255), mode="L").resize((SIZE, SIZE), Image.Resampling.BICUBIC)
        noise += np.asarray(image, dtype=np.float32) / 255.0 * amplitude
        total += amplitude
    return noise / total


def main() -> None:
    rng = random.Random(SEED)
    map_graph = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    noise = fractal_noise(SEED)
    fine = np.random.default_rng(SEED + 9).normal(0, 0.035, (SIZE, SIZE)).astype(np.float32)
    value = np.clip(noise + fine, 0.0, 1.0)

    low = np.array([34, 59, 31], dtype=np.float32)
    high = np.array([91, 121, 55], dtype=np.float32)
    earth = np.array([73, 58, 39], dtype=np.float32)
    blend = value[..., None]
    pixels = low + (high - low) * blend
    earthy = np.clip((0.5 - value) * 0.55, 0, 0.22)[..., None]
    pixels = pixels * (1.0 - earthy) + earth * earthy
    image = Image.fromarray(np.uint8(np.clip(pixels, 0, 255)), mode="RGB")

    # Broad damp patches create macro-scale variation without repeating textures.
    damp = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    damp_draw = ImageDraw.Draw(damp, "RGBA")
    for _ in range(85):
        x = rng.randrange(-120, SIZE + 120)
        y = rng.randrange(-120, SIZE + 120)
        rx = rng.randrange(45, 190)
        ry = rng.randrange(35, 145)
        color = rng.choice([(20, 63, 39, 28), (110, 92, 45, 17), (18, 45, 27, 24)])
        damp_draw.ellipse((x - rx, y - ry, x + rx, y + ry), fill=color)
    damp = damp.filter(ImageFilter.GaussianBlur(34))
    image = Image.alpha_composite(image.convert("RGBA"), damp)

    roads = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(roads, "RGBA")
    world_px = SIZE / (HALF_WORLD * 2.0)
    all_curves: list[list[tuple[float, float]]] = []
    for lane in map_graph["lanes"]:
        curve_world = catmull_rom(lane["points"])
        curve = [world_to_pixel(x, z) for x, z in curve_world]
        all_curves.append(curve)
        width = max(4, int(float(lane["width"]) * world_px))
        draw.line(curve, fill=(47, 37, 25, 235), width=width + 28, joint="curve")
        draw.line(curve, fill=(116, 79, 43, 255), width=width + 16, joint="curve")
        draw.line(curve, fill=(153, 105, 55, 255), width=width, joint="curve")
        draw.line(curve, fill=(188, 139, 77, 105), width=max(2, width // 3), joint="curve")

    # Four nest clearings and the nectar-heart clearing use the same earth palette.
    for node in map_graph["nodes"]:
        x, y = world_to_pixel(float(node["position"]["x"]), float(node["position"]["z"]))
        radius_world = 7.2 if node["kind"] == "kingdom" else 4.0
        radius = radius_world * world_px
        draw.ellipse((x - radius - 10, y - radius - 10, x + radius + 10, y + radius + 10), fill=(51, 38, 25, 245))
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(132, 87, 45, 255))
        draw.ellipse((x - radius * 0.76, y - radius * 0.76, x + radius * 0.76, y + radius * 0.76), fill=(151, 103, 57, 190))

    # Embedded pebbles, seed fragments and pheromone grains on the paths.
    road_points = [point for curve in all_curves for point in curve]
    for _ in range(2600):
        px, py = rng.choice(road_points)
        angle = rng.random() * math.tau
        radius = rng.random() * 26
        x = px + math.cos(angle) * radius
        y = py + math.sin(angle) * radius
        size = rng.choice([1, 1, 2, 2, 3])
        color = rng.choice([(77, 57, 37, 95), (223, 174, 95, 80), (53, 42, 30, 105)])
        draw.ellipse((x - size, y - size, x + size, y + size), fill=color)

    roads = roads.filter(ImageFilter.GaussianBlur(0.55))
    image = Image.alpha_composite(image, roads)

    # Edge vignette makes the playable diamond read as a tiny illuminated clearing.
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    nx = (xx - SIZE * 0.5) / (SIZE * 0.5)
    ny = (yy - SIZE * 0.5) / (SIZE * 0.5)
    edge = np.clip((np.sqrt(nx * nx + ny * ny) - 0.7) / 0.45, 0, 1)
    rgba = np.asarray(image, dtype=np.float32)
    rgba[..., :3] *= (1.0 - edge[..., None] * 0.36)
    final = Image.fromarray(np.uint8(np.clip(rgba[..., :3], 0, 255)), mode="RGB")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    final.save(OUTPUT, optimize=True, compress_level=7)
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
