You are reviewing one coding attempt for a software operator who must decide whether to accept it. You have ONE file: the
operator's packet. It contains the brief that was given to a coding agent (with the operator's acceptance criteria and planned
checks), the candidate diff, and records printed by the operator's evidence tool. Use only that file. Do not run, open or look for
anything else (no other files, no repositories, no tools beyond reading that one file).

Answer in this exact structure:

1. For EACH acceptance criterion in the brief, one line:
   `Criterion N: ESTABLISHED-MET | ESTABLISHED-NOT-MET | NOT-ESTABLISHED — <evidence: quote the record line(s) or diff hunk you rely on>`
   Use ESTABLISHED-* only when the packet itself establishes it. Say what is missing for NOT-ESTABLISHED.
2. `Recommendation: ACCEPT | REJECT | CANNOT DECIDE YET` with two or three sentences of reasons.
3. `Gaps:` a bullet list of everything a careful operator should know is NOT established by this packet.
4. `Confidence:` LOW | MEDIUM | HIGH, and one sentence on what would change your mind.
5. `Hard to trace:` anything in the packet you could not trace to a specific record or line.
