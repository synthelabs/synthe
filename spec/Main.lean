/-
  Runs the proved model on one JSON request per line of stdin and writes one JSON answer per line.
  JSON numbers are read exactly (0.1 is 1/10, not the nearest float), and rationals come back as
  {"n": "<numerator>", "d": "<denominator>"} strings, so the TypeScript side sees the exact answer.
-/
import Lean.Data.Json
import SyntheSpec.Model

open Lean Synthe

def ratOf (n : JsonNumber) : Rat := (n.mantissa : Rat) / ((10 ^ n.exponent : Nat) : Rat)

def ratJson (q : Rat) : Json := Json.mkObj [("n", toString q.num), ("d", toString q.den)]

def optJson {α} (f : α → Json) : Option α → Json
  | some a => f a
  | none => Json.null

def getRat (j : Json) (k : String) : Except String Rat := do
  match ← j.getObjVal? k with
  | .num n => pure (ratOf n)
  | _ => throw s!"{k}: not a number"

/-- A missing key and null are the same, as `x === null || x === undefined` would treat them. -/
def getOpt {α} (j : Json) (k : String) (f : Json → Except String α) : Except String (Option α) :=
  match j.getObjVal? k with
  | .ok .null | .error _ => pure none
  | .ok v => some <$> f v

def asRat : Json → Except String Rat
  | .num n => pure (ratOf n)
  | _ => throw "not a number"

def asInt : Json → Except String Int
  | .num n => if n.exponent = 0 then pure n.mantissa else throw "not an integer"
  | _ => throw "not an integer"

def asBool : Json → Except String Bool
  | .bool b => pure b
  | _ => throw "not a boolean"

def asStrs (j : Json) : Except String (List String) := do
  (← j.getArr?).toList.mapM (·.getStr?)

def rowOf (j : Json) : Except String Row := do
  pure {
    id := ← (← j.getObjVal? "id").getStr?
    score := ← getOpt j "score" asRat
    violation := ← getOpt j "violation" asBool
    guardApplicable := ← getOpt j "guardApplicable" asInt
    guardFailed := ← getOpt j "guardFailed" asInt }

def rowsOf (j : Json) : Except String (List Row) := do (← j.getArr?).toList.mapM rowOf

def rowsAt (j : Json) (k : String) : Except String (List Row) := do rowsOf (← j.getObjVal? k)

def candOf (j : Json) : Except String Candidate := do
  pure {
    id := ← (← j.getObjVal? "id").getStr?
    train := ← rowsAt j "train"
    holdout := ← getOpt j "holdout" rowsOf
    attackFailed := ← getOpt j "attackFailed" asStrs }

def ruleOf (j : Json) : Except String MergeRule := do
  pure {
    minImprovement := ← getRat j "min_improvement"
    maxP := ← getRat j "max_p"
    holdoutMaxP := ← getRat j "holdout_max_p"
    noiseMargin := ← getRat j "noise_margin"
    guardMargin := ← getRat j "guard_margin"
    hasCounterChecks := ← (← j.getObjVal? "counterChecks").getBool? }

def roundOf (j : Json) : Except String Round := do
  pure {
    baselineTrain := ← rowsAt j "baselineTrain"
    baselineHoldout := ← rowsAt j "baselineHoldout"
    candidates := ← (← (← j.getObjVal? "candidates").getArr?).toList.mapM candOf
    attacks := ← getOpt j "attacks" fun a => do pure { baselineFailed := ← getOpt a "baselineFailed" asStrs } }

def measOf (j : Json) : Except String Measurement := do
  pure { median := ← getRat j "median", runs := ← (← (← j.getObjVal? "runs").getArr?).toList.mapM asRat }

def answer (j : Json) : Except String Json := do
  match ← (← j.getObjVal? "fn").getStr? with
  | "signP" =>
    let w ← (← j.getObjVal? "wins").getNat?
    let l ← (← j.getObjVal? "losses").getNat?
    pure (ratJson (signP w l))
  | "mean" => pure (optJson ratJson (mean (← rowsAt j "rows")))
  | "paired" =>
    pure (optJson (fun s => Json.mkObj [("wins", s.wins), ("losses", s.losses)]) (paired (← rowsAt j "after") (← rowsAt j "before")))
  | "addedBreaks" => pure (toJson (addedBreaks (← rowsAt j "rows") (← rowsAt j "current")))
  | "guardRate" => pure (optJson ratJson (guardRate (← rowsAt j "rows")))
  | "trainingOk" =>
    pure (toJson (trainingOk (← ruleOf (← j.getObjVal? "rule")) (← candOf (← j.getObjVal? "candidate")) (← rowsAt j "baselineTrain")))
  | "judgeRound" =>
    let a := judgeRound (← ruleOf (← j.getObjVal? "rule")) (← roundOf (← j.getObjVal? "round")) (← getOpt j "replaced" rowsOf)
    pure <| match a with
      | .merge id => Json.str s!"merge:{id}"
      | .revert => Json.str "revert"
      | .skip => Json.str "skip"
  | "median" => pure (ratJson (median (← (← (← j.getObjVal? "xs").getArr?).toList.mapM asRat)))
  | "range" => pure (ratJson (range (← (← (← j.getObjVal? "xs").getArr?).toList.mapM asRat)))
  | "improveWin" =>
    let d := if (← (← j.getObjVal? "direction").getStr?) = "higher" then Direction.higher else Direction.lower
    pure (toJson (improveWin d (← measOf (← j.getObjVal? "baseline")) (← measOf (← j.getObjVal? "candidate")) (← getOpt j "guard" asBool)))
  | f => throw s!"unknown fn {f}"

partial def loop (stdin : IO.FS.Stream) (stdout : IO.FS.Stream) : IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return
  let out := match Json.parse line >>= answer with
    | .ok v => Json.mkObj [("ok", v)]
    | .error e => Json.mkObj [("error", e)]
  stdout.putStrLn out.compress
  stdout.flush
  loop stdin stdout

def main : IO Unit := do loop (← IO.getStdin) (← IO.getStdout)
