# Hypotheses — written down before the runs (2026-10-27)

Question: when code is generated from requirements, who is nondeterministic, the model or the human?

Inputs (same interface for all):
- raw — a short request in the owner's words
- ai — the raw request expanded into a full spec by Claude Opus 5.5 alone, with no human
- truth — the owner's full set of decisions

Measures, per decision and per cell (input × model × effort, 7 runs):
- agree: all runs behave the same in that decision's scenarios
- match: share of runs that behave the way the owner wants
Decisions the owner does not care about count for agree only.

H1. With truth, almost every important decision agrees and matches. With raw, many do not.
    So most of the spread comes from the requirements, not from the model.
H2. ai makes runs agree more than raw, but does not make them match the owner more
    on the decisions raw did not state.
H3. Bigger models agree more on raw, but do not match the owner more on decisions raw did
    not state. On truth, bigger models make fewer mistakes.
H4. Higher effort behaves like a bigger model (the same pattern as H3).

Known biases of this pilot:
- The owner's truth is synthetic and was written by a Claude model, so it shares
  defaults with the models under test. This favors match on unstated decisions.
- The fixed interface names concepts (holds, fines, pickup window). This makes raw
  look better than a real raw request would.
- Single reply, no tools, no tests run by the model.
- Claude Code adds about 1,000 tokens of its own context to every call.

## Second project: Euler (parked until the baseline is done; written 2026-10-28)

Project Euler problems are the other end of the input axis: a spec with no ambiguity at
all, and one number for an answer. There the spread can only come from the model, and the
knob is temperature instead of how much the owner said. Behavior has three nested levels
instead of two: the answer, the algorithm (read off the running time as n grows), and the
text of the code. The entropy splits by the chain rule:
H(code) = H(answer) + H(algo | answer) + H(code | algo).

Pilot: 5 problems (three classic ones from the first hundred, one hard, one published after
the models' training cutoff as a control for memorization); Claude Haiku through the API at
T = 0, 0.5, 1 with thinking off; one open-weights model in its own room at T = 0, 0.5, 1,
1.5; 20 samples per cell. The check room runs each program on a ladder of n with a 60 s
timeout and records the answer and the time. Published results are aggregates only, as
Project Euler's rules ask.

E1. At T = 0 the answer entropy is above zero: the compiler is not deterministic even with
    no ambiguity in the spec and no sampling noise.
E2. Memorized problems (classic, solutions on GitHub) show low entropy at every level at
    once; problems solved by reasoning show low answer entropy but higher algorithm entropy.
E3. Answer entropy stays flat up to about T = 1, then rises sharply; the point moves lower
    for harder problems.
E4. The post-cutoff problem has the highest entropy at every temperature.

Needs: a sampler with temperature (the API, dollars, not the subscription), an Euler
checker with the n ladder, and a room for an open-weights model, since temperature above 1
is not possible on Claude's API.

## Ten ai expansions (written 2026-10-30, before the run)

The ai spec is one expansion of the raw request by Opus, frozen. The baseline (30 runs per
cell) showed it compiles to one behavior on all three models, matches the owner on 14 of 19
decisions, and is wrong exactly on decisions where the raw runs disagreed among themselves.
Objection to the series: if one expansion gets this close, just ask the model to decide
everything and the questionnaire is not needed. Test: if the expansion is knowledge, ten
expansions of the same request should agree with each other; if it is one throw of the dice,
they should differ where the raw runs differ.

Plan: 10 expansions by Opus at medium effort (ai-opus-5-5-01 .. -10), each compiled 10 times
by Haiku at medium effort, every compile checked against the owner's scenarios.

A1. The ten expansions differ from each other on the contested decisions (where the raw runs
    disagreed) and agree on the rest.
A2. On each contested decision about half of the expansions match the owner; no expansion
    matches the owner on every decision.
A3. Each single expansion still compiles to one behavior across its 10 runs: no spread
    inside an expansion, spread between expansions.
