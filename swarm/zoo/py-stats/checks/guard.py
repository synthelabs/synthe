"""Guard: the functions still answer plain lists, and still refuse lists that are not numbers."""
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import stats  # noqa: E402

assert stats.mean([2, 4]) == 3
assert stats.median([5, 1, 3]) == 3
assert stats.spread([2, 9, 4]) == 7
try:
    stats.mean(["a", "b"])
except TypeError:
    pass
else:
    raise AssertionError("mean of text must raise TypeError")
print("stats guard passed")
