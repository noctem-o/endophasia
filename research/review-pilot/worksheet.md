# REVIEW-PILOT-001 review worksheet

Run `{{run}}`, attempt `{{attemptId}}`. Fill this in **before** moving the task to `done` (or deciding not to). Write what you
actually did, not what you would ideally do. "I don't know" is a valid answer.

For each **source**, use one of:

- `evidence`: `endo attempt evidence`
- `task`: `endo task show`
- `diff`: the candidate diff
- `file`: opening a file in the project
- `page`: the workbench page, during the run
- `pi-session`: Pi's own session file
- `memory`: what you remember seeing, with no record of it
- `none`: no answer was available

The commands for this run:

```sh
{{evidenceCommand}}
{{taskCommand}}
{{diffCommand}}
```

Fixture commit (before any agent work): `{{baseCommit}}`

## A. The acceptance criteria

The criteria, as given to the agent:

```text
{{acceptance}}
```

| # | Met? (yes / no / unsure) | Source(s) you used | Was that source enough on its own? If not, what was missing? |
| :-- | :-- | :-- | :-- |
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |

## B. What the records did and did not tell you

1. **The candidate (001B §5 item 3).** Which commit did you review? Could you tell from the records alone that it is what the agent
   produced, and nothing else? Source:
2. **The revision you decided on (item 4).** Write down the commit you are deciding on. After the status move, is that commit in any
   record? Source:
3. **The constraints (item 5).** Did the agent keep to "edit only src/duration.mjs and README.md", "no git" and "no packages"? How
   did you tell, and was it enough? Source:
4. **The gap list.** Did `endo attempt evidence` list a gap you did not already know about? Did it miss one you found yourself?
5. **The page (item 7).** Did you look at the workbench page during the run? Would the gap list on that page have changed anything
   you did?
6. **The approval (item 1).** Was the `APPROVE ATTEMPT` code obvious when you typed it? Did you decline first, on purpose or not?

## C. The decision

- Decision (done / not done / reopened), and the one-line reason you will put in the status note:
- Commit decided on:
- Minutes spent reviewing, roughly:
- The one record you most wished existed:
