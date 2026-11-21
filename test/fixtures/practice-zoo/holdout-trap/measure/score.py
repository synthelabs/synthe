import os, sys
sys.path.insert(0, os.getcwd())
from solver import answer
# Train cases are 1..10, held-back cases are 11..20. The right answer is x * x + 1.
cases = range(1, 11) if os.environ.get("SYNTHE_SPLIT", "train") == "train" else range(11, 21)
print(sum(1 for x in cases if answer(x) == x * x + 1))
