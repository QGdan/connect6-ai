import json
import pathlib

def test_datasets_exist():
    base = pathlib.Path(__file__).resolve().parent.parent
    tactical = base / "tests" / "datasets" / "tactical_vcdt.json"
    strategic = base / "tests" / "datasets" / "strategic_midgame.json"
    stress = base / "tests" / "datasets" / "stress_cases.json"
    for f in (tactical, strategic, stress):
        assert f.exists(), f"{f} missing"
        data = json.loads(f.read_text())
        assert isinstance(data, list)
        assert len(data) > 0
