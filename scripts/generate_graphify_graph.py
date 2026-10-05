#!/usr/bin/env python3
"""Generate the committed Graphify code graph without semantic LLM extraction."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from graphify.analyze import god_nodes, suggest_questions, surprising_connections
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.detect import detect
from graphify.export import to_json
from graphify.extract import collect_files, extract
from graphify.report import generate


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "graphify-out"


def clean_generated_files() -> None:
    """Remove generated Graphify outputs that should be replaced on each run."""
    OUT_DIR.mkdir(exist_ok=True)
    for name in ("graph.json", "GRAPH_REPORT.md", "manifest.json", "cost.json"):
        (OUT_DIR / name).unlink(missing_ok=True)

    # Keep release commits focused on the queryable graph, not local caches or
    # optional visual exports from ad-hoc Graphify runs.
    for name in ("obsidian", "wiki", "memory"):
        shutil.rmtree(OUT_DIR / name, ignore_errors=True)
    for pattern in ("*.html", "*.svg", "*.graphml"):
        for path in OUT_DIR.glob(pattern):
            path.unlink()


def code_files_from_detection(detection: dict) -> list[Path]:
    """Return the supported code files discovered by Graphify detection."""
    files: list[Path] = []
    for detected_path in detection.get("files", {}).get("code", []):
        path = Path(detected_path)
        if path.is_dir():
            files.extend(collect_files(path))
        else:
            files.append(path)

    return sorted({path.resolve() for path in files})


def main() -> None:
    """Build and write the committed deterministic Graphify code graph."""
    clean_generated_files()

    detection = detect(ROOT)
    code_files = code_files_from_detection(detection)
    if not code_files:
        raise RuntimeError("Graphify did not find supported code files")

    extraction = extract(code_files, cache_root=ROOT)
    extraction.setdefault("nodes", [])
    extraction.setdefault("edges", [])
    extraction.setdefault("hyperedges", [])
    extraction["input_tokens"] = extraction.get("input_tokens", 0)
    extraction["output_tokens"] = extraction.get("output_tokens", 0)

    graph = build_from_json(extraction, root=ROOT)
    communities = cluster(graph) if graph.number_of_nodes() else {}
    cohesion_scores = score_all(graph, communities) if communities else {}
    community_labels = {community_id: f"Community {community_id}" for community_id in communities}

    token_cost = {
        "input_tokens": extraction["input_tokens"],
        "output_tokens": extraction["output_tokens"],
        "estimated_cost_usd": 0,
    }
    (OUT_DIR / "cost.json").write_text(json.dumps(token_cost, indent=2), encoding="utf-8")

    report = generate(
        graph,
        communities,
        cohesion_scores,
        community_labels,
        god_nodes(graph),
        surprising_connections(graph, communities),
        detection,
        token_cost,
        ROOT.name,
        suggested_questions=suggest_questions(graph, communities, community_labels) if communities else [],
    )
    report = report.replace(
        "## Corpus Check",
        "## Generation Mode\n"
        "- Deterministic code-only AST extraction. No semantic LLM extraction or API keys are used.\n\n"
        "## Corpus Check",
        1,
    )
    (OUT_DIR / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    to_json(graph, communities, str(OUT_DIR / "graph.json"), force=True)

    graph_path = OUT_DIR / "graph.json"
    graph_data = json.loads(graph_path.read_text(encoding="utf-8"))
    graph_data.pop("built_at_commit", None)
    graph_path.write_text(json.dumps(graph_data, indent=2, ensure_ascii=False), encoding="utf-8")

    print(
        f"Graphify code graph generated: {graph.number_of_nodes()} nodes, "
        f"{graph.number_of_edges()} edges, {len(code_files)} files"
    )


if __name__ == "__main__":
    main()
