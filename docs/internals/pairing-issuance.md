# Pairing issuance — a fresh code per attempt (decision 20)

Diagnosis and fix for the reported "one pairing code total, every PC after the first locked out" (PLAN decision 20).
Scope: the Mac side only (`mac/service` pairing, the Devices/pairing UI, the Mac service test suite).

## Symptom

After pressing **Forget** on a device in the Mac's Devices view and then pairing a *different* PC, pairing the
second PC failed on Windows with "the pairing code is already in use." No PC after the first could pair.

## What is correct and must not change (decision 1)

Each pairing code is a one-time, single-device bootstrap: the pairing string carries a unique `pairingId` and a
one-time `secret`, and the Mac writes exactly one `pair/<pairingId>` object into the device's cmd-bucket. The
Windows side (`windows/Ivy.Core/Agent/PairingService.cs`) fetches `pair/<pairingId>` and, when it is already
consumed/missing, correctly refuses. Consuming a code is what makes it one-time; the fix is issuing *more* codes,
never making one code reusable.

## Root cause (named, with evidence)

The defect was in the **Devices/pairing UI** (`mac/ui/src/views/Devices.tsx`), not in the service's minting logic.

- The service already mints fresh per attempt. `mac/service/src/pairing/pairing.ts` `startPairing` cancels any
  still-*pending* code for the role (deleting its bootstrap), then mints a new `pairingId`, a new `secret`, and
  writes a new `pair/<newId>` bootstrap. `acceptDeviceRecord` flips the row to `consumed` in the ingest
  transaction and `finishPairing` deletes the bootstrap. Verified by a temporary reproduction against the real
  service + S3 mock: two consecutive `POST /api/pairings` gave two different ids; Forget-then-start-again gave a
  fresh id and a second simulated PC paired. So the service was never re-serving a consumed code.

- The UI held one code and never re-minted or showed its state. `start(role)` called `POST /api/pairings`
  **once** and stored the result in React state; `PairingSheet` only rendered that one code. There was **no**
  "generate new code" affordance, **no** indication when the shown code had been consumed, and neither **Forget**
  nor reopening the pair screen minted a replacement. So after the first PC consumed the code, the owner was left
  re-pasting the same dead string, which Windows correctly rejected as already in use. A single code cannot pair
  more than one device because consuming it is what makes it one-time.

## Fix

Service (no change to the one-time/single-device contract, no secrets in any read):

- `currentPairing(ctx, role)` and `pairingById(ctx, id)` report a code's live state (`usable`, `status`,
  `consumedAt`, `deviceId`) with **no secret** in the payload.
- `GET /api/pairings/current?role=` and `GET /api/pairings/:id/state` expose that state to the pair screen.

UI (`PairingSheet`):

- Watches the shown code's state (polls `/api/pairings/:id/state` and reacts to `pairing.*` events).
- When the code is consumed, marks it clearly as **used** (and hides the now-dead secret string/QR).
- Adds a one-click **Generate new code** button that mints a fresh code in place, so a laptop and a PC (both
  `windows`) can each pair with their own code. After a device pairs the sheet stays open on the "used" state so
  the owner can mint the next code immediately. **Forget** and opening/reopening the pair screen always lead to a
  fresh, unused code.

## Tests

- `mac/service/test/pairing-issuance.test.ts`: two attempts give two different ids each with its own bootstrap;
  two devices pair each with its own fresh code; a consumed code is never re-served.
- `mac/service/test/pairing-state.test.ts`: `/api/pairings/current` and `/:id/state` report usable→used; current
  is null before any code; Forget then start yields a fresh unused code and a second PC pairs.
- `mac/ui/test/views.test.tsx`: a used code is marked and hides the secret; one click on **Generate new code**
  mints a fresh, different code in place.

## Logs and records

IDs, counts, timestamps and errors only. The one-time secret lives only in the pairing string returned by
`startPairing`; it is never stored, never logged, and never included in any state read.
