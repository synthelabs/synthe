# Clean rows: rows of data/prices.csv whose price matches the reference price list. Exact, no noise.
import csv, os
here = os.path.dirname(os.path.abspath(__file__))
def rows(name):
    with open(os.path.join(here, "..", "data", name), newline="") as f:
        return list(csv.DictReader(f))
ref = {r["id"]: r["price"] for r in rows("reference.csv")}
print("clean rows:", sum(1 for r in rows("prices.csv") if ref.get(r["id"]) == r["price"]))
