"""
build123d execution harness

Protocol: a single JSON document on stdin, a single JSON document on stdout.

  stdin  : { "script": str,
             "density_kg_m3": float | null,
             "exports": [ { "format": "step"|"stl"|"gltf", "path": str } ] }
  stdout : { "ok": true,  "metrics": {...}, "exports": [{...}] }
         | { "ok": false, "error": str, "traceback": str | null }

Convention: the script MUST leave its final shape in a variable named
`result` — either a build123d Part/Solid/Compound or a BuildPart builder
(whose `.part` is then taken). Anything else is a hard error, never a guess.

Mass is computed ONLY when density_kg_m3 is provided. No default material,
no default density: without an explicit density there is no mass in the
output at all.
"""

from __future__ import annotations

import hashlib
import json
import sys
import traceback


def fail(error: str, tb: str | None = None) -> None:
    json.dump({"ok": False, "error": error, "traceback": tb}, sys.stdout)
    sys.exit(0)  # protocol-level failure, transported in JSON


def main() -> None:
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        fail(f"Invalid request JSON on stdin: {e}")
        return

    script = request.get("script")
    if not isinstance(script, str) or not script.strip():
        fail("Request field 'script' must be a non-empty string")
        return

    try:
        import build123d as b3d
    except ImportError as e:
        fail(
            "build123d is not installed for this Python interpreter. "
            "Install it with: pip install build123d "
            f"(interpreter: {sys.executable}, error: {e})"
        )
        return

    # Execute the user script. This is deliberate arbitrary code execution —
    # CAD-as-code is the point of this server; the README says so plainly.
    namespace: dict = {}
    try:
        exec(compile(script, "<cad_script>", "exec"), namespace)
    except Exception as e:
        fail(f"Script raised {type(e).__name__}: {e}", traceback.format_exc())
        return

    result = namespace.get("result")
    if result is None:
        fail(
            "The script must assign its final shape to a variable named "
            "'result' (a Part, Solid, Compound, or a BuildPart builder). "
            f"Variables defined: {sorted(k for k in namespace if not k.startswith('__'))}"
        )
        return

    # A BuildPart builder is accepted; its .part is the shape.
    if isinstance(result, b3d.BuildPart):
        result = result.part
    if result is None or not hasattr(result, "volume"):
        fail(
            f"'result' is {type(namespace.get('result')).__name__}, which has "
            "no geometry. Assign a Part, Solid, Compound, or BuildPart."
        )
        return

    # ── Metrics (units are explicit in every field name) ──
    try:
        volume_mm3 = float(result.volume)
        area_mm2 = float(result.area)
        com = result.center(b3d.CenterOf.MASS)
        bbox = result.bounding_box()
        metrics = {
            "volume_mm3": volume_mm3,
            "area_mm2": area_mm2,
            "center_of_mass_mm": [float(com.X), float(com.Y), float(com.Z)],
            "bounding_box_mm": {
                "min": [float(bbox.min.X), float(bbox.min.Y), float(bbox.min.Z)],
                "max": [float(bbox.max.X), float(bbox.max.Y), float(bbox.max.Z)],
                "size": [float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)],
            },
            "solids": len(result.solids()),
            "faces": len(result.faces()),
            "edges": len(result.edges()),
        }
    except Exception as e:
        fail(f"Failed to compute metrics: {type(e).__name__}: {e}", traceback.format_exc())
        return

    density = request.get("density_kg_m3")
    if density is not None:
        if not isinstance(density, (int, float)) or density <= 0:
            fail(f"density_kg_m3 must be a positive number, got: {density!r}")
            return
        metrics["density_kg_m3"] = float(density)
        metrics["mass_kg"] = volume_mm3 * 1e-9 * float(density)

    # ── Exports ──
    exported = []
    for spec in request.get("exports") or []:
        fmt, path = spec.get("format"), spec.get("path")
        try:
            if fmt == "step":
                b3d.export_step(result, path)
            elif fmt == "stl":
                b3d.export_stl(result, path)
            elif fmt == "gltf":
                b3d.export_gltf(result, path, binary=True)
            else:
                fail(f"Unsupported export format: {fmt!r}. Supported: step, stl, gltf")
                return
        except Exception as e:
            fail(f"Export {fmt} to {path} failed: {type(e).__name__}: {e}",
                 traceback.format_exc())
            return
        # Read the completed artifact once and derive both identity fields from
        # those exact bytes.  The path remains a location; sha256 is the
        # immutable identity that downstream tools can verify after copying.
        with open(path, "rb") as artifact:
            artifact_bytes = artifact.read()
        exported.append(
            {
                "format": fmt,
                "path": path,
                "bytes": len(artifact_bytes),
                "sha256": hashlib.sha256(artifact_bytes).hexdigest(),
            }
        )

    json.dump({"ok": True, "metrics": metrics, "exports": exported}, sys.stdout)


if __name__ == "__main__":
    main()
