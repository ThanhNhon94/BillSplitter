# Business Requirements Document

## Project: ChiaBill — Shared Expense / Bill Splitter App

### 1. Overview

A mobile app for friends, roommates and small groups. One person pays a shared bill; the app splits it, tracks who owes whom, and lets each debtor pay back by scanning a **VietQR code of the payer, prefilled with the exact amount**. Both sides confirm each payment.

**Target platform:** React Native (Expo, TypeScript) — Android and iOS from one codebase
**Target users:** Roommates, shared households, small friend groups
**Current release:** v0.4.0. React Native app on Firebase (Authentication + Firestore with Security Rules). Business logic is the v0.3.0 Java logic, ported to TypeScript with the same tests.

> **History:** the first draft was React Native + Node/Express; v0.3.0 was Java native Android + Node/Express. v0.4.0 returns to React Native and replaces the Express server and Room cache with Firebase. Storage stays behind the `LedgerRepository` interface.

Status legend: **Done** = implemented in v0.4.0 · **Partial** = implemented with the stated limit · **To do** = not yet.

---

### 2. Functional Requirements (FR)

#### 2.1 User & Group Management

| ID | Requirement | Status | Where |
|----|-------------|--------|-------|
| FR1 | The system shall allow a user to create an account and log in. | **Done.** Account = display name + Vietnamese mobile number (normalised, unique). Login = phone number + password via Firebase Auth (phone → synthetic email), session restored on restart. | `src/app/login.tsx`, `FirebaseAuthRepository`, `PhoneNumber` |
| FR2 | The system shall allow a user to create a group and invite members. | **Done.** Add members by exact phone-number match; each group gets an invite code. | `src/app/create-group.tsx`, `src/app/group/[id].tsx` |
| FR3 | The system shall allow a user to join an existing group via an invite code or link. | **Partial.** 6-character invite code (`DAL-AT7`), shareable as text. Deep link is still to do (URL scheme `chiabill` is registered). | `InviteCode`, `src/app/(tabs)/index.tsx` |
| FR4 | The system shall allow a user to view and manage members of a group (add or remove members). | **Done.** Group creator removes a member; blocked while that member has unconfirmed debts in the group. | `FirebaseLedgerRepository.removeMember` |

#### 2.2 Expense Management

| ID | Requirement | Status | Where |
|----|-------------|--------|-------|
| FR5 | The system shall allow a user to add an expense with amount, description, category, date, payer, and participants. | **Done.** Categories: Ăn uống, Đi lại, Lưu trú, Mua sắm, Giải trí, Khác. Date picker (no future dates). No VAT or service fee: the amount entered is the total. | `src/app/bill/edit.tsx`, `Category` |
| FR6 | The system shall allow a user to choose a split method: equal split, custom amounts, or percentage split. | **Changed: equal split only.** Custom, percentage and itemised splits, VAT, service fee and rounding were removed to keep the logic small and easy to explain. Shares differ by at most 1đ; the leftover đồng go to the first members in group order. | `SplitEngine` |
| FR7 | The system shall allow a user to edit or delete an expense they created. | **Done.** Creator or payer only; bills with a confirmed payment cannot be deleted. | `FirebaseLedgerRepository.saveBill/deleteBill`, `firestore.rules` |
| FR8 | The system shall allow a user to view a history of all expenses in a group, filterable by date, member, or category. | **Done.** Filters: category, member (paid or has a share), period (7 days, 30 days, this month). | `src/app/group/[id].tsx` |

#### 2.3 Balance & Settlement

| ID | Requirement | Status | Where |
|----|-------------|--------|-------|
| FR9 | The system shall automatically calculate each member's balance. | **Done.** | `Ledger` |
| FR10 | The system shall display a summary screen showing net balances per member. | **Done.** | `src/app/group/settle.tsx` |
| FR11 | The system shall allow a user to record a "settle up" payment, marking a debt as paid. | **Done.** Debtor marks paid → payer confirms or disputes (state machine). Settle screen also proposes the fewest transfers. | `PaymentStateMachine`, `DebtSimplifier` |
| FR12 | The system shall update all affected balances immediately after any expense or settlement change. | **Done.** Firestore realtime listeners → one immutable `AppSnapshot` (`watchSnapshot.ts`). Editing an amount resets unconfirmed debts to "not paid" and notifies the debtor. | `AppSnapshot` |

#### 2.4 Other

| ID | Requirement | Status | Where |
|----|-------------|--------|-------|
| FR13 | The system shall allow a user to edit their profile (name, avatar). | **Partial.** Name editable; avatar is the initial on a fixed colour. Photo upload not planned. | `src/app/(tabs)/profile.tsx` |
| FR14 | The system shall allow a user to leave a group. | **Done.** Blocked while the user still owes or is owed in that group. Old bills keep the user's share. | `FirebaseLedgerRepository.leaveGroup` |
| FR15 | The system shall allow the app to function offline, caching data locally and syncing once the device reconnects. | **Partial.** Live sync across devices while online (Firestore). React Native has no persistent Firestore cache, so the app needs a connection to start and write. When the connection drops or a listener fails, the app re-subscribes with back-off (and immediately on returning to the foreground) and shows a banner with a retry button instead of loading silently. | — |

#### 2.5 Added by ChiaBill

| ID | Requirement | Status |
|----|-------------|--------|
| FR16 | Each debt shall show a VietQR (NAPAS, EMVCo) of the payer's bank account with amount and transfer note prefilled, generated on the device. | **Done** |
| FR17 | A user shall register their receiving account by picking a QR screenshot, scanning with the camera, pasting the QR string, or typing bank + account number. Invalid QR (bad CRC, not VietQR) is rejected with a reason. | **Done** |
| FR18 | Debtors, payers and added members shall receive in-app and system notifications; tapping one opens the related debt. | **Done** |
| FR19 | A debtor shall be able to save the QR image or share it to a guest who does not have the app. | **Done** |

---

### 3. Non-Functional Requirements (NFR)

| ID | Category | Requirement | Status |
|----|----------|-------------|--------|
| NFR1 | Performance | Backend responses within ~2 s under normal load. | **To measure** (Firestore round-trips; no custom API) |
| NFR2 | Performance | Balance recalculation near-instant on device after any change. | **Done.** Pure-TypeScript split of 10 000 random bills runs in a few seconds in unit tests (on a laptop; per-bill cost is microseconds). |
| NFR3 | Usability | Adding an expense shall take no more than 3–4 inputs/taps. | **To measure.** Equal split with defaults: amount → save (payer, participants, category, date pre-filled). |
| NFR4 | Usability | SUS ≥ 70 in evaluation. | **To measure** with classmates |
| NFR5 | Reliability | Offline-first: add and view expenses without network. | **Not met.** Needs a connection (see FR15). v0.3.0 was offline-first. |
| NFR6 | Security | Passwords hashed (e.g. bcrypt). | **Done** (Firebase Auth) |
| NFR7 | Security | Authenticated access to protected data. | **Done** (Firebase ID tokens + `firestore.rules`) |
| NFR8 | Security | HTTPS for all client–server traffic. | **Done** (Firebase SDK). QR is still generated on the device. |
| NFR9 | Scalability | Multiple groups per user without slowdown. | **Done** |
| NFR10 | Maintainability | Layered architecture with clear separation. | **Done:** `src/domain` (pure TypeScript) → `src/data` (Firestore repository) → `src/ui` / `src/app`. |
| NFR11 | Portability | iOS and Android from one React Native codebase. | **Done** (Expo; not yet run on iOS hardware) |
| NFR12 | Data Consistency | Balances always equal the sum of underlying records, no drift. | **Done.** Money is integer VND (`number`, safe integers; `BigInt` inside the allocator), never floating point. Largest-remainder allocation; property tests on 10 000 random bills. |
| NFR13 | Availability | Backend stable during demo. | **Done** (managed by Firebase) |

---

### 4. Traceability Note

FR5–FR12 are the core evaluation criteria: correctness of balance calculations and usability of the expense and settlement flows. Correctness is covered by the `src/domain` unit and property tests (`npm test`, 53 tests, same cases and seeds as the v0.3.0 JUnit suite) and by 25 integration tests on the Firebase emulators (`npm run test:int`); usability by task-based sessions with classmates (NFR3, NFR4).
