/-
  The guarantees Synthe's comments promise, proved about the model in Model.lean.
  The differential test (test/lean-spec.test.ts) is what ties the TypeScript to this model.
-/
import SyntheSpec.Model

namespace Synthe

/-! ## The sign test is a probability -/

/-- The compiled `choose` agrees with the proved one on every n, k ≤ 12, checked by the kernel. -/
theorem chooseFast_agrees : ∀ n < 13, ∀ k < 13, chooseFast n k = choose n k := by decide

theorem choose_zero_succ (k : Nat) : choose 0 (k + 1) = 0 := rfl

theorem choose_eq_zero_of_lt : ∀ n k, n < k → choose n k = 0
  | 0, 0, h => absurd h (Nat.lt_irrefl 0)
  | 0, _ + 1, _ => rfl
  | _ + 1, 0, h => absurd h (Nat.not_lt_zero _)
  | n + 1, k + 1, h => by
    simp only [choose]
    rw [choose_eq_zero_of_lt n k (by omega), choose_eq_zero_of_lt n (k + 1) (by omega)]

/-- Pascal's rule lifted to partial sums. -/
theorem tail_succ_succ (n : Nat) : ∀ l, tail (n + 1) (l + 1) = tail n (l + 1) + tail n l
  | 0 => by simp [tail, choose]; omega
  | l + 1 => by
    have ih := tail_succ_succ n l
    have h1 : tail (n + 1) (l + 1 + 1) = tail (n + 1) (l + 1) + choose (n + 1) (l + 1 + 1) := rfl
    have h2 : choose (n + 1) (l + 1 + 1) = choose n (l + 1) + choose n (l + 1 + 1) := rfl
    have h3 : tail n (l + 1 + 1) = tail n (l + 1) + choose n (l + 1 + 1) := rfl
    have h4 : tail n (l + 1) = tail n l + choose n (l + 1) := rfl
    omega

theorem tail_past_n (n : Nat) : ∀ k, n ≤ k → tail n k = tail n n := by
  intro k hk
  induction k with
  | zero => have : n = 0 := by omega
            subst this; rfl
  | succ k ih =>
    by_cases h : n ≤ k
    · simp only [tail]; rw [ih h, choose_eq_zero_of_lt n (k + 1) (by omega)]; rfl
    · have : n = k + 1 := by omega
      subst this; rfl

/-- All splits together: Σ_{i=0}^{n} C(n, i) = 2^n. -/
theorem tail_full : ∀ n, tail n n = 2 ^ n
  | 0 => rfl
  | n + 1 => by
    rw [tail_succ_succ, tail_past_n n (n + 1) (by omega), tail_full n, Nat.pow_succ]
    omega

theorem tail_mono (n : Nat) : ∀ l, tail n l ≤ tail n (l + 1) := by
  intro l; simp only [tail]; omega

theorem tail_le_of_le (n l : Nat) : ∀ k, l ≤ k → tail n l ≤ tail n k
  | 0, h => by rw [Nat.le_zero.mp h]; exact Nat.le_refl _
  | k + 1, h => by
    by_cases hk : l ≤ k
    · exact Nat.le_trans (tail_le_of_le n l k hk) (tail_mono n k)
    · rw [show l = k + 1 by omega]; exact Nat.le_refl _

theorem tail_le_full (n : Nat) : ∀ l, l ≤ n → tail n l ≤ 2 ^ n := by
  intro l hl
  rw [← tail_full n]
  exact tail_le_of_le n l n hl

theorem signP_le_one (w l : Nat) : signP w l ≤ 1 := by
  unfold signP
  dsimp only
  split
  · exact Rat.le_refl
  · split
    · exact Rat.le_refl
    · exact Rat.not_lt.mp ‹_›

/-- Before the cap at 1, the raw ratio is already at most 1: the cap never hides a counting bug. -/
theorem signP_ratio_le_one (w l : Nat) : tail (w + l) l ≤ 2 ^ (w + l) :=
  tail_le_full (w + l) l (by omega)

/-- More losses can only make a split look more like luck. -/
theorem tail_more_losses (n l : Nat) : tail n l ≤ tail n (l + 1) := tail_mono n l

/-! ## An unknown is never a number -/

theorem allKnown_none_of_unknown : ∀ rows : List Row, (∃ r ∈ rows, r.score = none) → allKnown rows = none
  | [], ⟨_, h, _⟩ => absurd h (List.not_mem_nil)
  | r :: rs, ⟨x, hx, hs⟩ => by
    simp only [allKnown]
    rcases List.mem_cons.mp hx with rfl | hrs
    · simp [hs]
    · rw [allKnown_none_of_unknown rs ⟨x, hrs, hs⟩]; split <;> simp_all

theorem mean_none_of_unknown (rows : List Row) (h : ∃ r ∈ rows, r.score = none) : mean rows = none := by
  unfold mean
  split
  · rfl
  · rw [allKnown_none_of_unknown rows h]

theorem paired_none_of_length (after before : List Row) (h : after.length ≠ before.length) :
    paired after before = none := by
  unfold paired
  have : (after.length != before.length) = true := by simp [h]
  simp [this]

theorem pairStep_none (before : List Row) : ∀ rows : List Row, rows.foldl (pairStep before) none = none
  | [] => rfl
  | _ :: rs => by simp only [List.foldl, pairStep]; exact pairStep_none before rs

/-- One scenario that can't be scored poisons the whole comparison: an unknown never counts as a win. -/
theorem paired_none_of_unknown_after : ∀ (rows before : List Row) (acc : Option Split),
    (∃ r ∈ rows, r.score = none) → rows.foldl (pairStep before) acc = none
  | [], _, _, ⟨_, h, _⟩ => absurd h List.not_mem_nil
  | r :: rs, before, acc, ⟨x, hx, hs⟩ => by
    simp only [List.foldl]
    rcases List.mem_cons.mp hx with rfl | hrs
    · have : pairStep before acc x = none := by
        unfold pairStep; cases acc <;> simp [hs] <;> split <;> rfl
      rw [this]; exact pairStep_none before rs
    · exact paired_none_of_unknown_after rs before _ ⟨x, hrs, hs⟩

/-! ## A merge is never less safe than what it replaces -/

theorem addedBreaks_zero {rows current : List Row} (h : addedBreaks rows current = 0) :
    ∀ r ∈ rows, addsBreak current r = false := by
  intro r hr
  unfold addedBreaks at h
  cases hb : addsBreak current r with
  | false => rfl
  | true =>
    have hm : r ∈ rows.filter (addsBreak current) := List.mem_filter.mpr ⟨hr, hb⟩
    rw [List.length_eq_zero_iff.mp h] at hm
    simp at hm

/-- A row that adds no break was checked, and breaks a guardrail only where the current prompt already did. -/
theorem no_new_break {current : List Row} {r : Row} (h : addsBreak current r = false) :
    r.violation ≠ none ∧ (r.violation = some true → (lookup current r.id).bind (·.violation) = some true) := by
  unfold addsBreak at h
  split at h
  · simp at h
  · rename_i hv; simp_all
  · rename_i hv; simp [hv]

theorem pickBest_mem : ∀ (cs : List Candidate) (b : Option Candidate) (c : Candidate),
    pickBest cs b = some c → c ∈ cs ∨ b = some c
  | [], _, _, h => Or.inr h
  | x :: xs, none, c, h => by
    rcases pickBest_mem xs (some x) c h with hm | he
    · exact Or.inl (List.mem_cons_of_mem _ hm)
    · cases he; exact Or.inl List.mem_cons_self
  | x :: xs, some b, c, h => by
    simp only [pickBest] at h
    rcases pickBest_mem xs _ c h with hm | he
    · exact Or.inl (List.mem_cons_of_mem _ hm)
    · split at he
      · cases he; exact Or.inl List.mem_cons_self
      · exact Or.inr he

/-- Merge soundness: whatever judgeRound merges is one of the round's candidates and passed every gate. -/
theorem merge_sound (mr : MergeRule) (rd : Round) (rep : Option (List Row)) (id : String)
    (h : judgeRound mr rd rep = .merge id) :
    ∃ c ∈ rd.candidates, c.id = id ∧ eligible mr rd c = true := by
  unfold judgeRound at h
  split at h; · cases h
  split at h; · cases h
  split at h
  · rename_i c hc
    cases h
    rcases pickBest_mem _ none c hc with hm | he
    · have := List.mem_filter.mp hm; exact ⟨c, this.1, rfl, this.2⟩
    · cases he
  · cases h

/-- What eligibility guarantees, unpacked: held-back rows exist, no added breaks, attacks pass. -/
theorem eligible_spec {mr : MergeRule} {rd : Round} {c : Candidate} (he : eligible mr rd c = true) :
    ∃ hold, c.holdout = some hold ∧ addedBreaks c.train rd.baselineTrain = 0 ∧
      addedBreaks hold rd.baselineHoldout = 0 ∧ attacksOk rd c = true := by
  unfold eligible at he
  cases hh : c.holdout with
  | none => simp [hh] at he
  | some hold =>
    cases hb : mean rd.baselineHoldout with
    | none => simp [hh, hb] at he
    | some bh =>
      cases hm : mean hold with
      | none => simp [hh, hb, hm] at he
      | some held =>
        cases hp : paired hold rd.baselineHoldout with
        | none => simp [hh, hb, hm, hp] at he
        | some sp =>
          simp only [hh, hb, hm, hp, Bool.and_eq_true, beq_iff_eq] at he
          exact ⟨hold, rfl, by omega, by omega, he.2.2⟩

/-- The headline safety property. A merged candidate's rows, learned-from and held-back, were all
    checked, and every guardrail break is one the current prompt already had on that same test case. -/
theorem merge_never_adds_break (mr : MergeRule) (rd : Round) (rep : Option (List Row)) (id : String)
    (h : judgeRound mr rd rep = .merge id) :
    ∃ c ∈ rd.candidates, c.id = id ∧ ∃ hold, c.holdout = some hold ∧
      (∀ r ∈ c.train, addsBreak rd.baselineTrain r = false) ∧
      (∀ r ∈ hold, addsBreak rd.baselineHoldout r = false) := by
  obtain ⟨c, hc, hid, he⟩ := merge_sound mr rd rep id h
  obtain ⟨hold, hh, ht, hb, _⟩ := eligible_spec he
  exact ⟨c, hc, hid, hold, hh, addedBreaks_zero ht, addedBreaks_zero hb⟩

/-- An attack result that couldn't be measured blocks the merge, whatever else the round shows. -/
theorem unknown_attack_blocks (mr : MergeRule) (rd : Round) (rep : Option (List Row))
    (h : rd.attacks = some ⟨none⟩) : ∀ id, judgeRound mr rd rep ≠ .merge id := by
  intro id hm
  obtain ⟨c, _, _, he⟩ := merge_sound mr rd rep id hm
  obtain ⟨_, _, _, _, ha⟩ := eligible_spec he
  simp [attacksOk, h] at ha

/-- With no candidates there is nothing to merge. -/
theorem no_candidates_no_merge (mr : MergeRule) (rd : Round) (rep : Option (List Row))
    (h : rd.candidates = []) : ∀ id, judgeRound mr rd rep ≠ .merge id := by
  intro id hm
  obtain ⟨c, hc, _⟩ := merge_sound mr rd rep id hm
  simp [h] at hc

/-! ## Improve mode keeps only real wins -/

theorem improve_win_sound (d : Direction) (b c : Measurement) (g : Option Bool)
    (h : improveWin d b c g = true) :
    g ≠ some false ∧
    (if d = .higher then c.median - b.median else -(c.median - b.median)) > 0 ∧
    ratAbs (c.median - b.median) > max (range b.runs) (range c.runs) := by
  unfold improveWin at h
  simp only [Bool.and_eq_true, decide_eq_true_eq, bne_iff_ne, ne_eq] at h
  exact ⟨h.1.1, h.1.2, h.2⟩

theorem improve_failed_guard_never_wins (d : Direction) (b c : Measurement) :
    improveWin d b c (some false) = false := by
  simp [improveWin]

/-! ## The team's checks outrank the judge -/

/-- When the two replies fail a different number of checks, the judge's opinion is irrelevant. -/
theorem checks_outrank_judge (j₁ j₂ : Option Rat) (m t : Nat) (h : m ≠ t) :
    decideByChecks j₁ (some m) (some t) = decideByChecks j₂ (some m) (some t) := by
  simp [decideByChecks, h]

end Synthe
