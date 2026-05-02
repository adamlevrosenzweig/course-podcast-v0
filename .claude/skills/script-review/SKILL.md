---
name: script-review
description: Review a generated Overhang draft against the voice guide. Flags flat Adam voice, over-analytical Megan lines, missing landing line, unresolved [NOTE] annotations, and missing academic grounding. Run after /generate before approving a draft.
---

Review a draft episode of The Overhang against the voice guide.

**Auth:** !`security find-generic-password -a "podcast-admin" -s "course-podcast-v0" -w`
**Draft episodes:** !`curl -s "https://course-podcast-v0-production.up.railway.app/api/episodes" -H "x-api-key: $(security find-generic-password -a 'podcast-admin' -s 'course-podcast-v0' -w)" | python3 -c "import sys,json; eps=json.load(sys.stdin); [print(f'ID {e[\"id\"]:>3} | {e.get(\"title\",\"Untitled\")[:70]}') for e in eps if e['status']=='draft']"`

**Arguments:** $ARGUMENTS
(Optional: episode ID. If blank, review the most recent draft.)

Fetch the target episode, then review its script against every item below. Report each as ✓ pass or ✗ fail with a one-line note. For every ✗, quote the specific line(s) that caused the flag.

---

**ADAM — voice checklist**
- Does Adam take explicit positions? (Flag any stretch where he narrates findings without stating a view)
- Does Adam's analysis default to structural/incentive explanations rather than moralizing about intent?
- Are Adam's lines free of formal written-prose transitions? ("Furthermore," "Additionally," "It's worth noting")
- Does Adam use specific names throughout? (researchers, papers, companies — not "studies show" or "experts say")
- Does Adam make at least one argument that assumes a US frame — and does Megan call it out?

**MEGAN — voice checklist**
- Does Megan hold her own positions and press when Adam only half-addresses her point? (Flag if she consistently defers or drops arguments)
- Does Megan deploy a non-US frame at least once — not as a rhetorical move but as her natural perspective?
- Does Megan's pro-tech bias surface and get named (with humor) at least once, OR is the topic one where it wouldn't naturally arise?
- Is Megan's penultimate line (just before the outro) a landing line that captures the episode's main point?

**DYNAMIC checklist**
- Does the conversation avoid the dead template: Adam claims → Megan steelmans → Adam graciously accepts → move on?
- Is there at least one moment of genuine friction where they dig in rather than resolving cleanly?
- Does Megan's information advantage show (specific papers, stats, non-US precedents)?

**STRUCTURE checklist**
- Does the script contain any unresolved [NOTE] annotations?
- Does every non-blank line begin with ADAM: or MEGAN:?
- Is the opening frame clear within the first 4 exchanges? (What are we discussing?)
- Is there academic or historical grounding for any claim that warrants it? (Named researcher, foundational text, or historical precedent — not just recent news)

---

Finish with one of:
- **"Ready for audio."** (all items pass)
- **"X issues to fix before audio."** (numbered list of specific fixes, quoted from the script)
