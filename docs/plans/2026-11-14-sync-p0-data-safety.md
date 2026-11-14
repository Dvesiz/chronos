# Chronos Sync 2.0 P0 Data Safety Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent local unsynced edits from being silently lost during queue compaction, login, startup reconciliation, and logout, while preserving the current local-first architecture.

**Architecture:** Keep the existing `cloud-sync.js` adapter and snapshot-based API for the first phase. Introduce an explicit acknowledged snapshot separate from the working/queued state; derive queue compaction from the acknowledged snapshot plus the current working state; never discard pending events during lifecycle transitions. Defer revision protocol, tombstones, and schema decomposition until this phase is green.

**Tech Stack:** Vanilla JavaScript, WebView localStorage, Cloudflare Worker + D1, Node regression tests.

---

### Task 1: Add failing tests for acknowledged snapshot and lifecycle safety

**Files:**
- Modify: `tests/sync-data-loss.test.js`
- Test: `tests/sync-data-loss.test.js`

**Step 1: Write the failing tests**

Add tests covering:
- 150 offline edits to different fields survive compaction, not only a single counter.
- Login with an existing remote snapshot and a non-empty local queue does not clear the queue; local pending edits are rebased onto the remote state.
- Logout preserves the pending queue even when the logout request fails.
- Startup reconciliation does not apply a remote snapshot after a local revision changed during the request.

Use the existing VM harness and fake fetch implementation. Assert observable state, queue contents, and upload payloads.

**Step 2: Run tests to verify they fail**

Run:
```bash
node tests/sync-data-loss.test.js
```

Expected: FAIL because the current implementation clears queues in `loginReady`, `init`/boot, and `logout`, and compacts against `queuedState` instead of an acknowledged remote baseline.

---

### Task 2: Introduce acknowledged snapshot state and reliable queue compaction

**Files:**
- Modify: `app/src/main/assets/www/cloud-sync.js:8-165, 348-358`

**Step 1: Add durable acknowledged snapshot keys**

Add a dedicated localStorage key for the last acknowledged cloud state and keep it separate from `queuedState`. On successful snapshot acceptance or event upload, update the acknowledged snapshot only after the server response is received.

**Step 2: Implement compaction from acknowledged state**

Replace the current `compactQueue()` base selection with:
- `acknowledgedState` as the base;
- current `state.get()` as the working state;
- one merged event containing `diff(acknowledgedState, workingState)`;
- preserve the current `headSeq` as `baseSeq`;
- never truncate the final state to the last 100 events.

If the merged event is too large, surface a sync error state rather than silently deleting events.

**Step 3: Run focused tests**

Run:
```bash
node tests/sync-data-loss.test.js
node tests/data-integrity.test.js
```

Expected: PASS, including distinct offline field edits surviving compaction.

---

### Task 3: Reconcile local pending edits instead of clearing them at login/startup

**Files:**
- Modify: `app/src/main/assets/www/cloud-sync.js:188-323, 360-387`

**Step 1: Preserve the outbox during login**

When a remote snapshot exists, do not assign `state.queue = []`. Rebase all pending local operations onto the remote snapshot, update the acknowledged snapshot to the remote state, rebuild the queue from `diff(remoteState, mergedWorkingState)`, and upload the rebased event.

When the remote snapshot is empty, keep pending local edits and only create an initialization replace event if there is no existing equivalent pending event.

**Step 2: Add local revision protection**

Capture a local revision token before requesting the remote snapshot. If local state changed during the request, rebase rather than applying the remote state directly.

**Step 3: Run focused tests**

Run:
```bash
node tests/sync-data-loss.test.js
node tests/cloud-sync.test.js
```

Expected: PASS, with login/startup preserving pending local edits.

---

### Task 4: Preserve pending events on logout and isolate account queues

**Files:**
- Modify: `app/src/main/assets/www/cloud-sync.js:8-12, 325-345`
- Modify: `tests/sync-data-loss.test.js`

**Step 1: Namespace queue records by account**

Store the authenticated user identity with queued events once the server returns it. On account change, keep old-account pending events quarantined and never upload them under the new account.

**Step 2: Change logout behavior**

Do not clear business state or pending queue on logout. Stop polling and remove only the active session token. Preserve the queue for an explicit later resume or user-selected discard flow.

**Step 3: Run focused tests**

Run:
```bash
node tests/sync-data-loss.test.js
node tests/cloud-sync.test.js
```

Expected: PASS, including logout network failure preserving pending data.

---

### Task 5: Add regression coverage to the unified test command and document the safety contract

**Files:**
- Modify: `backend/package.json`
- Modify: `README.md`

**Step 1: Register tests**

Ensure `npm run test:frontend` runs the lifecycle and queue safety tests exactly once.

**Step 2: Document behavior**

Document that:
- local working data is never discarded merely because remote data exists;
- pending outbox events survive login, startup, network failure, and logout;
- only explicit server acknowledgement permits queue cleanup;
- remote snapshots are rebased against local pending work.

**Step 3: Run full regression**

Run:
```bash
cd backend && npm run test:all
```

Expected: all backend and frontend tests pass.

---

### Task 6: Commit and release the P0 phase

**Files:**
- All files changed by Tasks 1-5

**Step 1: Review the diff**

Run:
```bash
git diff --check
git status --short
git diff --stat
```

Expected: only sync safety code, tests, package scripts, and documentation are changed.

**Step 2: Commit**

```bash
git add app/src/main/assets/www/cloud-sync.js tests/sync-data-loss.test.js backend/package.json README.md
git commit -m "fix: preserve unsynced local edits across sync lifecycle"
```

**Step 3: Verify before release**

Run the full regression command and the Android build. Do not publish a new Release until all focused and full tests pass.
