"""Build and audit an original, Blender-authored insect unit pack.

This script intentionally has no network or third-party asset dependency.  It
constructs five low-poly insects from Blender primitives, creates a true
armature and rigid skin weights, authors six lowercase actions, exports GLB,
then re-imports every result and audits its deformation.

Run:
  blender --background --python scripts/blender/build_insect_pack.py
"""

from __future__ import annotations

import json
import math
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "apps" / "client" / "public" / "models" / "insects" / "generated-v1"
MANIFEST_PATH = OUTPUT_DIR.parent / "manifest.json"
AUDIT_PATH = ROOT / "output" / "insect-pack-audit.json"
QA_DIR = ROOT / "output" / "insect-pack-qa"

CLIP_ENDS = {
    "idle": 48,
    "walk": 32,
    "attack": 36,
    "hit": 16,
    "death": 48,
    "spawn": 36,
}
EXPECTED_CLIPS = set(CLIP_ENDS)

ARCHETYPE_MAP = {
    "guard": "ant",
    "archer": "bee",
    "knight": "mantis",
    "giant": "beetle",
    "commander": "butterfly",
}


@dataclass(frozen=True)
class SpeciesConfig:
    species: str
    display_name: str
    body_scale: float
    leg_span: float
    palette: tuple[tuple[str, tuple[float, float, float, float], float, float], ...]
    wings: str = "none"
    flying: bool = False
    mandible_scale: float = 1.0
    abdomen_scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    thorax_scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    head_scale: tuple[float, float, float] = (1.0, 1.0, 1.0)


SPECIES: tuple[SpeciesConfig, ...] = (
    SpeciesConfig(
        "ant",
        "Soldier Ant",
        0.92,
        0.76,
        (
            ("chitin", (0.20, 0.035, 0.025, 1.0), 0.28, 0.05),
            ("chitin_light", (0.42, 0.075, 0.035, 1.0), 0.34, 0.02),
            ("team_mark", (0.08, 0.34, 0.72, 1.0), 0.24, 0.12),
            ("eye", (0.008, 0.012, 0.009, 1.0), 0.12, 0.45),
            ("claw", (0.12, 0.025, 0.018, 1.0), 0.25, 0.08),
        ),
        mandible_scale=1.35,
        abdomen_scale=(0.94, 1.22, 0.92),
        thorax_scale=(0.94, 0.96, 0.96),
    ),
    SpeciesConfig(
        "bee",
        "Pollen Vanguard",
        0.88,
        0.70,
        (
            ("chitin", (0.065, 0.045, 0.018, 1.0), 0.38, 0.02),
            ("chitin_light", (0.92, 0.52, 0.035, 1.0), 0.42, 0.0),
            ("team_mark", (0.08, 0.34, 0.72, 1.0), 0.25, 0.08),
            ("eye", (0.012, 0.018, 0.022, 1.0), 0.1, 0.35),
            ("claw", (0.11, 0.07, 0.025, 1.0), 0.34, 0.02),
            ("wing", (0.48, 0.82, 0.94, 0.42), 0.16, 0.0),
            ("pollen", (1.0, 0.68, 0.08, 1.0), 0.48, 0.0),
        ),
        wings="four",
        flying=True,
        mandible_scale=0.62,
        abdomen_scale=(0.78, 1.18, 0.76),
        thorax_scale=(1.02, 0.88, 1.03),
        head_scale=(0.93, 0.84, 0.94),
    ),
    SpeciesConfig(
        "beetle",
        "Rhinoceros Beetle",
        1.12,
        0.82,
        (
            ("chitin", (0.035, 0.055, 0.075, 1.0), 0.16, 0.68),
            ("chitin_light", (0.08, 0.17, 0.19, 1.0), 0.2, 0.58),
            ("team_mark", (0.08, 0.34, 0.72, 1.0), 0.19, 0.55),
            ("eye", (0.006, 0.012, 0.012, 1.0), 0.1, 0.3),
            ("claw", (0.09, 0.11, 0.12, 1.0), 0.2, 0.52),
            ("wing", (0.055, 0.11, 0.13, 1.0), 0.18, 0.62),
        ),
        wings="elytra",
        mandible_scale=0.86,
        abdomen_scale=(1.18, 1.25, 0.92),
        thorax_scale=(1.2, 1.04, 1.04),
        head_scale=(1.04, 0.92, 0.98),
    ),
    SpeciesConfig(
        "mantis",
        "Emerald Mantis",
        1.18,
        1.03,
        (
            ("chitin", (0.17, 0.42, 0.075, 1.0), 0.4, 0.02),
            ("chitin_light", (0.46, 0.72, 0.16, 1.0), 0.45, 0.0),
            ("team_mark", (0.08, 0.34, 0.72, 1.0), 0.3, 0.04),
            ("eye", (0.035, 0.018, 0.045, 1.0), 0.13, 0.28),
            ("claw", (0.08, 0.24, 0.035, 1.0), 0.36, 0.02),
            ("wing", (0.31, 0.61, 0.12, 0.72), 0.42, 0.0),
        ),
        wings="folded",
        mandible_scale=0.78,
        abdomen_scale=(0.58, 1.58, 0.66),
        thorax_scale=(0.62, 1.38, 0.86),
        head_scale=(1.15, 0.72, 0.82),
    ),
    SpeciesConfig(
        "butterfly",
        "Monarch Empress",
        0.98,
        0.68,
        (
            ("chitin", (0.06, 0.045, 0.07, 1.0), 0.38, 0.03),
            ("chitin_light", (0.21, 0.15, 0.25, 1.0), 0.36, 0.02),
            ("team_mark", (0.14, 0.42, 0.92, 1.0), 0.22, 0.1),
            ("eye", (0.018, 0.012, 0.024, 1.0), 0.12, 0.3),
            ("claw", (0.14, 0.08, 0.16, 1.0), 0.32, 0.02),
            ("wing", (0.94, 0.29, 0.055, 0.92), 0.28, 0.0),
            ("wing_dark", (0.055, 0.028, 0.065, 1.0), 0.23, 0.04),
            ("pollen", (1.0, 0.73, 0.12, 1.0), 0.42, 0.0),
        ),
        wings="butterfly",
        flying=True,
        mandible_scale=0.42,
        abdomen_scale=(0.48, 1.18, 0.54),
        thorax_scale=(0.72, 0.82, 0.84),
        head_scale=(0.86, 0.74, 0.88),
    ),
)


@dataclass
class RigBuild:
    config: SpeciesConfig
    armature: bpy.types.Object
    mesh: bpy.types.Object
    actions: dict[str, bpy.types.Action]
    expected_bones: set[str]
    materials: dict[str, bpy.types.Material]
    wing_bones: tuple[str, ...] = field(default_factory=tuple)


def clear_scene() -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.meshes,
        bpy.data.armatures,
        bpy.data.actions,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(collection):
            collection.remove(datablock)
    for world in list(bpy.data.worlds):
        bpy.data.worlds.remove(world)


def active_only(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float,
    metallic: float,
) -> bpy.types.Material:
    value = bpy.data.materials.new(name)
    value.use_nodes = True
    value.diffuse_color = color
    value.metallic = metallic
    value.roughness = roughness
    value.use_backface_culling = False
    bsdf = (
        next((node for node in value.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
        if value.node_tree
        else None
    )
    if bsdf:
        if "Base Color" in bsdf.inputs:
            bsdf.inputs["Base Color"].default_value = color
        if "Alpha" in bsdf.inputs:
            bsdf.inputs["Alpha"].default_value = color[3]
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if "Coat Weight" in bsdf.inputs:
            bsdf.inputs["Coat Weight"].default_value = 0.34 if metallic > 0.2 else 0.12
        if "Coat Roughness" in bsdf.inputs:
            bsdf.inputs["Coat Roughness"].default_value = max(0.05, roughness * 0.55)
        if "IOR" in bsdf.inputs:
            bsdf.inputs["IOR"].default_value = 1.46
    if color[3] < 0.999:
        if hasattr(value, "surface_render_method"):
            value.surface_render_method = "DITHERED"
        value.diffuse_color = color
    return value


def assign_material(obj: bpy.types.Object, value: bpy.types.Material) -> None:
    obj.data.materials.append(value)


def shade_smooth(obj: bpy.types.Object, angle: float = math.radians(42)) -> None:
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    if hasattr(obj.data, "set_sharp_from_angle"):
        try:
            obj.data.set_sharp_from_angle(angle=angle)
        except Exception:
            pass


def apply_transform(obj: bpy.types.Object) -> None:
    active_only(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def bevel(obj: bpy.types.Object, width: float, segments: int = 1) -> None:
    if width <= 0:
        return
    active_only(obj)
    modifier = obj.modifiers.new("MicroBevel", "BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def rigid_weight(obj: bpy.types.Object, bone_name: str) -> None:
    group = obj.vertex_groups.get(bone_name) or obj.vertex_groups.new(name=bone_name)
    group.add(range(len(obj.data.vertices)), 1.0, "REPLACE")


def finalize_part(
    obj: bpy.types.Object,
    name: str,
    bone: str,
    value: bpy.types.Material,
    *,
    bevel_width: float = 0.0,
    smooth: bool = True,
) -> bpy.types.Object:
    obj.name = name
    apply_transform(obj)
    if bevel_width > 0:
        bevel(obj, bevel_width)
    if smooth:
        shade_smooth(obj)
    assign_material(obj, value)
    rigid_weight(obj, bone)
    return obj


def add_uv_ellipsoid(
    parts: list[bpy.types.Object],
    name: str,
    bone: str,
    value: bpy.types.Material,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    *,
    segments: int = 12,
    rings: int = 8,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.scale = scale
    parts.append(finalize_part(obj, name, bone, value))
    return obj


def add_ico(
    parts: list[bpy.types.Object],
    name: str,
    bone: str,
    value: bpy.types.Material,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    *,
    subdivisions: int = 2,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location)
    obj = bpy.context.object
    obj.scale = scale
    parts.append(finalize_part(obj, name, bone, value))
    return obj


def add_segment(
    parts: list[bpy.types.Object],
    name: str,
    bone: str,
    value: bpy.types.Material,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    *,
    vertices: int = 7,
    taper: float = 0.82,
) -> bpy.types.Object:
    start_v = Vector(start)
    end_v = Vector(end)
    direction = end_v - start_v
    length = max(0.002, direction.length)
    midpoint = (start_v + end_v) * 0.5
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius,
        radius2=radius * taper,
        depth=length,
        location=midpoint,
    )
    obj = bpy.context.object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    parts.append(finalize_part(obj, name, bone, value, bevel_width=radius * 0.08))
    return obj


def add_cone_between(
    parts: list[bpy.types.Object],
    name: str,
    bone: str,
    value: bpy.types.Material,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    *,
    vertices: int = 7,
) -> bpy.types.Object:
    start_v = Vector(start)
    end_v = Vector(end)
    direction = end_v - start_v
    length = max(0.002, direction.length)
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius,
        radius2=0.015,
        depth=length,
        location=(start_v + end_v) * 0.5,
    )
    obj = bpy.context.object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    parts.append(finalize_part(obj, name, bone, value))
    return obj


def add_torus(
    parts: list[bpy.types.Object],
    name: str,
    bone: str,
    value: bpy.types.Material,
    location: tuple[float, float, float],
    major_radius: float,
    minor_radius: float,
    rotation: tuple[float, float, float],
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=12,
        minor_segments=4,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.scale = scale
    parts.append(finalize_part(obj, name, bone, value))
    return obj


def add_wing(
    parts: list[bpy.types.Object],
    name: str,
    bone: str,
    value: bpy.types.Material,
    root: tuple[float, float, float],
    points: Iterable[tuple[float, float, float]],
) -> bpy.types.Object:
    vertices = [root, *points]
    faces = [tuple(range(len(vertices)))]
    mesh_data = bpy.data.meshes.new(f"{name}Geometry")
    mesh_data.from_pydata(vertices, [], faces)
    mesh_data.update()
    obj = bpy.data.objects.new(name, mesh_data)
    bpy.context.scene.collection.objects.link(obj)
    parts.append(finalize_part(obj, name, bone, value, smooth=False))
    return obj


def create_armature(name: str) -> bpy.types.Object:
    data = bpy.data.armatures.new(f"{name}Skeleton")
    armature = bpy.data.objects.new(f"{name}Rig", data)
    bpy.context.scene.collection.objects.link(armature)
    armature.show_in_front = True
    armature.display_type = "SOLID"
    active_only(armature)
    bpy.ops.object.mode_set(mode="EDIT")
    return armature


def add_bone(
    armature: bpy.types.Object,
    name: str,
    head: tuple[float, float, float],
    tail: tuple[float, float, float],
    parent: str | None = None,
    *,
    deform: bool = True,
) -> None:
    bone = armature.data.edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    bone.use_deform = deform
    if parent:
        bone.parent = armature.data.edit_bones[parent]
        bone.use_connect = False


def finish_armature(armature: bpy.types.Object) -> None:
    bpy.ops.object.mode_set(mode="OBJECT")
    active_only(armature)
    for bone in armature.pose.bones:
        bone.rotation_mode = "XYZ"


def body_layout(config: SpeciesConfig) -> dict[str, tuple[float, float, float]]:
    scale = config.body_scale
    if config.species == "mantis":
        return {
            "thorax": (0.0, -0.05 * scale, 0.70 * scale),
            "head": (0.0, -0.88 * scale, 0.90 * scale),
            "abdomen": (0.0, 0.84 * scale, 0.68 * scale),
        }
    return {
        "thorax": (0.0, 0.0, 0.58 * scale),
        "head": (0.0, -0.66 * scale, 0.61 * scale),
        "abdomen": (0.0, 0.72 * scale, 0.61 * scale),
    }


def leg_points(
    config: SpeciesConfig,
    pair: str,
    side: str,
    body: dict[str, tuple[float, float, float]],
) -> tuple[Vector, Vector, Vector, Vector, Vector]:
    sign = 1.0 if side == "L" else -1.0
    scale = config.body_scale
    y_by_pair = {"Front": -0.30, "Mid": 0.0, "Rear": 0.30}
    y = y_by_pair[pair] * scale
    root = Vector((sign * 0.24 * scale, y, body["thorax"][2] - 0.03 * scale))
    if config.species == "mantis" and pair == "Front":
        coxa = Vector((sign * 0.33 * scale, -0.47 * scale, 0.86 * scale))
        femur = Vector((sign * 0.53 * scale, -0.92 * scale, 0.90 * scale))
        tibia = Vector((sign * 0.62 * scale, -1.45 * scale, 0.47 * scale))
        tarsus = Vector((sign * 0.58 * scale, -1.68 * scale, 0.08 * scale))
        return root, coxa, femur, tibia, tarsus

    pair_bias = {"Front": -0.20, "Mid": 0.0, "Rear": 0.20}[pair] * scale
    span = config.leg_span * scale
    coxa = Vector((sign * 0.40 * scale, y + pair_bias * 0.18, body["thorax"][2] - 0.02 * scale))
    femur = Vector((sign * span * 0.77, y + pair_bias * 0.62, 0.40 * scale))
    tibia = Vector((sign * span, y + pair_bias * 1.25, 0.105 * scale))
    tarsus = Vector((sign * (span + 0.12 * scale), y + pair_bias * 1.50 - 0.09 * scale, 0.035 * scale))
    return root, coxa, femur, tibia, tarsus


def build_skeleton(
    config: SpeciesConfig,
    body: dict[str, tuple[float, float, float]],
) -> tuple[bpy.types.Object, set[str], dict[tuple[str, str], tuple[Vector, Vector, Vector, Vector, Vector]], tuple[str, ...]]:
    armature = create_armature(config.display_name.replace(" ", ""))
    scale = config.body_scale
    thorax = body["thorax"]
    head = body["head"]
    abdomen = body["abdomen"]
    add_bone(armature, "Root", (0, 0, 0.04), (0, 0.22, 0.04), deform=False)
    add_bone(armature, "Thorax", thorax, (thorax[0], thorax[1] - 0.34 * scale, thorax[2]), "Root")
    add_bone(armature, "Head", (0, -0.34 * scale, head[2]), (0, head[1] - 0.16 * scale, head[2]), "Thorax")
    add_bone(armature, "Abdomen", (0, 0.24 * scale, abdomen[2]), (0, abdomen[1] + 0.30 * scale, abdomen[2]), "Thorax")

    for side, sign in (("L", 1.0), ("R", -1.0)):
        add_bone(
            armature,
            f"Mandible_{side}",
            (sign * 0.12 * scale, head[1] - 0.20 * scale, head[2] - 0.02 * scale),
            (sign * 0.30 * scale, head[1] - 0.51 * scale, head[2] - 0.04 * scale),
            "Head",
        )
        antenna_root = Vector((sign * 0.13 * scale, head[1] - 0.12 * scale, head[2] + 0.16 * scale))
        antenna_mid = Vector((sign * 0.27 * scale, head[1] - 0.48 * scale, head[2] + 0.31 * scale))
        antenna_tip = Vector((sign * 0.42 * scale, head[1] - 0.77 * scale, head[2] + 0.23 * scale))
        add_bone(armature, f"Antenna_{side}_1", antenna_root, antenna_mid, "Head")
        add_bone(armature, f"Antenna_{side}_2", antenna_mid, antenna_tip, f"Antenna_{side}_1")

    all_leg_points: dict[tuple[str, str], tuple[Vector, Vector, Vector, Vector, Vector]] = {}
    for pair in ("Front", "Mid", "Rear"):
        for side in ("L", "R"):
            points = leg_points(config, pair, side, body)
            all_leg_points[(pair, side)] = points
            labels = ("Coxa", "Femur", "Tibia", "Tarsus")
            parent = "Thorax"
            for index, label in enumerate(labels):
                bone_name = f"Leg_{pair}_{side}_{label}"
                add_bone(armature, bone_name, points[index], points[index + 1], parent)
                parent = bone_name

    wing_bones: list[str] = []
    if config.wings in {"four", "butterfly"}:
        for label, y_offset in (("Fore", -0.12), ("Hind", 0.18)):
            for side, sign in (("L", 1.0), ("R", -1.0)):
                name = f"Wing_{label}_{side}"
                root = (sign * 0.13 * scale, y_offset * scale, thorax[2] + 0.16 * scale)
                tail = (sign * (0.82 if label == "Fore" else 0.67) * scale, (y_offset - 0.04) * scale, thorax[2] + 0.20 * scale)
                add_bone(armature, name, root, tail, "Thorax")
                wing_bones.append(name)
    elif config.wings in {"elytra", "folded"}:
        for side, sign in (("L", 1.0), ("R", -1.0)):
            name = f"Wing_Case_{side}"
            root = (sign * 0.12 * scale, 0.20 * scale, thorax[2] + 0.15 * scale)
            tail = (sign * 0.28 * scale, 0.94 * scale, thorax[2] + 0.18 * scale)
            add_bone(armature, name, root, tail, "Thorax")
            wing_bones.append(name)

    if config.species == "bee":
        add_bone(
            armature,
            "Stinger",
            (0, abdomen[1] + 0.38 * scale, abdomen[2]),
            (0, abdomen[1] + 0.77 * scale, abdomen[2] - 0.08 * scale),
            "Abdomen",
        )
    if config.species == "beetle":
        add_bone(
            armature,
            "Horn",
            (0, head[1] - 0.12 * scale, head[2] + 0.08 * scale),
            (0, head[1] - 0.98 * scale, head[2] + 0.34 * scale),
            "Head",
        )

    finish_armature(armature)
    expected = {bone.name for bone in armature.data.bones}
    return armature, expected, all_leg_points, tuple(wing_bones)


def build_body(
    config: SpeciesConfig,
    materials: dict[str, bpy.types.Material],
    body: dict[str, tuple[float, float, float]],
    parts: list[bpy.types.Object],
) -> None:
    scale = config.body_scale
    thorax = body["thorax"]
    head = body["head"]
    abdomen = body["abdomen"]
    add_uv_ellipsoid(
        parts,
        f"{config.species}_thorax",
        "Thorax",
        materials["chitin_light"],
        thorax,
        tuple(component * scale for component in (0.42 * config.thorax_scale[0], 0.48 * config.thorax_scale[1], 0.38 * config.thorax_scale[2])),
    )
    add_uv_ellipsoid(
        parts,
        f"{config.species}_abdomen",
        "Abdomen",
        materials["chitin"],
        abdomen,
        tuple(component * scale for component in (0.48 * config.abdomen_scale[0], 0.58 * config.abdomen_scale[1], 0.42 * config.abdomen_scale[2])),
    )
    add_uv_ellipsoid(
        parts,
        f"{config.species}_head",
        "Head",
        materials["chitin_light"],
        head,
        tuple(component * scale for component in (0.36 * config.head_scale[0], 0.34 * config.head_scale[1], 0.33 * config.head_scale[2])),
    )

    mark_location = (0.0, thorax[1] + 0.02 * scale, thorax[2] + 0.34 * scale)
    add_uv_ellipsoid(
        parts,
        f"{config.species}_team_mark",
        "Thorax",
        materials["team_mark"],
        mark_location,
        (0.20 * scale, 0.25 * scale, 0.055 * scale),
        segments=10,
        rings=6,
    )

    for side, sign in (("L", 1.0), ("R", -1.0)):
        eye_location = (
            sign * 0.25 * scale * config.head_scale[0],
            head[1] - 0.23 * scale * config.head_scale[1],
            head[2] + 0.09 * scale,
        )
        add_uv_ellipsoid(
            parts,
            f"{config.species}_compound_eye_{side}",
            "Head",
            materials["eye"],
            eye_location,
            (0.12 * scale, 0.095 * scale, 0.15 * scale),
            segments=10,
            rings=6,
        )

        mandible_root = (
            sign * 0.12 * scale,
            head[1] - 0.20 * scale,
            head[2] - 0.02 * scale,
        )
        mandible_tip = (
            sign * 0.30 * scale * config.mandible_scale,
            head[1] - 0.51 * scale * config.mandible_scale,
            head[2] - 0.055 * scale,
        )
        add_cone_between(
            parts,
            f"{config.species}_mandible_{side}",
            f"Mandible_{side}",
            materials["claw"],
            mandible_root,
            mandible_tip,
            0.095 * scale,
        )

        antenna_root = (sign * 0.13 * scale, head[1] - 0.12 * scale, head[2] + 0.16 * scale)
        antenna_mid = (sign * 0.27 * scale, head[1] - 0.48 * scale, head[2] + 0.31 * scale)
        antenna_tip = (sign * 0.42 * scale, head[1] - 0.77 * scale, head[2] + 0.23 * scale)
        add_segment(
            parts,
            f"{config.species}_antenna_{side}_1",
            f"Antenna_{side}_1",
            materials["claw"],
            antenna_root,
            antenna_mid,
            0.026 * scale,
            vertices=6,
            taper=0.72,
        )
        add_segment(
            parts,
            f"{config.species}_antenna_{side}_2",
            f"Antenna_{side}_2",
            materials["claw"],
            antenna_mid,
            antenna_tip,
            0.020 * scale,
            vertices=6,
            taper=0.48,
        )

    if config.species == "bee":
        for index, y_offset in enumerate((-0.20, 0.02, 0.24)):
            add_torus(
                parts,
                f"bee_gold_band_{index}",
                "Abdomen",
                materials["chitin_light"],
                (0, abdomen[1] + y_offset * scale, abdomen[2]),
                0.30 * scale,
                0.052 * scale,
                (math.pi * 0.5, 0, 0),
                (1.0, 0.82, 1.0),
            )
        add_cone_between(
            parts,
            "bee_stinger",
            "Stinger",
            materials["claw"],
            (0, abdomen[1] + 0.40 * scale, abdomen[2]),
            (0, abdomen[1] + 0.78 * scale, abdomen[2] - 0.08 * scale),
            0.075 * scale,
        )
        for side, sign in (("L", 1.0), ("R", -1.0)):
            add_ico(
                parts,
                f"bee_pollen_{side}",
                f"Leg_Rear_{side}_Tibia",
                materials["pollen"],
                (sign * 0.53 * scale, 0.38 * scale, 0.20 * scale),
                (0.13 * scale, 0.17 * scale, 0.13 * scale),
                subdivisions=1,
            )

    if config.species == "beetle":
        # A three-stage upswept ram with a forked striking crown gives the
        # siege unit a readable silhouette even at RTS camera distance.
        horn_base = (0, head[1] - 0.08 * scale, head[2] + 0.04 * scale)
        horn_knee = (0, head[1] - 0.39 * scale, head[2] + 0.25 * scale)
        horn_crown = (0, head[1] - 0.74 * scale, head[2] + 0.44 * scale)
        add_segment(
            parts,
            "beetle_ram_base",
            "Horn",
            materials["claw"],
            horn_base,
            horn_knee,
            0.18 * scale,
            vertices=9,
            taper=0.66,
        )
        add_segment(
            parts,
            "beetle_ram_neck",
            "Horn",
            materials["claw"],
            horn_knee,
            horn_crown,
            0.12 * scale,
            vertices=8,
            taper=0.54,
        )
        for side, sign in (("L", 1.0), ("R", -1.0)):
            shoulder = (
                sign * 0.17 * scale,
                head[1] - 0.78 * scale,
                head[2] + 0.42 * scale,
            )
            add_segment(
                parts,
                f"beetle_ram_crossbar_{side}",
                "Horn",
                materials["claw"],
                horn_crown,
                shoulder,
                0.072 * scale,
                vertices=7,
                taper=0.72,
            )
            add_cone_between(
                parts,
                f"beetle_ram_tine_{side}",
                "Horn",
                materials["team_mark"],
                shoulder,
                (
                    sign * 0.20 * scale,
                    head[1] - 1.02 * scale,
                    head[2] + 0.32 * scale,
                ),
                0.075 * scale,
                vertices=7,
            )
        add_cone_between(
            parts,
            "beetle_ram_tine_center",
            "Horn",
            materials["team_mark"],
            horn_crown,
            (0, head[1] - 1.08 * scale, head[2] + 0.36 * scale),
            0.09 * scale,
            vertices=8,
        )
        add_uv_ellipsoid(
            parts,
            "beetle_pronotum",
            "Thorax",
            materials["chitin"],
            (0, thorax[1] - 0.18 * scale, thorax[2] + 0.07 * scale),
            (0.52 * scale, 0.39 * scale, 0.30 * scale),
            segments=12,
            rings=7,
        )

    if config.species == "mantis":
        # Neck collar and serrated foreleg spines make the predator silhouette readable.
        add_segment(
            parts,
            "mantis_neck",
            "Head",
            materials["chitin_light"],
            (0, thorax[1] - 0.18 * scale, thorax[2] + 0.10 * scale),
            (0, head[1] + 0.20 * scale, head[2] - 0.05 * scale),
            0.13 * scale,
            vertices=7,
            taper=0.66,
        )
        for side, sign in (("L", 1.0), ("R", -1.0)):
            for index in range(5):
                y = -1.02 * scale - index * 0.10 * scale
                add_cone_between(
                    parts,
                    f"mantis_spine_{side}_{index}",
                    f"Leg_Front_{side}_Tibia",
                    materials["claw"],
                    (sign * (0.57 + index * 0.012) * scale, y, (0.60 - index * 0.08) * scale),
                    (sign * (0.46 + index * 0.012) * scale, y - 0.02 * scale, (0.57 - index * 0.08) * scale),
                    0.034 * scale,
                    vertices=5,
                )

    if config.species == "butterfly":
        add_segment(
            parts,
            "butterfly_proboscis",
            "Head",
            materials["claw"],
            (0, head[1] - 0.22 * scale, head[2] - 0.04 * scale),
            (0.03 * scale, head[1] - 0.66 * scale, head[2] - 0.14 * scale),
            0.025 * scale,
            vertices=6,
            taper=0.40,
        )


def build_legs(
    config: SpeciesConfig,
    materials: dict[str, bpy.types.Material],
    points_by_leg: dict[tuple[str, str], tuple[Vector, Vector, Vector, Vector, Vector]],
    parts: list[bpy.types.Object],
) -> None:
    scale = config.body_scale
    for (pair, side), points in points_by_leg.items():
        labels = ("Coxa", "Femur", "Tibia", "Tarsus")
        radii = (0.075, 0.066, 0.047, 0.028)
        for index, label in enumerate(labels):
            bone = f"Leg_{pair}_{side}_{label}"
            material_name = "claw" if label in {"Tibia", "Tarsus"} else "chitin"
            add_segment(
                parts,
                f"{config.species}_{bone.lower()}",
                bone,
                materials[material_name],
                tuple(points[index]),
                tuple(points[index + 1]),
                radii[index] * scale,
                vertices=6 if label != "Coxa" else 7,
                taper=0.78 if label != "Tarsus" else 0.42,
            )
        foot = points[-1]
        add_uv_ellipsoid(
            parts,
            f"{config.species}_foot_{pair}_{side}",
            f"Leg_{pair}_{side}_Tarsus",
            materials["claw"],
            tuple(foot),
            (0.058 * scale, 0.105 * scale, 0.025 * scale),
            segments=8,
            rings=5,
        )


def build_wings(
    config: SpeciesConfig,
    materials: dict[str, bpy.types.Material],
    body: dict[str, tuple[float, float, float]],
    parts: list[bpy.types.Object],
) -> None:
    if config.wings == "none":
        return
    scale = config.body_scale
    thorax = body["thorax"]
    abdomen = body["abdomen"]
    for side, sign in (("L", 1.0), ("R", -1.0)):
        if config.wings == "four":
            fore_root = (sign * 0.13 * scale, -0.12 * scale, thorax[2] + 0.16 * scale)
            add_wing(
                parts,
                f"bee_forewing_{side}",
                f"Wing_Fore_{side}",
                materials["wing"],
                fore_root,
                (
                    (sign * 0.94 * scale, -0.48 * scale, thorax[2] + 0.24 * scale),
                    (sign * 1.18 * scale, 0.02 * scale, thorax[2] + 0.22 * scale),
                    (sign * 0.44 * scale, 0.28 * scale, thorax[2] + 0.18 * scale),
                ),
            )
            hind_root = (sign * 0.13 * scale, 0.18 * scale, thorax[2] + 0.14 * scale)
            add_wing(
                parts,
                f"bee_hindwing_{side}",
                f"Wing_Hind_{side}",
                materials["wing"],
                hind_root,
                (
                    (sign * 0.72 * scale, 0.18 * scale, thorax[2] + 0.20 * scale),
                    (sign * 0.78 * scale, 0.58 * scale, thorax[2] + 0.16 * scale),
                    (sign * 0.31 * scale, 0.66 * scale, thorax[2] + 0.14 * scale),
                ),
            )
        elif config.wings == "butterfly":
            fore_root = (sign * 0.13 * scale, -0.12 * scale, thorax[2] + 0.16 * scale)
            fore_outline = (
                (sign * 0.42 * scale, -0.50 * scale, thorax[2] + 0.20 * scale),
                (sign * 0.88 * scale, -0.79 * scale, thorax[2] + 0.24 * scale),
                (sign * 1.30 * scale, -0.75 * scale, thorax[2] + 0.27 * scale),
                (sign * 1.58 * scale, -0.51 * scale, thorax[2] + 0.28 * scale),
                (sign * 1.72 * scale, -0.16 * scale, thorax[2] + 0.27 * scale),
                (sign * 1.66 * scale, 0.17 * scale, thorax[2] + 0.24 * scale),
                (sign * 1.43 * scale, 0.40 * scale, thorax[2] + 0.21 * scale),
                (sign * 1.10 * scale, 0.49 * scale, thorax[2] + 0.19 * scale),
                (sign * 0.76 * scale, 0.43 * scale, thorax[2] + 0.18 * scale),
                (sign * 0.46 * scale, 0.27 * scale, thorax[2] + 0.17 * scale),
                (sign * 0.25 * scale, 0.06 * scale, thorax[2] + 0.16 * scale),
            )
            add_wing(
                parts,
                f"butterfly_forewing_border_{side}",
                f"Wing_Fore_{side}",
                materials["wing_dark"],
                fore_root,
                fore_outline,
            )
            add_wing(
                parts,
                f"butterfly_forewing_color_{side}",
                f"Wing_Fore_{side}",
                materials["wing"],
                (sign * 0.19 * scale, -0.10 * scale, thorax[2] + 0.182 * scale),
                (
                    (sign * 0.47 * scale, -0.43 * scale, thorax[2] + 0.222 * scale),
                    (sign * 0.89 * scale, -0.68 * scale, thorax[2] + 0.262 * scale),
                    (sign * 1.25 * scale, -0.65 * scale, thorax[2] + 0.286 * scale),
                    (sign * 1.48 * scale, -0.44 * scale, thorax[2] + 0.294 * scale),
                    (sign * 1.59 * scale, -0.15 * scale, thorax[2] + 0.286 * scale),
                    (sign * 1.53 * scale, 0.10 * scale, thorax[2] + 0.258 * scale),
                    (sign * 1.34 * scale, 0.29 * scale, thorax[2] + 0.232 * scale),
                    (sign * 1.07 * scale, 0.36 * scale, thorax[2] + 0.212 * scale),
                    (sign * 0.78 * scale, 0.32 * scale, thorax[2] + 0.202 * scale),
                    (sign * 0.50 * scale, 0.19 * scale, thorax[2] + 0.192 * scale),
                    (sign * 0.29 * scale, 0.02 * scale, thorax[2] + 0.184 * scale),
                ),
            )
            hind_root = (sign * 0.13 * scale, 0.18 * scale, thorax[2] + 0.14 * scale)
            add_wing(
                parts,
                f"butterfly_hindwing_border_{side}",
                f"Wing_Hind_{side}",
                materials["wing_dark"],
                hind_root,
                (
                    (sign * 0.39 * scale, 0.25 * scale, thorax[2] + 0.18 * scale),
                    (sign * 0.75 * scale, 0.38 * scale, thorax[2] + 0.20 * scale),
                    (sign * 1.07 * scale, 0.61 * scale, thorax[2] + 0.19 * scale),
                    (sign * 1.26 * scale, 0.91 * scale, thorax[2] + 0.17 * scale),
                    (sign * 1.27 * scale, 1.18 * scale, thorax[2] + 0.14 * scale),
                    (sign * 1.09 * scale, 1.42 * scale, thorax[2] + 0.11 * scale),
                    (sign * 0.80 * scale, 1.53 * scale, thorax[2] + 0.09 * scale),
                    (sign * 0.52 * scale, 1.43 * scale, thorax[2] + 0.09 * scale),
                    (sign * 0.32 * scale, 1.18 * scale, thorax[2] + 0.10 * scale),
                    (sign * 0.22 * scale, 0.82 * scale, thorax[2] + 0.12 * scale),
                    (sign * 0.19 * scale, 0.45 * scale, thorax[2] + 0.14 * scale),
                ),
            )
            add_wing(
                parts,
                f"butterfly_hindwing_color_{side}",
                f"Wing_Hind_{side}",
                materials["wing"],
                (sign * 0.19 * scale, 0.23 * scale, thorax[2] + 0.166 * scale),
                (
                    (sign * 0.42 * scale, 0.30 * scale, thorax[2] + 0.204 * scale),
                    (sign * 0.73 * scale, 0.43 * scale, thorax[2] + 0.222 * scale),
                    (sign * 0.98 * scale, 0.63 * scale, thorax[2] + 0.210 * scale),
                    (sign * 1.12 * scale, 0.89 * scale, thorax[2] + 0.190 * scale),
                    (sign * 1.13 * scale, 1.11 * scale, thorax[2] + 0.160 * scale),
                    (sign * 0.98 * scale, 1.28 * scale, thorax[2] + 0.132 * scale),
                    (sign * 0.77 * scale, 1.36 * scale, thorax[2] + 0.116 * scale),
                    (sign * 0.57 * scale, 1.28 * scale, thorax[2] + 0.116 * scale),
                    (sign * 0.41 * scale, 1.08 * scale, thorax[2] + 0.126 * scale),
                    (sign * 0.31 * scale, 0.78 * scale, thorax[2] + 0.146 * scale),
                    (sign * 0.27 * scale, 0.47 * scale, thorax[2] + 0.164 * scale),
                ),
            )

            # Raised dark veins follow each lobe and remain rigidly bound to
            # the corresponding wing bone.
            vein_specs = (
                (
                    "Fore",
                    (sign * 0.22 * scale, -0.07 * scale, thorax[2] + 0.305 * scale),
                    (
                        (sign * 1.43 * scale, -0.40 * scale, thorax[2] + 0.31 * scale),
                        (sign * 1.48 * scale, -0.08 * scale, thorax[2] + 0.305 * scale),
                        (sign * 1.25 * scale, 0.25 * scale, thorax[2] + 0.29 * scale),
                        (sign * 0.82 * scale, 0.27 * scale, thorax[2] + 0.275 * scale),
                    ),
                ),
                (
                    "Hind",
                    (sign * 0.23 * scale, 0.28 * scale, thorax[2] + 0.225 * scale),
                    (
                        (sign * 1.02 * scale, 0.72 * scale, thorax[2] + 0.225 * scale),
                        (sign * 1.02 * scale, 1.10 * scale, thorax[2] + 0.19 * scale),
                        (sign * 0.74 * scale, 1.27 * scale, thorax[2] + 0.165 * scale),
                        (sign * 0.44 * scale, 1.02 * scale, thorax[2] + 0.175 * scale),
                    ),
                ),
            )
            for wing_label, vein_root, vein_tips in vein_specs:
                for index, tip in enumerate(vein_tips):
                    add_segment(
                        parts,
                        f"butterfly_vein_{wing_label.lower()}_{side}_{index}",
                        f"Wing_{wing_label}_{side}",
                        materials["wing_dark"],
                        vein_root,
                        tip,
                        0.012 * scale,
                        vertices=5,
                        taper=0.62,
                    )

            # Three-layer ocelli create a richer heraldic monarch pattern.
            ocelli = (
                ("Fore", 1.15, -0.25, 0.19, 0.31),
                ("Fore", 0.76, 0.11, 0.12, 0.29),
                ("Hind", 0.79, 0.91, 0.16, 0.205),
            )
            for index, (wing_label, x, y, size, z) in enumerate(ocelli):
                bone = f"Wing_{wing_label}_{side}"
                center = (sign * x * scale, y * scale, thorax[2] + z * scale)
                add_uv_ellipsoid(
                    parts,
                    f"butterfly_dark_ocellus_{side}_{index}",
                    bone,
                    materials["wing_dark"],
                    center,
                    (size * scale, 0.018 * scale, size * scale),
                    segments=10,
                    rings=5,
                    rotation=(math.pi * 0.5, 0, 0),
                )
                add_uv_ellipsoid(
                    parts,
                    f"butterfly_team_ocellus_{side}_{index}",
                    bone,
                    materials["team_mark"],
                    (center[0], center[1], center[2] + 0.014 * scale),
                    (size * 0.69 * scale, 0.020 * scale, size * 0.69 * scale),
                    segments=9,
                    rings=5,
                    rotation=(math.pi * 0.5, 0, 0),
                )
                add_uv_ellipsoid(
                    parts,
                    f"butterfly_gold_ocellus_{side}_{index}",
                    bone,
                    materials["pollen"],
                    (center[0], center[1], center[2] + 0.026 * scale),
                    (size * 0.31 * scale, 0.022 * scale, size * 0.31 * scale),
                    segments=9,
                    rings=5,
                    rotation=(math.pi * 0.5, 0, 0),
                )
        elif config.wings == "elytra":
            add_uv_ellipsoid(
                parts,
                f"beetle_elytron_{side}",
                f"Wing_Case_{side}",
                materials["wing"],
                (sign * 0.23 * scale, abdomen[1], abdomen[2] + 0.25 * scale),
                (0.29 * scale, 0.69 * scale, 0.16 * scale),
                segments=12,
                rings=7,
            )
            add_segment(
                parts,
                f"beetle_elytron_ridge_{side}",
                f"Wing_Case_{side}",
                materials["team_mark"],
                (sign * 0.23 * scale, abdomen[1] - 0.45 * scale, abdomen[2] + 0.38 * scale),
                (sign * 0.23 * scale, abdomen[1] + 0.47 * scale, abdomen[2] + 0.31 * scale),
                0.025 * scale,
                vertices=6,
                taper=0.75,
            )
        elif config.wings == "folded":
            root = (sign * 0.12 * scale, 0.20 * scale, thorax[2] + 0.15 * scale)
            add_wing(
                parts,
                f"mantis_folded_wing_{side}",
                f"Wing_Case_{side}",
                materials["wing"],
                root,
                (
                    (sign * 0.32 * scale, 0.42 * scale, abdomen[2] + 0.24 * scale),
                    (sign * 0.24 * scale, 1.32 * scale, abdomen[2] + 0.16 * scale),
                    (sign * 0.05 * scale, 1.52 * scale, abdomen[2] + 0.10 * scale),
                ),
            )


def join_parts(parts: list[bpy.types.Object], armature: bpy.types.Object, species: str) -> bpy.types.Object:
    if not parts:
        raise RuntimeError(f"{species}: no mesh parts were created")
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    mesh = bpy.context.object
    mesh.name = f"{species.title()}Unit"
    mesh.data.name = f"{species.title()}UnitGeometry"
    modifier = mesh.modifiers.new("InsectArmature", "ARMATURE")
    modifier.object = armature
    mesh.parent = armature
    mesh.matrix_parent_inverse = armature.matrix_world.inverted()
    mesh["species"] = species
    mesh["original_procedural_asset"] = True
    return mesh


RotationMap = dict[str, tuple[float, float, float]]
LocationMap = dict[str, tuple[float, float, float]]
ScaleMap = dict[str, tuple[float, float, float]]
PoseFrame = tuple[int, RotationMap, LocationMap, ScaleMap]


def add_tuple(
    left: tuple[float, float, float],
    right: tuple[float, float, float],
) -> tuple[float, float, float]:
    return tuple(left[index] + right[index] for index in range(3))  # type: ignore[return-value]


def action_channel_bags(action: bpy.types.Action):
    for layer in action.layers:
        for strip in layer.strips:
            for slot in action.slots:
                bag = strip.channelbag(slot)
                if bag:
                    yield bag


def set_action_interpolation(action: bpy.types.Action, interpolation: str = "BEZIER") -> None:
    for bag in action_channel_bags(action):
        for curve in bag.fcurves:
            for key in curve.keyframe_points:
                key.interpolation = interpolation


def make_action(
    armature: bpy.types.Object,
    name: str,
    poses: list[PoseFrame],
) -> bpy.types.Action:
    action = bpy.data.actions.new(name=name)
    action.use_fake_user = True
    armature.animation_data_create()
    armature.animation_data.action = action
    for frame, rotations, locations, scales in poses:
        bpy.context.scene.frame_set(frame)
        for bone in armature.pose.bones:
            bone.rotation_mode = "XYZ"
            bone.rotation_euler = rotations.get(bone.name, (0.0, 0.0, 0.0))
            bone.location = locations.get(bone.name, (0.0, 0.0, 0.0))
            bone.scale = scales.get(bone.name, (1.0, 1.0, 1.0))
            bone.keyframe_insert("rotation_euler", frame=frame, group=bone.name)
            bone.keyframe_insert("location", frame=frame, group=bone.name)
            bone.keyframe_insert("scale", frame=frame, group=bone.name)
    set_action_interpolation(action)
    return action


def wing_flap(config: SpeciesConfig, phase: float, strength: float = 1.0) -> RotationMap:
    rotations: RotationMap = {}
    if config.wings not in {"four", "butterfly"}:
        return rotations
    flap = math.sin(phase) * strength
    for label, multiplier in (("Fore", 1.0), ("Hind", 0.78)):
        rotations[f"Wing_{label}_L"] = (0.0, -0.18 * flap, 0.92 * flap * multiplier)
        rotations[f"Wing_{label}_R"] = (0.0, 0.18 * flap, -0.92 * flap * multiplier)
    return rotations


def idle_action(config: SpeciesConfig, armature: bpy.types.Object) -> bpy.types.Action:
    poses: list[PoseFrame] = []
    for frame in (0, 12, 24, 36, 48):
        phase = frame / 48 * math.tau
        wave = math.sin(phase)
        rotations: RotationMap = {
            "Head": (0.025 * math.cos(phase), 0.0, 0.055 * wave),
            "Abdomen": (-0.018 * math.cos(phase), 0.035 * wave, 0.0),
            "Antenna_L_1": (0.08 * wave, 0.0, 0.12 * math.cos(phase)),
            "Antenna_R_1": (-0.08 * wave, 0.0, -0.12 * math.cos(phase)),
            "Antenna_L_2": (-0.05 * wave, 0.04 * math.cos(phase), 0.08 * wave),
            "Antenna_R_2": (0.05 * wave, -0.04 * math.cos(phase), -0.08 * wave),
        }
        if config.flying:
            rotations.update(wing_flap(config, phase * 4, 0.28))
        locations = {"Thorax": (0.0, 0.0, (0.025 if config.flying else 0.008) * (1.0 + wave))}
        poses.append((frame, rotations, locations, {}))
    return make_action(armature, "idle", poses)


def walk_action(config: SpeciesConfig, armature: bpy.types.Object) -> bpy.types.Action:
    poses: list[PoseFrame] = []
    tripod_a = {("Front", "L"), ("Mid", "R"), ("Rear", "L")}
    for frame in range(0, 33, 4):
        phase = frame / 32 * math.tau
        rotations: RotationMap = {
            "Head": (0.035 * math.cos(phase * 2), 0.0, 0.045 * math.sin(phase)),
            "Abdomen": (-0.045 * math.cos(phase * 2), 0.055 * math.sin(phase), 0.0),
            "Antenna_L_1": (0.08 * math.sin(phase + 0.5), 0.0, 0.08),
            "Antenna_R_1": (0.08 * math.sin(phase + 1.1), 0.0, -0.08),
        }
        for pair in ("Front", "Mid", "Rear"):
            for side in ("L", "R"):
                offset = 0.0 if (pair, side) in tripod_a else math.pi
                cycle = math.sin(phase + offset)
                lift = max(0.0, cycle)
                side_sign = 1.0 if side == "L" else -1.0
                prefix = f"Leg_{pair}_{side}"
                amplitude = 0.30 if config.species != "mantis" or pair != "Front" else 0.18
                rotations[f"{prefix}_Coxa"] = (amplitude * cycle, 0.07 * side_sign * cycle, 0.10 * side_sign)
                rotations[f"{prefix}_Femur"] = (-0.36 * lift + 0.11 * min(0.0, cycle), 0.0, 0.08 * side_sign * cycle)
                rotations[f"{prefix}_Tibia"] = (0.50 * lift - 0.10 * min(0.0, cycle), 0.0, 0.0)
                rotations[f"{prefix}_Tarsus"] = (-0.22 * lift, 0.0, 0.0)
        if config.flying:
            rotations.update(wing_flap(config, phase * 4, 0.96))
            for pair in ("Front", "Mid", "Rear"):
                for side, sign in (("L", 1.0), ("R", -1.0)):
                    rotations[f"Leg_{pair}_{side}_Femur"] = (0.48, 0.0, sign * 0.24)
                    rotations[f"Leg_{pair}_{side}_Tibia"] = (-0.62, 0.0, 0.0)
        bob = (0.075 if config.flying else 0.027) * (1.0 - math.cos(phase * 2)) * 0.5
        poses.append((frame, rotations, {"Thorax": (0.0, 0.0, bob)}, {}))
    return make_action(armature, "walk", poses)


def attack_pose(config: SpeciesConfig, strength: float, release: float) -> tuple[RotationMap, LocationMap]:
    rotations: RotationMap = {}
    locations: LocationMap = {}
    if config.species == "ant":
        rotations.update({
            "Head": (-0.20 * strength + 0.08 * release, 0.0, 0.0),
            "Mandible_L": (0.0, 0.44 * strength, -0.62 * strength),
            "Mandible_R": (0.0, -0.44 * strength, 0.62 * strength),
            "Antenna_L_1": (-0.24 * strength, 0.0, 0.12),
            "Antenna_R_1": (-0.24 * strength, 0.0, -0.12),
        })
        locations["Thorax"] = (0.0, -0.16 * strength + 0.05 * release, 0.0)
    elif config.species == "bee":
        rotations.update({
            "Abdomen": (-0.68 * strength + 0.18 * release, 0.0, 0.0),
            "Head": (0.18 * strength, 0.0, 0.0),
            "Stinger": (0.14 * strength, 0.0, 0.0),
        })
        rotations.update(wing_flap(config, math.pi * 0.5, 1.12 * strength))
        locations["Stinger"] = (0.0, 0.28 * strength, 0.0)
        locations["Thorax"] = (0.0, -0.10 * strength, 0.08 * strength)
    elif config.species == "beetle":
        rotations.update({
            "Thorax": (0.20 * strength, 0.0, 0.0),
            "Head": (-0.52 * strength + 0.15 * release, 0.0, 0.0),
            "Horn": (-0.18 * strength, 0.0, 0.0),
            "Wing_Case_L": (0.0, 0.08 * strength, 0.11 * strength),
            "Wing_Case_R": (0.0, -0.08 * strength, -0.11 * strength),
        })
        locations["Thorax"] = (0.0, -0.24 * strength + 0.08 * release, 0.015 * strength)
    elif config.species == "mantis":
        rotations.update({
            "Head": (-0.12 * strength, 0.0, 0.10 * strength),
            "Leg_Front_L_Coxa": (-0.52 * strength, 0.0, 0.28),
            "Leg_Front_L_Femur": (1.28 * strength, 0.0, -0.20),
            "Leg_Front_L_Tibia": (-1.58 * strength, 0.0, 0.0),
            "Leg_Front_R_Coxa": (-0.46 * strength, 0.0, -0.25),
            "Leg_Front_R_Femur": (1.12 * strength, 0.0, 0.18),
            "Leg_Front_R_Tibia": (-1.46 * strength, 0.0, 0.0),
        })
        locations["Thorax"] = (0.0, -0.11 * strength, 0.04 * strength)
    else:
        rotations.update(wing_flap(config, math.pi * 0.5, 1.26 * strength))
        rotations.update({
            "Head": (-0.18 * strength, 0.0, 0.0),
            "Abdomen": (0.22 * strength, 0.0, 0.0),
            "Antenna_L_1": (-0.35 * strength, 0.0, 0.22 * strength),
            "Antenna_R_1": (-0.35 * strength, 0.0, -0.22 * strength),
        })
        locations["Thorax"] = (0.0, -0.08 * strength, 0.12 * strength)
    return rotations, locations


def attack_action(config: SpeciesConfig, armature: bpy.types.Object) -> bpy.types.Action:
    poses: list[PoseFrame] = []
    for frame, strength, release in (
        (0, 0.0, 0.0),
        (8, -0.46, 0.0),
        (16, 0.52, 0.0),
        (21, 1.0, 0.0),
        (28, 0.34, 0.45),
        (36, 0.0, 0.0),
    ):
        rotations, locations = attack_pose(config, strength, release)
        poses.append((frame, rotations, locations, {}))
    return make_action(armature, "attack", poses)


def hit_action(config: SpeciesConfig, armature: bpy.types.Object) -> bpy.types.Action:
    poses: list[PoseFrame] = []
    for frame, strength in ((0, 0.0), (4, 1.0), (9, -0.28), (16, 0.0)):
        rotations: RotationMap = {
            "Thorax": (0.04 * strength, 0.0, 0.34 * strength),
            "Head": (-0.20 * strength, 0.0, -0.26 * strength),
            "Abdomen": (0.13 * strength, 0.0, 0.18 * strength),
            "Antenna_L_1": (-0.30 * strength, 0.0, 0.16 * strength),
            "Antenna_R_1": (-0.30 * strength, 0.0, -0.16 * strength),
        }
        if config.flying:
            rotations.update(wing_flap(config, math.pi * 0.5, 0.44 * strength))
        poses.append((frame, rotations, {"Thorax": (0.0, 0.07 * strength, 0.025 * abs(strength))}, {}))
    return make_action(armature, "hit", poses)


def death_action(config: SpeciesConfig, armature: bpy.types.Object) -> bpy.types.Action:
    poses: list[PoseFrame] = []
    for frame, progress in ((0, 0.0), (10, 0.16), (22, 0.56), (34, 0.88), (48, 1.0)):
        eased = progress * progress * (3.0 - 2.0 * progress)
        rotations: RotationMap = {
            "Thorax": (0.12 * eased, 0.0, (1.34 if config.species != "mantis" else -1.28) * eased),
            "Head": (-0.42 * eased, 0.08 * eased, -0.18 * eased),
            "Abdomen": (0.55 * eased, -0.12 * eased, 0.16 * eased),
            "Antenna_L_1": (0.72 * eased, 0.0, 0.42 * eased),
            "Antenna_R_1": (0.72 * eased, 0.0, -0.42 * eased),
            "Mandible_L": (0.0, 0.16 * eased, -0.30 * eased),
            "Mandible_R": (0.0, -0.16 * eased, 0.30 * eased),
        }
        for pair in ("Front", "Mid", "Rear"):
            for side, sign in (("L", 1.0), ("R", -1.0)):
                prefix = f"Leg_{pair}_{side}"
                rotations[f"{prefix}_Coxa"] = (0.48 * eased, 0.0, sign * 0.55 * eased)
                rotations[f"{prefix}_Femur"] = (-0.92 * eased, 0.0, sign * 0.24 * eased)
                rotations[f"{prefix}_Tibia"] = (1.18 * eased, 0.0, 0.0)
                rotations[f"{prefix}_Tarsus"] = (-0.62 * eased, 0.0, 0.0)
        if config.wings in {"four", "butterfly"}:
            rotations.update(wing_flap(config, math.pi * 0.5, 0.64 * (1.0 - eased)))
        poses.append((frame, rotations, {"Thorax": (0.0, 0.08 * eased, -0.27 * eased)}, {}))
    return make_action(armature, "death", poses)


def spawn_action(config: SpeciesConfig, armature: bpy.types.Object) -> bpy.types.Action:
    poses: list[PoseFrame] = []
    for frame, scale_value, settle in (
        (0, 0.28, 1.0),
        (7, 0.48, 0.82),
        (15, 1.12, 0.36),
        (24, 0.92, 0.16),
        (31, 1.04, 0.06),
        (36, 1.0, 0.0),
    ):
        rotations: RotationMap = {
            "Head": (0.34 * settle, 0.0, 0.0),
            "Abdomen": (-0.28 * settle, 0.0, 0.0),
            "Antenna_L_1": (0.36 * settle, 0.0, 0.22 * settle),
            "Antenna_R_1": (0.36 * settle, 0.0, -0.22 * settle),
        }
        for pair in ("Front", "Mid", "Rear"):
            for side, sign in (("L", 1.0), ("R", -1.0)):
                rotations[f"Leg_{pair}_{side}_Femur"] = (-0.72 * settle, 0.0, sign * 0.22 * settle)
                rotations[f"Leg_{pair}_{side}_Tibia"] = (1.04 * settle, 0.0, 0.0)
        if config.flying:
            rotations.update(wing_flap(config, math.pi * 0.5, 0.72 * (1.0 - settle)))
        poses.append((
            frame,
            rotations,
            {"Thorax": (0.0, 0.0, -0.18 * settle)},
            {"Thorax": (scale_value, scale_value, scale_value)},
        ))
    return make_action(armature, "spawn", poses)


def build_actions(config: SpeciesConfig, armature: bpy.types.Object) -> dict[str, bpy.types.Action]:
    return {
        "idle": idle_action(config, armature),
        "walk": walk_action(config, armature),
        "attack": attack_action(config, armature),
        "hit": hit_action(config, armature),
        "death": death_action(config, armature),
        "spawn": spawn_action(config, armature),
    }


def build_species(config: SpeciesConfig) -> RigBuild:
    clear_scene()
    bpy.context.scene.render.fps = 24
    materials = {
        name: material(name, color, roughness, metallic)
        for name, color, roughness, metallic in config.palette
    }
    body = body_layout(config)
    armature, expected_bones, points_by_leg, wing_bones = build_skeleton(config, body)
    parts: list[bpy.types.Object] = []
    build_body(config, materials, body, parts)
    build_legs(config, materials, points_by_leg, parts)
    build_wings(config, materials, body, parts)
    mesh = join_parts(parts, armature, config.species)
    actions = build_actions(config, armature)
    armature["species"] = config.species
    armature["clips"] = sorted(actions)
    return RigBuild(config, armature, mesh, actions, expected_bones, materials, wing_bones)


def mesh_triangles(mesh: bpy.types.Object) -> int:
    mesh.data.calc_loop_triangles()
    return len(mesh.data.loop_triangles)


def export_species(build: RigBuild, output: Path) -> None:
    armature = build.armature
    mesh = build.mesh
    if not armature.animation_data:
        raise RuntimeError(f"{build.config.species}: missing animation data")
    for track in list(armature.animation_data.nla_tracks):
        armature.animation_data.nla_tracks.remove(track)
    armature.animation_data.action = build.actions["idle"]
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature
    output.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_image_quality=86,
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_extras=True,
    )
    if result != {"FINISHED"} or not output.exists():
        raise RuntimeError(f"failed to export {output}")
    print(
        "EXPORTED",
        build.config.species,
        output,
        output.stat().st_size,
        "TRIANGLES",
        mesh_triangles(mesh),
        "BONES",
        len(build.expected_bones),
    )


def evaluated_positions(mesh: bpy.types.Object) -> list[Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(depsgraph)
    temporary = evaluated.to_mesh()
    transform = evaluated.matrix_world
    values = [transform @ vertex.co for vertex in temporary.vertices]
    evaluated.to_mesh_clear()
    return values


def audit_species(
    path: Path,
    config: SpeciesConfig,
    expected_bones: set[str],
) -> dict[str, object]:
    clear_scene()
    result = bpy.ops.import_scene.gltf(filepath=str(path))
    if result != {"FINISHED"}:
        raise RuntimeError(f"{path.name}: import audit failed")
    all_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and len(obj.data.vertices) > 0]
    meshes = [
        obj
        for obj in all_meshes
        if any(modifier.type == "ARMATURE" and modifier.object is not None for modifier in obj.modifiers)
    ]
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(meshes) != 1 or len(armatures) != 1:
        diagnostics = {
            obj.name: [(modifier.name, modifier.type, getattr(modifier.object, "name", None)) for modifier in obj.modifiers]
            for obj in all_meshes
        }
        raise RuntimeError(
            f"{path.name}: expected one skinned mesh/armature, got {len(meshes)}/{len(armatures)}; "
            f"mesh diagnostics={diagnostics}"
        )
    mesh = meshes[0]
    armature = armatures[0]
    imported_bones = {bone.name for bone in armature.data.bones}
    missing_bones = expected_bones - imported_bones
    if missing_bones:
        raise RuntimeError(f"{path.name}: missing bones {sorted(missing_bones)}")
    for required in ("Root", "Thorax", "Head", "Abdomen", "Mandible_L", "Mandible_R", "Antenna_L_1", "Antenna_R_1"):
        if required not in imported_bones:
            raise RuntimeError(f"{path.name}: required bone {required} is missing")
    for pair in ("Front", "Mid", "Rear"):
        for side in ("L", "R"):
            for segment in ("Coxa", "Femur", "Tibia", "Tarsus"):
                name = f"Leg_{pair}_{side}_{segment}"
                if name not in imported_bones:
                    raise RuntimeError(f"{path.name}: leg bone {name} is missing")
    if config.wings != "none" and not any(name.startswith("Wing_") for name in imported_bones):
        raise RuntimeError(f"{path.name}: wing bones are missing")

    actions = {action.name.lower(): action for action in bpy.data.actions}
    if set(actions) != EXPECTED_CLIPS:
        raise RuntimeError(f"{path.name}: clips {sorted(actions)}, expected {sorted(EXPECTED_CLIPS)}")
    if any(action.name != action.name.lower() for action in actions.values()):
        raise RuntimeError(f"{path.name}: clip names must be lowercase")

    armature.animation_data_create()
    deformation: dict[str, float] = {}
    root_motion: dict[str, float] = {}
    clip_ranges: dict[str, list[int]] = {}
    for name, expected_end in CLIP_ENDS.items():
        action = actions[name]
        start, end = (round(value) for value in action.frame_range)
        clip_ranges[name] = [start, end]
        if start != 0 or end != expected_end:
            raise RuntimeError(f"{path.name}:{name} range {start}-{end}, expected 0-{expected_end}")
        armature.animation_data.action = action
        samples = [start, round(end * 0.25), round(end * 0.5), round(end * 0.75), end]
        positions: list[list[Vector]] = []
        root_locations: list[Vector] = []
        for frame in samples:
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            positions.append(evaluated_positions(mesh))
            root_locations.append(armature.pose.bones["Root"].location.copy())
        reference = positions[0]
        deformation[name] = max(
            (current[index] - reference[index]).length
            for current in positions[1:]
            for index in range(len(reference))
        )
        root_motion[name] = max((location - root_locations[0]).length for location in root_locations)
        if deformation[name] < 0.002:
            raise RuntimeError(f"{path.name}:{name} has no measurable deformation")
        if root_motion[name] > 1e-5:
            raise RuntimeError(f"{path.name}:{name} moves Root by {root_motion[name]}")

    weighted = sum(1 for vertex in mesh.data.vertices if vertex.groups)
    if weighted != len(mesh.data.vertices):
        raise RuntimeError(f"{path.name}: {len(mesh.data.vertices) - weighted} unweighted vertices")
    if any(len(vertex.groups) != 1 for vertex in mesh.data.vertices):
        raise RuntimeError(f"{path.name}: rigid insect skin expects exactly one influence per vertex")

    mesh.data.calc_loop_triangles()
    triangles = len(mesh.data.loop_triangles)
    if triangles <= 500 or triangles > 14_000:
        raise RuntimeError(f"{path.name}: triangle budget {triangles} is outside 501..14000")
    mesh.data.update()
    xs = [vertex.co.x for vertex in mesh.data.vertices]
    ys = [vertex.co.y for vertex in mesh.data.vertices]
    zs = [vertex.co.z for vertex in mesh.data.vertices]
    dimensions = [
        round(max(xs) - min(xs), 4),
        round(max(ys) - min(ys), 4),
        round(max(zs) - min(zs), 4),
    ]
    imported_materials: dict[str, list[float]] = {}
    for value in mesh.data.materials:
        if value is None:
            continue
        base_color = tuple(value.diffuse_color)
        if value.use_nodes and value.node_tree:
            bsdf = next((node for node in value.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
            if bsdf and "Base Color" in bsdf.inputs:
                base_color = tuple(bsdf.inputs["Base Color"].default_value)
        imported_materials[value.name] = [round(float(channel), 5) for channel in base_color]
    expected_materials = {entry[0] for entry in config.palette}
    missing_materials = expected_materials - set(imported_materials)
    if missing_materials:
        raise RuntimeError(f"{path.name}: missing exported materials {sorted(missing_materials)}")
    if len({tuple(color) for color in imported_materials.values()}) < 3:
        raise RuntimeError(
            f"{path.name}: exported material palette is unexpectedly flat: {imported_materials}"
        )

    report = {
        "file": path.name,
        "bytes": path.stat().st_size,
        "species": config.species,
        "triangles": triangles,
        "vertices": len(mesh.data.vertices),
        "weightedVertices": weighted,
        "boneCount": len(imported_bones),
        "bones": sorted(imported_bones),
        "clips": clip_ranges,
        "deformationMax": {name: round(value, 6) for name, value in deformation.items()},
        "rootMotionMax": {name: round(value, 8) for name, value in root_motion.items()},
        "dimensions": dimensions,
        "materials": imported_materials,
    }
    print("AUDIT_FILE", path.name)
    print(" AUDIT_BONES", len(imported_bones))
    print(" AUDIT_TRIANGLES", triangles, "VERTICES", len(mesh.data.vertices), "WEIGHTED", weighted)
    print(" AUDIT_CLIPS", clip_ranges)
    print(" AUDIT_DEFORMATION", report["deformationMax"])
    print(" AUDIT_ROOT_MOTION", report["rootMotionMax"])
    print(" AUDIT_MATERIALS", imported_materials)
    return report


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def render_qa(path: Path, config: SpeciesConfig) -> Path:
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    armature.animation_data_create()
    idle = next(action for action in bpy.data.actions if action.name.lower() == "idle")
    armature.animation_data.action = idle
    bpy.context.scene.frame_set(12)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("QAWorld")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background") if scene.world.node_tree else None
    if background:
        background.inputs["Color"].default_value = (0.012, 0.025, 0.021, 1.0)
        background.inputs["Strength"].default_value = 0.28

    bpy.ops.mesh.primitive_plane_add(size=7.0, location=(0, 0, -0.018))
    ground = bpy.context.object
    ground_material = material("qa_ground", (0.12, 0.18, 0.08, 1.0), 0.95, 0.0)
    assign_material(ground, ground_material)

    camera_data = bpy.data.cameras.new("QACamera")
    camera = bpy.data.objects.new("QACamera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (3.5, -5.2, 2.7)
    camera.data.lens = 58
    look_at(camera, Vector((0, 0.15, 0.58 * config.body_scale)))
    scene.camera = camera

    key_data = bpy.data.lights.new("QAKey", "AREA")
    key = bpy.data.objects.new("QAKey", key_data)
    scene.collection.objects.link(key)
    key.location = (-3.5, -4.0, 6.0)
    key_data.energy = 850
    key_data.shape = "DISK"
    key_data.size = 4.0
    fill_data = bpy.data.lights.new("QAFill", "AREA")
    fill = bpy.data.objects.new("QAFill", fill_data)
    scene.collection.objects.link(fill)
    fill.location = (4.0, 2.0, 3.0)
    fill_data.energy = 500
    fill_data.color = (0.42, 0.62, 1.0)
    fill_data.size = 3.0

    QA_DIR.mkdir(parents=True, exist_ok=True)
    output = QA_DIR / f"{config.species}.png"
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
    return output


def manifest_payload() -> dict[str, object]:
    units: dict[str, object] = {}
    for archetype, species in ARCHETYPE_MAP.items():
        units[archetype] = {
            "url": f"generated-v1/{species}.glb",
            "forwardAxis": "+z",
            "clips": {name: name for name in CLIP_ENDS},
            "sampleFrames": {
                "idle": 4,
                "walk": 8,
                "attack": 8,
                "hit": 4,
                "death": 8,
                "spawn": 6,
            },
            "tintMaterials": ["team_mark"],
        }
    return {"version": 1, "units": units}


def build_pack() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    audit_reports: list[dict[str, object]] = []
    expected_by_species: dict[str, set[str]] = {}

    for config in SPECIES:
        print("\nBUILD_SPECIES", config.species)
        build = build_species(config)
        expected_by_species[config.species] = set(build.expected_bones)
        output = OUTPUT_DIR / f"{config.species}.glb"
        export_species(build, output)

    MANIFEST_PATH.write_text(json.dumps(manifest_payload(), indent=2) + "\n", encoding="utf-8")
    print("WROTE_MANIFEST", MANIFEST_PATH)

    for config in SPECIES:
        output = OUTPUT_DIR / f"{config.species}.glb"
        report = audit_species(output, config, expected_by_species[config.species])
        report["qaImage"] = str(render_qa(output, config))
        audit_reports.append(report)

    payload = {
        "generator": str(Path(__file__).resolve()),
        "blender": bpy.app.version_string,
        "externalAssets": False,
        "servicesUsed": [],
        "models": audit_reports,
    }
    AUDIT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("WROTE_AUDIT", AUDIT_PATH)
    print("INSECT_PACK_OK", len(audit_reports), "models")


if __name__ == "__main__":
    try:
        build_pack()
    except Exception as error:
        traceback.print_exc()
        print("INSECT_PACK_FAILED", repr(error), file=sys.stderr)
        raise
