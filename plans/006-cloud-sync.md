# Plan 006: ppr cloud sync — the shape, the trigger, and why not yet

> **Verdict: DO NOT BUILD YET.** Not on principle — the "git is the sync story"
> rule in AGENTS.md §11 is about ppr the CLI, and a separate synced product does
> not have to violate it. On sequencing: sync's value is *a second device that
> can read the vault*, and today there is no such device. Building sync now
> means syncing a Mac to a Mac, which git already does.
>
> This plan exists so the decision is recorded with its reasoning, the trigger
> conditions are written down before enthusiasm arrives, and the architecture is
> chosen while it is cheap to choose. It also contains two things worth doing
> **now**, in Part VI, that cost a day between them.

## Status

- **Priority**: HELD — not scheduled
- **Effort**: XL, and unlike the other plans this one has an *ongoing* cost:
  infrastructure, uptime, key management, support, and liability for other
  people's data
- **Risk**: HIGH
- **Depends on**: [005](005-mac-app.md) shipped **and** a second device that
  cannot use git (i.e. iOS or a web app)
- **Category**: new product
- **Planned at**: `e773b65`, 2026-08-10
- **Reviewed in**: [002-review.md](002-review.md)

---

# Part I — The case for it, stated fairly

Obsidian Sync is the existence proof, and it is a good one: a local-first
markdown tool with an optional paid sync service, where the sync is the business
model and the files staying plain is the reason people trust it. The economics
work, the ethics work, and the shape fits ppr's recorded direction — open source
now, paid maybe later — better than any alternative monetisation would. Ads are
absurd here, a hosted AI feature contradicts §2's "bring your own key", and a
paid CLI is not a thing.

It also solves a real problem for the audience plan 005 names but cannot yet
serve. Telling a non-technical user to put their vault in iCloud Drive works
until it does not, and when iCloud eats a file there is nobody to ask.

So: the right long-term answer is probably yes. The question this plan answers
is *when*, and *in what shape*.

---

# Part II — Why not yet

## 1. There is nothing on the other end

Sync is a verb with two arguments. Today both of them are Macs with a shell,
which means `git push` / `git pull` already syncs ppr completely, atomically
(I9), with history, offline, for free, forever. A paid service whose value
proposition over `git pull` is "you do not have to type `git pull`" is a
convenience feature priced as a product.

Sync becomes genuinely load-bearing the moment there is a device that *cannot*
run git usefully — iOS, or a browser. That is the trigger, and it is not close:
005 is staged, gated on a spike, and explicitly scopes iOS out.

## 2. It is a company, not a feature

The other four plans in this directory are code. This one is: infrastructure
that must not go down, a key-management scheme that must not lose a passphrase,
a storage bill that scales with users, a support channel for people whose notes
did not arrive, GDPR/DSAR obligations, and a promise that outlives your interest
in maintaining it. None of that is unreasonable to take on deliberately. All of
it is unreasonable to take on as the third bullet in an ideas file.

## 3. The liability is asymmetric with everything else in this repo

A bug in `ppr tidy` costs a report. A bug in sync costs somebody else's journal,
on a day you were not looking. Every invariant in AGENTS.md exists to keep the
user's words safe from ppr; sync is the first feature where ppr's words can be
lost by a *server* — outside the reach of I1, I2, and I9 alike.

## 4. Doing it early forecloses the cheap option

The moment there is a proprietary sync protocol, "delete ppr tomorrow and your
notes are exactly as readable as they are today" needs an asterisk about export.
Choosing git-as-transport (Part III) keeps the promise literally true. That
choice is easy to make now and expensive to make after a client has shipped.

---

# Part III — The shape, when the trigger fires

## It is a plugin, not a core feature

`ppr-sync`, an executable on PATH (I13, `cli/src/external.ts`). Not a `Storage`
adapter, not a daemon inside ppr, not a `sync` subcommand in `packages/`.

This matters more than it sounds. As a plugin:

- §11 stays literally true — ppr gained no sync daemon.
- The service can ship, break, and be versioned on its own cadence.
- A user who stops paying is left with a vault and a `ppr-sync` that does
  nothing, rather than a ppr that has an opinion about their account.
- The open/paid line is drawn by *which binary*, not by a build flag or a
  licence check inside the CLI.

The one thing ppr proper might eventually owe it is a lock or a "vault is busy"
convention, and even that is probably unnecessary given I9's atomic writes.

## Architecture: three candidates

### A. Managed git remote (recommended for v1)

ppr cloud is a hosted git host with a small, opinionated client:
`ppr-sync` runs commit / pull --rebase / push on a timer and on demand, and
owns the conflict UX.

| | |
|---|---|
| ✅ | The product promise holds absolutely — it is a git repo; `git clone` and leave |
| ✅ | History, atomicity, offline, and merge are all solved and battle-tested |
| ✅ | Cheapest to build and to operate; the server is nearly off-the-shelf |
| ✅ | Technical users can bring their own remote and pay nothing — which is the honest positioning for the current audience |
| ⚠️ | Git on iOS is painful; a native client is a real project |
| ⚠️ | Attachments bloat history unless LFS or a policy exists |
| ⚠️ | Merge conflicts in prose are a UX problem git does not solve for normies |

### B. File-level sync with per-file versioning and conflict copies

Obsidian Sync's and Dropbox's model. A server that stores per-path versions,
last-writer-wins with a conflict copy when two devices diverge.

| | |
|---|---|
| ✅ | Much better mobile and web story; no git dependency on the client |
| ✅ | Straightforward E2EE story (ciphertext blobs keyed by hashed path) |
| ⚠️ | Everything git gave for free — history, atomicity across a multi-file change, offline merge — must be rebuilt |
| ⚠️ | Real infrastructure, real bills, real on-call |

### C. CRDT per file

Rejected. ppr's write pattern is one author per device and mostly append; a text
CRDT would add a per-file sidecar of metadata that either lives in the vault
(breaking "nothing here needs ppr to be readable") or off to the side (a second
owner of the row, ending I1). The problem it solves — concurrent edits to the
same paragraph — is not ppr's problem.

**Recommendation: A for v1, and design the client so B is a swappable
transport.** A serves the current audience honestly and cheaply; B is the
migration when normies and iOS arrive together.

## Rules the design must hold, whichever transport wins

1. **End-to-end encrypted, no exceptions.** The server sees ciphertext and
   hashed paths. This follows from I7's threat model, and it is also the only
   version of this product that is comfortable to sell. Consequence to accept
   up front: no server-side search, and a web app must hold the key in the
   browser.
2. **Sync is never the only copy.** A remote delete does not delete locally
   without a tombstone and a review window. The default posture on any ambiguity
   is *keep both*, which is what `factKey`/`absorb` and `ppr memory review`
   already do for facts — the same instinct, applied to files.
3. **Conflicts become entries, never merges.** Never auto-merge prose. Write the
   loser as a sibling entry with a `conflicts` reference, and let the existing
   review pattern (`commands/think.ts:544`) settle it. ppr already has a
   vocabulary for "two things disagree"; reuse it rather than inventing a
   conflict UI.
4. **`ppr-sync` writes through `ppr`, or writes files and lets the catalog
   notice.** Never a third writer with its own idea of the entry format. I1 is
   the whole reason to be careful here.
5. **The paid tier is storage and convenience, never capability.** No feature of
   ppr is behind it. The moment a command needs an account, §2 is gone.

---

# Part IV — Trigger conditions

Build it when **all three** are true. Written now, so the decision later is a
check rather than a mood:

1. **A second device exists that cannot use git.** iOS app, or a web app in 005
   Part VIII's sense. Not "is planned" — exists and is used.
2. **You have wanted it personally for a month.** The maintainer is user zero;
   if git-in-a-cron is still fine for you, it is fine.
3. **You are willing to run it for five years.** Including the year you are
   bored of it. If that is not a yes, the honest product is a documented
   `git`-and-a-cheap-remote recipe, and that is not a failure.

A useful intermediate that requires none of the above: **`ppr-sync` over a
user-supplied git remote, unmanaged and free.** All of the client-side conflict
UX, none of the infrastructure, and it is a genuinely good plugin on its own.
If the trigger never fires, that is the whole product and it costs a weekend.

---

# Part V — One finding that sync makes urgent, and one it makes moot

## `.ppr/state.json` is committed, and merging it wrongly costs words

`initVault` writes a `.gitignore` containing exactly `.ppr/cache/`
(`packages/core/src/node/paths.ts:59`). So the parse cache is correctly excluded
— it is disposable by I1 — but `.ppr/state.json`, which holds the learner's
high-water mark, **is tracked and does sync**.

That is defensible today and dangerous under any sync. Two machines learning
independently produce two marks. Git will conflict on the file; a person
resolving it will take the higher number, because a higher number looks newer.
L23 says exactly what that costs:

> *"a mark left behind costs a re-scan that reconciliation absorbs, a mark moved
> wrongly costs words."*

Taking the higher mark declares entries read that no model on that machine ever
saw, and nothing offers them again because `learn` is incremental by default.
The safe resolution is always the **lower** mark, and nothing anywhere says so.

Three options, in increasing cost:

- **Cheapest**: add `.ppr/state.json` to `GITIGNORE`. The mark becomes
  per-machine, each machine re-scans its own backlog, reconciliation absorbs the
  overlap. This is almost certainly right, and it is a two-line change plus a
  test.
- **Middle**: keep it tracked and make the file self-documenting — a comment
  field saying "on conflict, keep the *lower* id".
- **Most correct**: store the mark per-machine inside the tracked file
  (`{ marks: { "<host-id>": "<id>" } }`), so a merge is a union and never a
  choice.

**Recommendation: the cheapest one, now**, and it is listed in Part VI. It is a
real latent bug for anyone already syncing a vault through git or Dropbox, which
is the documented recommendation.

## What sync makes moot

Nothing. Worth stating: no other plan in this directory is waiting on this one,
and none of them get easier if it exists. That is a good sign about the
sequencing.

---

# Part VI — What to do instead, now (one day of work)

1. **`.ppr/state.json` in the vault `.gitignore`** (Part V). Two lines in
   `paths.ts:59`, one test — *"the learner's mark is this machine's, not the
   repo's"* — and a note in the vault README about why. Do this regardless of
   whether sync is ever built.
2. **Document the folder-sync recipes properly**, in the root README: git with a
   remote and a cron; iCloud Drive; Dropbox; Syncthing. Say what each is good
   and bad at, and say plainly that ppr's writes are atomic (I9) so a
   half-written entry cannot sync. This is the current answer to the sync
   question and it deserves better than being implied.
3. *(Optional, a weekend)* **`ppr-sync` over a user's own git remote.** Commit
   with a sensible message, pull with rebase, push, and turn a merge conflict
   into a conflict entry rather than leaving `<<<<<<<` markers in a note.
   Independently useful, and it is the client half of option A — so if the
   trigger ever fires, the managed service is a server plus a remote URL rather
   than a new product.

---

# Part VII — Open questions, for the day the trigger fires

1. **Pricing shape** — per-vault, per-GB, or flat. Obsidian's flat ~\$4/month
   with a storage cap is the reference point and the one users already accept.
2. **Passphrase recovery.** There is none, if E2EE means anything. That is a
   support burden and a churn cause, and it must be decided *before* the first
   user, not after the first lost passphrase.
3. **Attachments.** The vault is markdown today. Images and audio (from
   `ppr voice`) change the storage economics completely and should be priced and
   designed together with sync, not after it.
4. **Where the web app's key lives.** Sessions-in-memory means logging in every
   time; persisting it in the browser weakens the E2EE claim. This is the
   question that decides whether a web app is worth building at all.
