"""Fixed OCCT/XCAF factual assembly-integrity observer.

Protocol is private to the Deno bridge.  It reads one bridge-staged STEP path;
there is no caller code, timeout, path, runtime, provider, or network input.
The record deliberately contains observations only, never a product judgement.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import sys
from typing import Any


SCHEMA_VERSION = "build123d-assembly-integrity-observation/1.0"
METHOD = {
    "id": "occt-assembly-integrity-v1",
    "version": "1.0.0",
    "linearToleranceMm": 0.000001,
}
PRODUCER_SERVICE = "mcp-build123d"
PRODUCER_PACKAGE_VERSION = "0.5.1"
PRODUCER_TOOL = "build123d_observe_assembly_integrity"
CADQUERY_OCP_VERSION = "7.9.3.1"
MAXIMUM_OCCURRENCES = 32
MAXIMUM_PAIRS = 496
ASCII_LABEL_MAX = 255


class ImportFailed(Exception):
    """A STEP import was objectively attempted but not accepted by OCCT."""


def main() -> None:
    try:
        silence_occt_messages()
        request = json.load(sys.stdin)
        step_path, artifact = parse_request(request)
        observation = observe(step_path, artifact)
        emit({"ok": True, "observation": observation})
    except Exception:
        # The bridge does not expose an interpreter traceback or staged path.
        emit({"ok": False, "error": "fixed assembly-integrity harness failure"})


def silence_occt_messages() -> None:
    """The bridge protocol has exactly one stdout JSON document."""
    from OCP.Message import Message

    messenger = Message.DefaultMessenger_s()
    for printer in list(messenger.Printers()):
        messenger.RemovePrinter(printer)


def parse_request(value: object) -> tuple[Path, dict[str, object]]:
    if not isinstance(value, dict) or set(value) != {"stepPath", "inputArtifact"}:
        raise ValueError("unsupported bridge request")
    step_path = value["stepPath"]
    artifact = value["inputArtifact"]
    if not isinstance(step_path, str) or not step_path:
        raise ValueError("missing staged STEP")
    if not isinstance(artifact, dict) or set(artifact) != {"mimeType", "sha256", "bytes"}:
        raise ValueError("invalid artifact identity")
    if artifact["mimeType"] != "model/step":
        raise ValueError("invalid artifact media type")
    if not isinstance(artifact["sha256"], str) or len(artifact["sha256"]) != 64:
        raise ValueError("invalid artifact digest")
    if isinstance(artifact["bytes"], bool) or not isinstance(artifact["bytes"], int) or artifact["bytes"] < 1:
        raise ValueError("invalid artifact byte count")
    return Path(step_path), artifact


def observe(step_path: Path, artifact: dict[str, object]) -> dict[str, object]:
    try:
        document, root_label, root_shape, unit_system = import_xcaf(step_path)
    except ImportFailed:
        return failed_import_observation(artifact)

    topology = topology_facts(root_shape) if root_shape is not None else unresolved_topology()
    components = direct_occurrences(root_label)
    if components["status"] != "observed":
        return observation(
            artifact,
            "imported",
            unit_system,
            topology,
            components,
            unsupported_or_identity_gap(components),
        )
    occurrence_value, shapes = components["value"]
    labels = [occurrence["label"] for occurrence in occurrence_value]
    pairs = []
    for first_index, first_label in enumerate(labels):
        for second_label in labels[first_index + 1 :]:
            metrics = pair_metrics(shapes[first_label], shapes[second_label])
            pairs.append(
                {
                    "firstLabel": first_label,
                    "secondLabel": second_label,
                    "linearToleranceMm": METHOD["linearToleranceMm"],
                    "minimumDistanceMm": metrics["minimumDistanceMm"],
                    "intersectionVolumeMm3": metrics["intersectionVolumeMm3"],
                    "contact": metrics["contact"],
                }
            )
    return observation(
        artifact,
        "imported",
        unit_system,
        topology,
        observed(occurrence_value),
        observed(pairs),
    )


def import_xcaf(step_path: Path) -> tuple[Any, Any, Any, dict[str, object]]:
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDF import TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

    application = XCAFApp_Application.GetApplication_s()
    document = TDocStd_Document(TCollection_ExtendedString("assembly-integrity"))
    application.NewDocument(TCollection_ExtendedString("BinXCAF"), document)
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    if reader.ReadFile(str(step_path)) != IFSelect_RetDone:
        raise ImportFailed()
    if not reader.Transfer(document):
        raise ImportFailed()
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    # Exactly one root is needed to identify direct components. More (or fewer)
    # roots are not a failed import: the file imported, but v1 cannot make one
    # direct occurrence identity table without inventing a hierarchy.
    root_label = roots.Value(1) if roots.Length() == 1 else None
    try:
        root_shape = shape_tool.GetOneShape()
        if root_shape.IsNull():
            root_shape = None
    except Exception:
        root_shape = None
    return document, root_label, root_shape, xcaf_unit_system(reader)


def xcaf_unit_system(reader: Any) -> dict[str, object]:
    """Observe mm only from explicit OCCT STEP file-unit metadata."""
    try:
        from OCP.TColStd import TColStd_SequenceOfAsciiString

        length_units = TColStd_SequenceOfAsciiString()
        angle_units = TColStd_SequenceOfAsciiString()
        solid_angle_units = TColStd_SequenceOfAsciiString()
        # STEPCAFControl_Reader owns a STEPControl_Reader which exposes the
        # file metadata. Do not infer units from a writer, file name or method.
        reader.Reader().FileUnits(length_units, angle_units, solid_angle_units)
        if length_units.Length() != 1:
            return unavailable()
        raw = length_units.Value(1)
        token = raw.ToCString() if hasattr(raw, "ToCString") else str(raw)
        normalized = token.upper().replace("_", "").replace(" ", "")
        if normalized in {"MM", "MILLIMETRE", "MILLIMETER"}:
            return observed("mm")
    except Exception:
        pass
    return unavailable()


def direct_occurrences(root_label: Any) -> dict[str, object]:
    if root_label is None:
        return unresolved("identity-missing")
    from OCP.TDF import TDF_LabelSequence
    from OCP.TDataStd import TDataStd_Name
    from OCP.XCAFDoc import XCAFDoc_ShapeTool

    labels = TDF_LabelSequence()
    # False deliberately excludes descendants: v1 observes immediate assembly
    # components only and never manufactures a recursive occurrence hierarchy.
    if not XCAFDoc_ShapeTool.GetComponents_s(root_label, labels, False):
        return unresolved("identity-missing")
    if labels.Length() == 0:
        return unresolved("identity-missing")
    if labels.Length() > MAXIMUM_OCCURRENCES:
        return unavailable()
    observed_shapes: dict[str, Any] = {}
    observed_occurrences: dict[str, dict[str, object]] = {}
    for index in range(1, labels.Length() + 1):
        label = labels.Value(index)
        name = TDataStd_Name()
        if not label.FindAttribute(TDataStd_Name.GetID_s(), name):
            return unresolved("identity-missing")
        occurrence_label = name.Get().ToExtString()
        if not valid_ascii_label(occurrence_label) or occurrence_label in observed_shapes:
            return unresolved("identity-missing")
        shape = XCAFDoc_ShapeTool.GetShape_s(label)
        if shape.IsNull():
            return unresolved("identity-missing")
        observed_shapes[occurrence_label] = shape
        observed_occurrences[occurrence_label] = {
            "label": occurrence_label,
            "transform": occurrence_transform(label),
        }
    ordered = sorted(observed_shapes)
    if pair_count(len(ordered)) > MAXIMUM_PAIRS:
        return unavailable()
    return observed(
        ([observed_occurrences[label] for label in ordered], observed_shapes)
    )


def occurrence_transform(label: Any) -> dict[str, object]:
    """Read one XCAF instance Location as a canonical rigid 4×4 transform."""
    try:
        from OCP.XCAFDoc import XCAFDoc_ShapeTool

        transform = XCAFDoc_ShapeTool.GetLocation_s(label).Transformation()
        matrix = [
            canonical_number(transform.Value(row, column))
            for row in range(1, 4)
            for column in range(1, 5)
        ] + [0.0, 0.0, 0.0, 1.0]
        if not rigid_matrix(matrix):
            return unresolved("observability-missing")
        return observed(matrix)
    except ImportError:
        return unavailable()
    except Exception:
        return unresolved("observability-missing")


def topology_facts(shape: Any) -> dict[str, dict[str, object]]:
    return {
        "brepValidity": observed_or_unavailable(
            lambda: "valid" if brep_is_valid(shape) else "invalid"
        ),
        "solidCount": observed_or_unavailable(lambda: len(subshapes(shape, "solid"))),
        "shellCount": observed_or_unavailable(lambda: len(subshapes(shape, "shell"))),
        "degenerateEdgeCount": observed_or_unavailable(lambda: degenerate_edge_count(shape)),
        "freeEdgeCount": observed_or_unavailable(lambda: free_edge_count(shape)),
    }


def unresolved_topology() -> dict[str, dict[str, str]]:
    return {
        "brepValidity": unresolved("observability-missing"),
        "solidCount": unresolved("observability-missing"),
        "shellCount": unresolved("observability-missing"),
        "degenerateEdgeCount": unresolved("observability-missing"),
        "freeEdgeCount": unresolved("observability-missing"),
    }


def unsupported_or_identity_gap(occurrences: dict[str, object]) -> dict[str, str]:
    """Pairs share an identity gap, or are unavailable with an unsupported bound."""
    if occurrences["status"] == "unavailable":
        return unavailable()
    return unresolved("identity-missing")


def brep_is_valid(shape: Any) -> bool:
    from OCP.BRepCheck import BRepCheck_Analyzer

    return bool(BRepCheck_Analyzer(shape).IsValid())


def subshapes(shape: Any, kind: str) -> list[Any]:
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    kind_map = {"edge": TopAbs_EDGE, "shell": TopAbs_SHELL, "solid": TopAbs_SOLID}
    explorer = TopExp_Explorer(shape, kind_map[kind])
    result: list[Any] = []
    while explorer.More():
        result.append(explorer.Current())
        explorer.Next()
    return result


def degenerate_edge_count(shape: Any) -> int:
    from OCP.BRep import BRep_Tool
    from OCP.TopoDS import TopoDS

    return sum(
        1
        for edge in subshapes(shape, "edge")
        if BRep_Tool.Degenerated_s(TopoDS.Edge_s(edge))
    )


def free_edge_count(shape: Any) -> int:
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    ancestors = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, ancestors)
    return sum(
        1
        for index in range(1, ancestors.Extent() + 1)
        if ancestors.FindFromIndex(index).Size() == 1
    )


def pair_metrics(first: Any, second: Any) -> dict[str, dict[str, object]]:
    distance = observed_or_unavailable(lambda: minimum_distance_mm(first, second))
    intersection_volume = observed_or_unavailable(
        lambda: intersection_volume_mm3(first, second)
    )
    if distance["status"] == "observed" and isinstance(distance.get("value"), (int, float)):
        contact = observed(
            "contact" if float(distance["value"]) <= METHOD["linearToleranceMm"] else "no-contact"
        )
    else:
        contact = unavailable()
    return {
        "minimumDistanceMm": distance,
        "intersectionVolumeMm3": intersection_volume,
        "contact": contact,
    }


def minimum_distance_mm(first: Any, second: Any) -> float:
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    distance = BRepExtrema_DistShapeShape(first, second)
    distance.SetDeflection(METHOD["linearToleranceMm"])
    distance.SetMultiThread(False)
    distance.Perform()
    if not distance.IsDone():
        raise RuntimeError("minimum distance unavailable")
    value = float(distance.Value())
    return canonical_nonnegative(value, "minimum distance")


def intersection_volume_mm3(first: Any, second: Any) -> float:
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    common = BRepAlgoAPI_Common(first, second)
    common.SetFuzzyValue(METHOD["linearToleranceMm"])
    common.SetRunParallel(False)
    common.Build()
    if not common.IsDone():
        raise RuntimeError("intersection unavailable")
    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(common.Shape(), properties)
    value = float(properties.Mass())
    return canonical_nonnegative(value, "intersection volume")


def canonical_nonnegative(value: float, name: str) -> float:
    if not math.isfinite(value) or value < 0:
        raise RuntimeError(f"invalid {name}")
    # JSON has a distinct textual -0.0. The provider's factual record has one
    # canonical zero, which the Deno decoder enforces as well.
    return 0.0 if value == 0.0 else value


def canonical_number(value: object) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise RuntimeError("non-finite transform coordinate")
    return 0.0 if number == 0.0 else number


def rigid_matrix(matrix: list[float]) -> bool:
    if len(matrix) != 16 or matrix[12:] != [0.0, 0.0, 0.0, 1.0]:
        return False
    rows = [matrix[0:3], matrix[4:7], matrix[8:11]]
    tolerance = 1e-9
    for row in range(3):
        if abs(sum(value * value for value in rows[row]) - 1.0) > tolerance:
            return False
        for other in range(row + 1, 3):
            if abs(sum(rows[row][index] * rows[other][index] for index in range(3))) > tolerance:
                return False
    determinant = (
        rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
        - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
        + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0])
    )
    return abs(determinant - 1.0) <= tolerance


def failed_import_observation(artifact: dict[str, object]) -> dict[str, object]:
    topology = {
        "brepValidity": unresolved("observability-missing"),
        "solidCount": unresolved("observability-missing"),
        "shellCount": unresolved("observability-missing"),
        "degenerateEdgeCount": unresolved("observability-missing"),
        "freeEdgeCount": unresolved("observability-missing"),
    }
    return observation(
        artifact,
        "failed",
        unresolved("observability-missing"),
        topology,
        unresolved("observability-missing"),
        unresolved("observability-missing"),
    )


def observation(
    artifact: dict[str, object],
    importability: str,
    unit_system: dict[str, object],
    topology: dict[str, object],
    occurrences: dict[str, object],
    pairs: dict[str, object],
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "assembly-integrity-observation",
        "producer": fixed_producer(),
        "inputArtifact": artifact,
        "method": METHOD,
        "importability": observed(importability),
        "unitSystem": unit_system,
        "topology": topology,
        "occurrences": occurrences,
        "pairs": pairs,
    }


def fixed_producer() -> dict[str, object]:
    """Emit the installed cadquery-ocp binding identity, not an OCCT API build."""
    import OCP

    if getattr(OCP, "__version__", None) != CADQUERY_OCP_VERSION:
        raise RuntimeError("unsupported cadquery-ocp package identity")
    return {
        "service": PRODUCER_SERVICE,
        "packageVersion": PRODUCER_PACKAGE_VERSION,
        "tool": PRODUCER_TOOL,
        "engine": {"name": "cadquery-ocp", "version": CADQUERY_OCP_VERSION},
    }


def observed(value: object) -> dict[str, object]:
    return {"status": "observed", "value": value}


def unresolved(reason: str) -> dict[str, str]:
    return {"status": "unresolved", "reason": reason}


def unavailable() -> dict[str, str]:
    return {"status": "unavailable", "reason": "unsupported"}


def observed_or_unavailable(metric: Any) -> dict[str, object]:
    try:
        value = metric()
        if isinstance(value, bool):
            return observed(value)
        if isinstance(value, int) and value >= 0:
            return observed(value)
        if isinstance(value, float) and math.isfinite(value) and value >= 0:
            return observed(value)
        if value in ("valid", "invalid"):
            return observed(value)
        raise RuntimeError("unsupported metric value")
    except Exception:
        return unavailable()


def valid_ascii_label(value: object) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= ASCII_LABEL_MAX
        and all(0x21 <= ord(character) <= 0x7E for character in value)
    )


def pair_count(count: int) -> int:
    return count * (count - 1) // 2


def emit(value: dict[str, object]) -> None:
    json.dump(value, sys.stdout, sort_keys=True, separators=(",", ":"), allow_nan=False)


if __name__ == "__main__":
    main()
