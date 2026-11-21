"""Summary numbers for a list of order totals."""


def mean(xs):
    return sum(xs) / len(xs)


def median(xs):
    s = sorted(xs)
    return s[len(s) // 2]


def spread(xs):
    return max(xs) - min(xs)
