"""Fixed build123d/OCCT STEP-to-SVG inspection projection harness.

The private protocol accepts one bridge-staged STEP path, its exact identity,
and one boolean requesting the fixed mid-envelope YZ section.  There is no
caller code, path selection, camera, section plane, tolerance, style, runtime,
or manufacturing-drawing input.
"""

from __future__ import annotations

import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import re
import sys
from typing import Any


SCHEMA_VERSION = "io.casys.mcp-build123d.drawing-projection/1.0"
ENGINE = {"build123d": "0.11.1", "ocp": "7.9.3.1"}
METHOD = {"id": "build123d-step-svg-projection", "version": "1.0"}
MAXIMUM_STEP_BYTES = 128 * 1024 * 1024
MAXIMUM_SVG_BYTES = 1024 * 1024
MAXIMUM_TOTAL_SVG_BYTES = 4 * 1024 * 1024
SHA256_HEX = re.compile(r"^[a-f0-9]{64}$")

VIEW_SPECS = (
    {
        "id": "top",
        "label": "Top",
        "orientation": "Orthographic projection along -Z",
        "direction": (0.0, 0.0, 1.0),
        "up": (0.0, 1.0, 0.0),
    },
    {
        "id": "front",
        "label": "Front",
        "orientation": "Orthographic projection along +Y",
        "direction": (0.0, -1.0, 0.0),
        "up": (0.0, 0.0, 1.0),
    },
    {
        "id": "right",
        "label": "Right",
        "orientation": "Orthographic projection along -X",
        "direction": (1.0, 0.0, 0.0),
        "up": (0.0, 0.0, 1.0),
    },
    {
        "id": "isometric",
        "label": "Isometric",
        "orientation": "Orthographic projection along (-1,-1,-1)",
        "direction": (1.0, 1.0, 1.0),
        "up": (0.0, 0.0, 1.0),
    },
)

SECTION_SPEC = {
    "id": "section-yz",
    "label": "Section YZ",
    "orientation": "YZ section at envelope midpoint X",
}


def main() -> None:
    try:
        silence_occt_messages()
        request = json.load(sys.stdin)
        step_path, source_step, include_section = parse_request(request)
        projection = project(step_path, source_step, include_section)
        emit({"ok": True, "projection": projection})
    except Exception:
        # Never expose an interpreter traceback or the private staged path.
        emit({"ok": False, "error": "fixed 2D projection harness failure"})


def silence_occt_messages() -> None:
    """Keep stdout as exactly one private-protocol JSON document."""
    from OCP.Message import Message

    messenger = Message.DefaultMessenger_s()
    for printer in list(messenger.Printers()):
        messenger.RemovePrinter(printer)


def parse_request(value: object) -> tuple[Path, dict[str, object], bool]:
    if not isinstance(value, dict) or set(value) != {
        "stepPath",
        "sourceStep",
        "includeSection",
    }:
        raise ValueError("unsupported bridge request")
    step_path = value["stepPath"]
    source_step = value["sourceStep"]
    include_section = value["includeSection"]
    if not isinstance(step_path, str) or not step_path:
        raise ValueError("missing staged STEP")
    if not isinstance(source_step, dict) or set(source_step) != {
        "mimeType",
        "sha256",
        "bytes",
    }:
        raise ValueError("invalid STEP identity")
    if source_step["mimeType"] != "model/step":
        raise ValueError("invalid STEP media type")
    digest = source_step["sha256"]
    if not isinstance(digest, str) or SHA256_HEX.fullmatch(digest) is None:
        raise ValueError("invalid STEP digest")
    byte_count = source_step["bytes"]
    if (
        isinstance(byte_count, bool)
        or not isinstance(byte_count, int)
        or byte_count < 1
        or byte_count > MAXIMUM_STEP_BYTES
    ):
        raise ValueError("invalid STEP byte count")
    if not isinstance(include_section, bool):
        raise ValueError("invalid fixed-section choice")
    return Path(step_path), source_step, include_section


def project(
    step_path: Path,
    source_step: dict[str, object],
    include_section: bool,
) -> dict[str, object]:
    import OCP
    import build123d as b3d

    if b3d.__version__ != ENGINE["build123d"] or OCP.__version__ != ENGINE["ocp"]:
        raise RuntimeError("unsupported projection engine")

    step_bytes = step_path.read_bytes()
    if (
        len(step_bytes) != source_step["bytes"]
        or hashlib.sha256(step_bytes).hexdigest() != source_step["sha256"]
    ):
        raise RuntimeError("staged STEP identity differs")

    shape = b3d.import_step(str(step_path))
    if shape is None or getattr(shape, "wrapped", None) is None:
        raise RuntimeError("STEP contains no projectable shape")

    bbox = shape.bounding_box(optimal=False)
    envelope = (
        canonical_positive(bbox.size.X),
        canonical_positive(bbox.size.Y),
        canonical_positive(bbox.size.Z),
    )
    center = (
        canonical_number((bbox.min.X + bbox.max.X) / 2.0),
        canonical_number((bbox.min.Y + bbox.max.Y) / 2.0),
        canonical_number((bbox.min.Z + bbox.max.Z) / 2.0),
    )
    diagonal = math.sqrt(sum(axis * axis for axis in envelope))
    camera_distance = max(diagonal * 2.0, 1.0)

    views: list[dict[str, object]] = []
    total_svg_bytes = 0
    for spec in VIEW_SPECS:
        direction = spec["direction"]
        origin = tuple(
            center[index] + direction[index] * camera_distance
            for index in range(3)
        )
        visible, hidden = shape.project_to_viewport(
            origin,
            spec["up"],
            look_at=center,
        )
        if len(visible) == 0:
            raise RuntimeError("fixed projection contains no visible edges")
        svg_bytes = export_projection(b3d, visible, hidden)
        total_svg_bytes = add_bounded_view(
            views,
            spec,
            svg_bytes,
            total_svg_bytes,
        )

    if include_section:
        # Local X follows global +Y and local Y follows global +Z. The section
        # plane and position are method-owned and cannot be changed by callers.
        section_plane = b3d.Plane(
            origin=center,
            x_dir=(0.0, 1.0, 0.0),
            z_dir=(1.0, 0.0, 0.0),
        )
        section = b3d.section(shape, section_by=section_plane)
        if section.faces():
            local_section = section_plane.to_local_coords(section)
            section_bytes = export_section(b3d, local_section)
            add_bounded_view(
                views,
                SECTION_SPEC,
                section_bytes,
                total_svg_bytes,
            )

    return {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "drawing-projection",
        "sourceStep": source_step,
        "engine": ENGINE,
        "method": METHOD,
        "envelopeMm": list(envelope),
        "views": views,
    }


def export_projection(b3d: Any, visible: Any, hidden: Any) -> bytes:
    exporter = b3d.ExportSVG(unit=b3d.Unit.MM, margin=0.8, precision=6)
    exporter.add_layer(
        "Hidden",
        line_color=(148, 163, 184),
        line_weight=0.11,
        line_type=b3d.LineType.ISO_DOT,
    )
    exporter.add_layer(
        "Visible",
        line_color=(15, 23, 42),
        line_weight=0.16,
    )
    exporter.add_shape(hidden, layer="Hidden")
    exporter.add_shape(visible, layer="Visible")
    output = BytesIO()
    exporter.write(output)
    return output.getvalue()


def export_section(b3d: Any, section: Any) -> bytes:
    exporter = b3d.ExportSVG(unit=b3d.Unit.MM, margin=0.8, precision=6)
    exporter.add_layer(
        "Cut face",
        fill_color=(219, 234, 254),
        line_color=(30, 64, 175),
        line_weight=0.18,
    )
    exporter.add_shape(section, layer="Cut face")
    output = BytesIO()
    exporter.write(output)
    return output.getvalue()


def add_bounded_view(
    views: list[dict[str, object]],
    spec: dict[str, object],
    svg_bytes: bytes,
    prior_total: int,
) -> int:
    if not svg_bytes or len(svg_bytes) > MAXIMUM_SVG_BYTES:
        raise RuntimeError("one fixed SVG exceeds its byte bound")
    total = prior_total + len(svg_bytes)
    if total > MAXIMUM_TOTAL_SVG_BYTES:
        raise RuntimeError("fixed SVG result exceeds its total byte bound")
    try:
        svg_text = svg_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError("SVG is not UTF-8") from error
    views.append(
        {
            "id": spec["id"],
            "label": spec["label"],
            "orientation": spec["orientation"],
            "svg": {
                "mimeType": "image/svg+xml",
                "sha256": hashlib.sha256(svg_bytes).hexdigest(),
                "bytes": len(svg_bytes),
                "text": svg_text,
            },
        }
    )
    return total


def canonical_positive(value: float) -> float:
    number = canonical_number(value)
    if number <= 0.0:
        raise RuntimeError("projection requires a three-dimensional envelope")
    return number


def canonical_number(value: float) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise RuntimeError("projection produced a non-finite number")
    return 0.0 if number == 0.0 else number


def emit(value: dict[str, object]) -> None:
    json.dump(value, sys.stdout, allow_nan=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
