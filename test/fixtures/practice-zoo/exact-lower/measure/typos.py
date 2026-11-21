# Typos in guide.md: words found in the list of known misspellings. Lower is better. Exact, no noise.
import os, re
here = os.path.dirname(os.path.abspath(__file__))
BAD = {"downlaod", "configuraton", "adress", "teh", "recieve"}
text = open(os.path.join(here, "..", "guide.md")).read().lower()
print("typos:", sum(1 for w in re.findall(r"[a-z]+", text) if w in BAD))
