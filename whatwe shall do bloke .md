## GigR Stabilization Task List

### 🔴 Critical (blocks core flow or causes data corruption)

| # | Issue | Description | Files to touch |
|---|-------|-------------|----------------|
| **C1** | **Accept-request sends email synchronously** | If Brevo fails, the endpoint returns 500 but the job status is already updated in the database. Move email sending to a background task so the response succeeds regardless of email delivery. | `backend/app/api/v1/endpoints/jobs.py` |
| **C2** | **All action buttons need loading/disabled state** | Buttons for Apply, Assign, Fund, Release, Vouch, Accept Request, Submit Work can be clicked multiple times, causing duplicate transactions or API calls. | `frontend/src/pages/JobsPage.tsx`, `frontend/src/pages/ActivityPage.tsx`, `frontend/src/pages/ServicesPage.tsx` |
| **C3** | **Duplicate service/job creation prevention at API level** | Backend must reject duplicate service listings (same provider, title, price, description) with 409 Conflict. Same for duplicate open jobs. | `backend/app/api/v1/endpoints/services.py`, `backend/app/api/v1/endpoints/jobs.py` |
| **C4** | **Fund/Release/Vouch idempotency on backend** | If a blockchain transaction fails but the database status was already updated, a second attempt should not create a second on-chain transaction. Add guards checking current job status before calling Solana. | `backend/app/api/v1/endpoints/jobs.py`, `backend/app/api/v1/endpoints/vouches.py` |

### 🟡 High (breaks user experience but core flow works)

| # | Issue | Description | Files to touch |
|---|-------|-------------|----------------|
| **H1** | **Activity page mixes completed and cancelled jobs** | The "Completed" tab shows cancelled jobs. Add a separate "Cancelled" tab or filter properly. | `frontend/src/pages/ActivityPage.tsx` |
| **H2** | **"Start Working" button does nothing** | When a provider sees an assigned job, clicking "Start Working" has no effect. It should navigate to the contract room or mark the job as `in_progress`. | `frontend/src/pages/JobsPage.tsx`, `frontend/src/pages/ActivityPage.tsx` |
| **H3** | **Messages and cards don't show timestamps** | Messages, job cards, service cards, and activity items show no date/time. Add formatted timestamps everywhere. | `frontend/src/pages/MessagesPage.tsx`, `frontend/src/pages/JobsPage.tsx`, `frontend/src/pages/ServicesPage.tsx`, `frontend/src/pages/ActivityPage.tsx` |
| **H4** | **Assigned jobs still appear in "Open Jobs" tab** | Once a job is assigned, it should move out of the open/available listings. | `frontend/src/pages/JobsPage.tsx` |
| **H5** | **No loading feedback after actions** | After clicking any action button, there's no visual indicator that something is happening until the toast appears. Add spinner and disabled state to all action buttons. | Multiple frontend pages |

### 🟢 Medium (quality of life improvements)

| # | Issue | Description | Files to touch |
|---|-------|-------------|----------------|
| **M1** | **Confirmation dialogs for critical actions** | Fund, Release, Cancel, and Dispute should show a confirmation dialog before executing. | `frontend/src/pages/JobsPage.tsx`, `frontend/src/pages/ActivityPage.tsx` |
| **M2** | **Wallet balance doesn't auto-refresh** | After funding or releasing, the Profile page still shows the old balance until manually refreshed. Invalidate the balance query after escrow actions. | `frontend/src/pages/ProfilePage.tsx`, `frontend/src/pages/JobsPage.tsx` |
| **M3** | **Search bar in services fires on every keystroke** | Typing in the service search bar triggers an API call on each character. Add a 300ms debounce. | `frontend/src/pages/ServicesPage.tsx` |
| **M4** | **Profile page should show all vouches with job context** | Currently shows vouch records but not what job they came from. Enrich with job title and date. | `frontend/src/pages/ProfilePage.tsx` |
| **M5** | **Service request flow: no notification to provider** | When a client requests a service, the provider doesn't get an in‑app notification (only email). Use the WebSocket system to push a notification. | `backend/app/api/v1/endpoints/jobs.py`, `backend/app/services/ws_manager.py` |

### 🔵 Low (polish and visual consistency)

| # | Issue | Description | Files to touch |
|---|-------|-------------|----------------|
| **L1** | **Empty states are inconsistent** | "No jobs", "No services", "No messages" all look different. Create a reusable `<EmptyState>` component. | `frontend/src/components/EmptyState.tsx`, then use in all pages |
| **L2** | **Dark mode doesn't persist properly** | Toggling dark mode doesn't remember preference across page refreshes. Use localStorage with Zustand persist. | `frontend/src/store/themeStore.ts` |
| **L3** | **Landing page "Learn More" button is dead** | The button doesn't scroll to any section or perform an action. Either link to features or remove it. | `frontend/src/pages/LandingPage.tsx` |
| **L4** | **Error toasts disappear too quickly** | Some error messages are long and need more time to read. Increase toast duration for error toasts. | `frontend/src/components/ToastProvider.tsx` or `App.tsx` |
| **L5** | **Contract room should auto‑scroll to latest message** | When opening a contract room, it should scroll to the bottom. When a new message arrives (WebSocket), it should auto‑scroll. | `frontend/src/pages/MessagesPage.tsx`, `frontend/src/pages/ActivityPage.tsx` |

### 📦 Onramp / Wallet (separate workstream)

| # | Issue | Description | Files to touch |
|---|-------|-------------|----------------|
| **W1** | **Onramp Money SDK is installed but not wired** | The `@onramp.money/onramp-web-sdk` is in `package.json` but not integrated into any UI. Add a "Fund Wallet" button that opens the onramp widget. | `frontend/src/pages/ProfilePage.tsx`, `frontend/src/components/WalletFundDialog.tsx` (new) |
| **W2** | **No transaction history on wallet** | The wallet card shows balance but no list of past escrow events. Query completed jobs and display them. | `frontend/src/pages/ProfilePage.tsx`, `backend/app/api/v1/endpoints/users.py` |

---