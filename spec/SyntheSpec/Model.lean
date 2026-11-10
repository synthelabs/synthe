/-
  Synthe's decision core, modeled in Lean over exact rationals.

  Mirrors src/core/merge-rule.ts (signP, mean, paired, addedBreaks, guardRate, trainingProblem,
  judgeRound) and src/improve/verdict.ts (median, range, verdict). Each definition says which TS
  function it models. The theorems live in Proofs.lean; Main.lean runs these same definitions so a
  differential test can hold the TypeScript to them.
-/
namespace Synthe

/-! ## Rows and the goal's merge rule -/

structure Row where
  id : String
  score : Option Rat            -- null in TS = none: could not be measured
  violation : Option Bool       -- null in TS = none: could not be checked
  guardApplicable : Option Int := none
  guardFailed : Option Int := none
deriving Repr, Inhabited

structure MergeRule where
  minImprovement : Rat
  maxP : Rat
  holdoutMaxP : Rat             -- merge_rule.holdout_max_p: the sign-test limit on the held-back split
  noiseMargin : Rat
  guardMargin : Rat
  hasCounterChecks : Bool       -- goal.counter_checks?.length > 0
deriving Repr

/-- `attackFailed` in TS is missing, null or an array; missing and null behave the same. -/
structure Candidate where
  id : String
  train : List Row
  holdout : Option (List Row)
  attackFailed : Option (List String)
deriving Repr, Inhabited

structure Attacks where
  baselineFailed : Option (List String)
deriving Repr

structure Round where
  baselineTrain : List Row
  baselineHoldout : List Row
  candidates : List Candidate
  attacks : Option Attacks
deriving Repr

inductive Action where
  | merge (id : String)
  | revert
  | skip
deriving Repr, DecidableEq

/-! ## Exact sign test (TS: signP) -/

/-- Binomial coefficients, multiplicatively: C(n, k) = Π_{i<k} (n - i) / (i + 1). Each partial
    product is itself a binomial coefficient, so every division is exact. Used only when running. -/
def chooseFast (n : Nat) : Nat → Nat
  | 0 => 1
  | k + 1 => chooseFast n k * (n - k) / (k + 1)

/-- Binomial coefficients by Pascal's rule: the definition the proofs use. It takes exponential
    time, so compiled code runs `chooseFast` instead; Proofs.lean checks the two agree. -/
@[implemented_by chooseFast]
def choose : Nat → Nat → Nat
  | _, 0 => 1
  | 0, _ + 1 => 0
  | n + 1, k + 1 => choose n k + choose n (k + 1)

/-- `tail n l` = Σ_{i=0}^{l} C(n, i): the number of splits with at most `l` losses. -/
def tail (n : Nat) : Nat → Nat
  | 0 => choose n 0
  | l + 1 => tail n l + choose n (l + 1)

/-- One-sided exact sign test: P(losses ≤ l | n = w + l, fair coin), capped at 1. -/
def signP (wins losses : Nat) : Rat :=
  let n := wins + losses
  if n = 0 then 1 else
  let r : Rat := (tail n losses : Rat) / (2 ^ n : Nat)
  if r > 1 then 1 else r

/-! ## Means and pairing (TS: mean, paired) -/

def allKnown : List Row → Option (List Rat)
  | [] => some []
  | r :: rs => match r.score, allKnown rs with
    | some s, some ss => some (s :: ss)
    | _, _ => none

/-- An unknown is never zero: one unmeasured row makes the whole mean unknown. -/
def mean (rows : List Row) : Option Rat :=
  if rows.isEmpty then none else
  match allKnown rows with
  | some ss => some (ss.foldl (· + ·) 0 / rows.length)
  | none => none

/-- TS builds `new Map(rows.map(r => [r.id, …]))`, so a repeated id keeps its LAST row. -/
def lookup (rows : List Row) (id : String) : Option Row :=
  rows.reverse.find? (·.id == id)

def idsUnique (rows : List Row) : Bool :=
  (rows.map (·.id)).eraseDups.length == rows.length

structure Split where
  wins : Nat
  losses : Nat
deriving Repr, DecidableEq

def pairStep (before : List Row) (acc : Option Split) (r : Row) : Option Split := do
  let s ← acc
  let o ← lookup before r.id
  let a ← r.score
  let b ← o.score
  if a > b then pure { s with wins := s.wins + 1 }
  else if a < b then pure { s with losses := s.losses + 1 }
  else pure s

/-- Scenario-by-scenario comparison. None if any scenario can't be paired. -/
def paired (after before : List Row) : Option Split :=
  if after.isEmpty || after.length != before.length || !idsUnique after then none
  else after.foldl (pairStep before) (some ⟨0, 0⟩)

/-! ## Guardrail breaks and guards (TS: addedBreaks, guardRate) -/

/-- A row adds a break when it couldn't be checked, or breaks where the current prompt doesn't. -/
def addsBreak (current : List Row) (r : Row) : Bool :=
  match r.violation with
  | none => true
  | some true => (lookup current r.id).bind (·.violation) != some true
  | some false => false

def addedBreaks (rows current : List Row) : Nat :=
  (rows.filter (addsBreak current)).length

/-- Unrounded guard pass rate, in points out of 100. -/
def guardRate (rows : List Row) : Option Rat := do
  if rows.isEmpty || !idsUnique rows then none
  let pairs ← rows.mapM fun r => do
    let a ← r.guardApplicable
    let f ← r.guardFailed
    if a < 0 || f < 0 || f > a then none else pure (a, f)
  let A := (pairs.map (·.1)).foldl (· + ·) 0
  let F := (pairs.map (·.2)).foldl (· + ·) 0
  if A = 0 then none else pure (100 * ((A - F : Int) : Rat) / (A : Rat))

/-! ## The merge rule (TS: trainingProblem, judgeRound) -/

/-- TS trainingProblem returns null. -/
def trainingOk (mr : MergeRule) (c : Candidate) (baseTrain : List Row) : Bool :=
  match mean baseTrain, mean c.train, paired c.train baseTrain with
  | some b, some a, some s => decide (a ≥ b + mr.minImprovement) && decide (signP s.wins s.losses ≤ mr.maxP)
  | _, _, _ => false

def heldIds (holdout : List Row) (r : Row) : Bool := holdout.any (·.id == r.id)

def guardsOk (mr : MergeRule) (rd : Round) (c : Candidate) (h : List Row) : Bool :=
  if !mr.hasCounterChecks then true else
  let currentHeld := rd.baselineHoldout.filter (heldIds h)
  match guardRate (rd.baselineTrain ++ currentHeld), guardRate (c.train ++ h) with
  | some gb, some ga => decide (gb - ga ≤ mr.guardMargin)
  | _, _ => false

def attacksOk (rd : Round) (c : Candidate) : Bool :=
  match rd.attacks with
  | none => true
  | some at_ => match at_.baselineFailed, c.attackFailed with
    | some base, some mine => mine.all (base.contains ·)
    | _, _ => false

/-- Every gate a candidate must pass before it can merge, in the order judgeRound checks them. -/
def eligible (mr : MergeRule) (rd : Round) (c : Candidate) : Bool :=
  trainingOk mr c rd.baselineTrain &&
  match c.holdout, mean rd.baselineHoldout with
  | some h, some bh =>
    match mean h, paired h rd.baselineHoldout with
    | some held, some hs =>
      decide (held ≥ bh + mr.minImprovement) &&
      decide (signP hs.wins hs.losses ≤ mr.holdoutMaxP) &&
      addedBreaks c.train rd.baselineTrain + addedBreaks h rd.baselineHoldout == 0 &&
      guardsOk mr rd c h &&
      attacksOk rd c
    | _, _ => false
  | _, _ => false

def trainMean (c : Candidate) : Rat := (mean c.train).getD 0

/-- Among eligible candidates, the first with the strictly highest training mean (TS: `after > best.after`). -/
def pickBest : List Candidate → Option Candidate → Option Candidate
  | [], best => best
  | c :: cs, none => pickBest cs (some c)
  | c :: cs, some b => pickBest cs (if trainMean c > trainMean b then some c else some b)

def shouldRevert (mr : MergeRule) (rd : Round) (replaced : Option (List Row)) : Bool :=
  match replaced with
  | none => false
  | some rep =>
    let now := rd.baselineTrain ++ rd.baselineHoldout
    match mean rep, mean now, paired rep now with
    | some was, some is_, some w => decide (is_ < was - mr.noiseMargin) && decide (signP w.wins w.losses ≤ mr.maxP)
    | _, _, _ => false

def judgeRound (mr : MergeRule) (rd : Round) (replaced : Option (List Row)) : Action :=
  if (mean rd.baselineTrain).isNone || (mean rd.baselineHoldout).isNone then .skip
  else if shouldRevert mr rd replaced then .revert
  else match pickBest (rd.candidates.filter (eligible mr rd)) none with
    | some c => .merge c.id
    | none => .skip

/-! ## Improve mode (TS: src/improve/verdict.ts) -/

def insert (x : Rat) : List Rat → List Rat
  | [] => [x]
  | y :: ys => if x ≤ y then x :: y :: ys else y :: insert x ys

def sort : List Rat → List Rat
  | [] => []
  | x :: xs => insert x (sort xs)

def median (xs : List Rat) : Rat :=
  let s := sort xs
  let mid := s.length / 2
  if s.length % 2 = 1 then s.getD mid 0 else (s.getD (mid - 1) 0 + s.getD mid 0) / 2

def range (xs : List Rat) : Rat :=
  match xs.max?, xs.min? with
  | some hi, some lo => hi - lo
  | _, _ => 0

inductive Direction where
  | higher
  | lower
deriving Repr, DecidableEq

structure Measurement where
  median : Rat
  runs : List Rat
deriving Repr

def ratAbs (x : Rat) : Rat := if x < 0 then -x else x

/-- A change wins only when it moves the median the right way by more than the runs vary,
    and the regression check (when there is one) did not fail. -/
def improveWin (d : Direction) (b c : Measurement) (guard : Option Bool) : Bool :=
  let delta := c.median - b.median
  let noise := max (range b.runs) (range c.runs)
  let better := if d = .higher then delta else -delta
  guard != some false && decide (better > 0) && decide (ratAbs delta > noise)

/-! ## Checks outrank the judge (TS: decideByChecks in src/loop/score.ts) -/

/-- The challenger's score on one test case. `mine`/`theirs` are failed-check counts. -/
def decideByChecks (judgeScore : Option Rat) (mine theirs : Option Nat) : Option Rat :=
  match mine, theirs with
  | some m, some t => if m ≠ t then some (if m < t then 100 else 0) else judgeScore
  | _, _ => judgeScore

end Synthe
