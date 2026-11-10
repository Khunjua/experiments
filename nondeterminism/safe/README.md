# The owner's side

What the library's owner actually wants, kept away from the models during the runs. The coder
room never mounts this folder; the check room gets `projects/library/` read-only.

    projects/library/truth.md        the 20 decisions, D1 to D20, each marked important or
                                     indifferent, and stated, vague or absent in the short request
    projects/library/labels.json     the same decisions grouped by how the request covers them,
                                     with the short names used in the charts
    projects/library/scenarios.mjs   31 scenarios, each tied to a decision, with the result the
                                     owner expects
    projects/library/reference.mjs   the owner's rules in code; passes every scenario
    projects/library/specs/truth.md  the full decisions written as requirements: the text the
                                     models got in the `truth` cells

Public since the write-up of 3 November 2026. From now on the models may have seen it, so new
claims will use new hidden projects.
