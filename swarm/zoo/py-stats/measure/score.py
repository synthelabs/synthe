"""Counts the cases that stats.py answers right. Higher is better."""
import json
import os
import sys

sys.dont_write_bytecode = True
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, root)
import stats  # noqa: E402

with open(os.path.join(root, "measure", "cases.json")) as f:
    cases = json.load(f)
passed = 0
for case in cases:
    try:
        got = getattr(stats, case["fn"])(list(case["args"]))
        if abs(got - case["want"]) < 1e-9:
            passed += 1
    except Exception:
        pass
print("cases passed:", passed)
