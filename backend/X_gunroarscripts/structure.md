# Gigr Project Structure & Analysis

## Overview

Gigr is a **hyper-local services marketplace** with a cryptographically secured trust and escrow layer on Solana. It connects clients with local service providers, using blockchain-based USDC escrow to guarantee payments and on-chain reputation (cNFTs) for trust.

**Tech Stack:**
- **Frontend:** React 18 + TypeScript + Vite + TailwindCSS + React Router + TanStack Query + Zustand + Axios
- **Backend:** FastAPI (Python) + SQLAlchemy + PostgreSQL/PostGIS + GeoAlchemy2
- **Blockchain:** Custom Solana Anchor Smart Contract (USDC escrow) + Underdog Protocol (cNFT reputation)
- **Infrastructure:** Docker, Render (frontend), Northflank/Render (backend), Vercel config

---

## How the Project Works

### Core Flow

1. **User Onboarding** — Sign up via email/password or Google OAuth. On registration, a Solana wallet is generated for the user (keypair stored encrypted in DB via Fernet).

2. **Service Discovery** — Providers create service listings with category, location, price range, and service radius. Clients search/browse services or post open jobs, filtered by location (PostGIS proximity queries) and category.

3. **Job Lifecycle:**
   ```
   open → requested → assigned → funded → in_progress → completed
                                                         → disputed
                                                         → cancelled
   ```
   - **Open Jobs:** Clients post a job; providers apply.
   - **Requested:** Client requests a specific provider's service.
   - **Assigned:** Client selects/approves a provider.
   - **Funded:** Client deposits USDC into a Solana Program Derived Address (PDA) escrow. The price is converted from Naira to USDC using a live exchange rate.
   - **Completed:** Client releases escrow → USDC transferred to provider's wallet.
   - **Cancelled:** Before funding = off-chain. After funding = on-chain refund to client.
   - **Disputed:** Either party raises a dispute, jury votes, admin resolves.

4. **Vouching (Reputation):** After job completion, client vouches for provider. Non-blocking background task mints a compressed NFT (cNFT) via Underdog Protocol as verifiable on-chain reputation.

5. **Scope Amendments:** During an active job, either party can propose a price change/additional cost. The other party must accept for it to take effect (off-chain tracking only — no on-chain adjustment).

6. **Messaging:** Per-job direct messaging between client and provider (REST-based, no real-time WebSocket).

7. **Dispute Resolution:**
   - Client or provider raises a dispute for a funded/in-progress job.
   - Admin selects a jury panel (3 random users).
   - Jury members cast votes ("refund", "release", "split").
   - Votes are tallied; admin executes the resolution.

---

## What Is Implemented (Complete)

### Backend — Models (SQLAlchemy + PostgreSQL/PostGIS)

| Model | Table | Key Fields |
|-------|-------|-----------|
| `User` | `users` | email, google_id, display_name, wallet keys (encrypted), last_location (Geography Point), civic_gateway_token |
| `ServiceListing` | `service_listings` | provider_id, category_id, title, price range, location (Geography Point), radius_km, image_url |
| `Job` | `jobs` | client_id, provider_id, title, description, status, price, location, escrow_address, contract_job_id, image_url |
| `Application` | `applications` | job_id, applicant_id, message, proposed_price, portfolio_url |
| `Message` | `messages` | job_id, sender_id, content, image_url |
| `Vouch` | `vouches` | job_id, voucher_id, vouchee_id, rating, comment, c_nft_id |
| `Dispute` | `disputes` | job_id, client_id, provider_id, reason, status, resolution |
| `Vote` | `votes` | dispute_id, juror_id, vote (refund/release/split) |
| `JuryPanel` | `jury_panels` | dispute_id, juror_id |
| `ScopeAmendment` | `scope_amendments` | job_id, proposed_by, reason, additional_cost, new_total_price, is_accepted |
| `Category` | `categories` | name |

### Backend — API Endpoints (FastAPI)

| Prefix | Endpoints | Status |
|--------|-----------|--------|
| `/api/v1/auth/` | register, login, google, me, link-google, refresh, logout | Complete |
| `/api/v1/users/` | me (get/update/delete), location, wallet, balance, verify-identity, get-by-id | Complete |
| `/api/v1/services/` | CRUD, search/nearby (PostGIS), search/text | Complete |
| `/api/v1/jobs/` | CRUD, request-service, accept-request, assign, fund (Solana escrow), release (Solana), cancel (off-chain + on-chain), exchange-rate | Complete |
| `/api/v1/applications/` | apply, list-by-job, withdraw | Complete |
| `/api/v1/vouches/` | create, get, list-by-user | Complete |
| `/api/v1/disputes/` | raise, get, jury/select, vote, results, resolve | Complete |
| `/api/v1/messages/` | send, list-by-job | Complete |
| `/api/v1/categories/` | list, create | Complete |
| `/api/v1/location/` | geocode (Stadia Maps) | Complete |
| `/api/v1/amendments/` | propose, accept, list-by-job | Complete |
| `/api/v1/upload/` | upload image (Cloudinary) | Complete |
| `/api/v1/admin/` | list/delete users, list jobs | Complete |

### Backend — Services

| Service | Purpose | Status |
|---------|---------|--------|
| `solana_client.py` | AnchorPy wrapper for escrow program (init, release, cancel). Retry logic, ATA creation. Embedded IDL. | Complete |
| `underdog_client.py` | Mint cNFT vouches via Underdog Protocol API | Complete |
| `brevo_client.py` | Send transactional emails (job requests, approvals, notifications) | Complete |
| `cloudinary_client.py` | Image upload to Cloudinary | Complete |
| `geolocation.py` | PostGIS proximity queries | Complete |
| `civic_client.py` | Civic identity verification gateway | Complete |
| `exchange_rate.py` | NGN/USD live rate (60-min cached) | Complete |
| `stadia_maps.py` | Stadia Maps tile/geocoding client | Complete |
| `release_code.py` | Release code generation utility | Complete |

### Backend — Infrastructure

| File | Purpose |
|------|---------|
| `Dockerfile` | Container build for backend |
| `vercel.json` | Vercel serverless deployment config |
| `requirements.txt` | Python dependencies |
| `.dockerignore` | Docker build exclusions |

### Frontend

| File | Purpose |
|------|---------|
| `App.tsx` | Router setup, protected routes, React Query provider, Toast/CookieConsent |
| `pages/LandingPage.tsx` | Public landing page with auth dialog |
| `pages/Dashboard.tsx` | Main dashboard after login |
| `pages/HomePage.tsx` | Dashboard home |
| `pages/JobsPage.tsx` | Job listing, creation, management |
| `pages/ServicesPage.tsx` | Service listings, creation, search |
| `pages/ActivityPage.tsx` | User activity stream |
| `pages/MessagesPage.tsx` | Per-job messaging |
| `pages/ProfilePage.tsx` | User profile management |
| `pages/LoginPage.tsx` | Login/Register standalone page |
| `pages/RegisterPage.tsx` | Registration page |
| `components/AuthDialog.tsx` | Auth modal (login/register) |
| `components/CookieConsent.tsx` | GDPR cookie consent banner |
| `components/DashboardLayout.tsx` | Dashboard sidebar/nav layout |
| `components/HeaderParticles.tsx` | Particle animation header |
| `components/Logo.tsx` | Logo component |
| `components/NeighborhoodMap.tsx` | React-Leaflet map for nearby services |
| `components/ConfirmDialog.tsx` | Confirmation modal |
| `components/ToastProvider.tsx` | Sonner toast notifications |
| `lib/api.ts` | Axios instance with auth interceptors, token refresh, error handling |
| `store/authStore.ts` | Zustand auth store (user state, login/logout/fetch) |
| `store/themeStore.ts` | Zustand theme/dark mode store |
| `types/api.ts` | Auto-generated OpenAPI TypeScript types (3129 lines) |
| `hooks/useGeolocation.ts` | Browser geolocation hook |
| `App.css` / `index.css` | Global styles |

### Blockchain — Smart Contract (Anchor)

| Instruction | Purpose |
|-------------|---------|
| `initEscrow` | Client funds escrow PDA with USDC. Takes job_id (u64) and amount (u64 in micro-USDC). |
| `releaseEscrow` | Client releases funds to provider's ATA. |
| `cancelEscrow` | Client cancels and refunds to client's ATA. |

**Account:** `Escrow` struct with client, provider, jobId, amount, bump.

**Error:** `UnauthorizedClient` (6000).

**Deployed on Solana Devnet** at `H3ETmNRWqkfFZmiZio2KsKpuntZ1X3awUwY8QUiGVAqA`.

---

## What Is Missing / Incomplete

### Critical Missing Pieces

| Gap | Details |
|-----|---------|
| **No Solana program source code** | The Anchor Rust smart contract source (`anchor/` directory) is **not in this repository**. Only the compiled IDL is embedded as a JSON string in `solana_client.py`. You cannot re-build or re-deploy the contract from this repo. |
| **No test suite** | No unit tests, integration tests, or e2e tests exist anywhere in the project (backend or frontend). |
| **No CI/CD pipeline** | No GitHub Actions, GitLab CI, or similar configuration. Only a `Dockerfile` and `vercel.json` for manual deployment. |
| **No `in_progress` transition endpoint** | Job status can be set to "funded" but there is no API endpoint to transition a job from "funded" to "in_progress" (when provider begins work). The model supports `in_progress` but it's never set by any route. |

### Functional Gaps

| Gap | Details |
|-----|---------|
| **No WebSocket / real-time messaging** | Messages use REST polling. No Socket.IO, WebSocket, or Server-Sent Events for live chat. Users must refresh to see new messages. |
| **No push notifications** | Only email notifications via Brevo. No browser push notifications, SMS, or in-app mobile notifications. |
| **No PWA service worker** | Frontend is configured as a Vite PWA but no `service-worker.js` or workbox config is present for offline support. |
| **Scope amendments are off-chain only** | When a scope amendment changes the job price, it does **not** adjust the on-chain escrowed USDC amount. The escrow contract has no `adjustEscrow` instruction. |
| **Dispute resolution doesn't execute on-chain** | When a dispute is resolved (e.g. "refund" or "release"), the backend does **not** trigger the corresponding Solana `cancelEscrow` or `releaseEscrow` instruction. The escrow funds remain locked until manually released. |
| **No automated escrow release on completion** | The release is initiated by the client clicking "release" — there's no mechanism for automatic release after a timer or provider confirmation. |
| **No frontend for jury system** | The backend has jury selection and voting endpoints, but there's no frontend page/component for jury members to view/vote on disputes. |
| **No frontend wallet creation UX** | User wallet is generated server-side on registration. The frontend doesn't show the user their public key or allow them to export/backup their private key. |
| **No frontend balance display** | The `/users/me/balance` endpoint exists but there's no frontend component showing the user's SOL/USDC balance. |
| **No frontend scope amendment UI** | Scope amendment endpoints exist but no frontend UI to propose or accept amendments. |
| **No frontend application management** | Providers can apply (backend endpoint exists) but there's no dedicated applications management UI on the frontend. |
| **No frontend dispute flow** | Users can raise disputes via backend but the frontend likely lacks full dispute workflow (raise, jury selection, voting). |

### Code Quality / Architectural Concerns

| Issue | Details |
|------|---------|
| **Hardcoded NGN (Naira) currency** | The platform assumes Nigerian Naira for prices throughout but uses USDC for on-chain settlement. Exchange rate endpoint exists for conversion but currency is not configurable. |
| **Embedded IDL in source code** | The Solana program IDL is a hardcoded JSON string in `solana_client.py` (line 110). This makes upgrades fragile — requires a code deploy to update the contract interface. |
| **Legacy naming ("baros")** | The IDL references `baros_escrow` (original project name) but the current project is "Gigr". Program ID env var accepts both `GIGR_PROGRAM_ID` and `BAROS_PROGRAM_ID`. |
| **Singleton Solana client** | `_program`, `_client`, `_payer` are module-level globals with no connection pooling or lifecycle management for production use. |
| **No database migrations** | No Alembic or similar migration tool configured. Schema changes require manual SQL or wiping the DB (`wipe_db.py` exists). |
| **CORS origins hardcoded** | Development URLs are hardcoded in `main.py`. Production URL is read from `FRONTEND_URL` env var (optional). |
| **No rate limiting** | No rate limiting on auth, job creation, or other endpoints — potential for abuse. |
| **No input sanitization** | User-provided content (job descriptions, messages) is stored as-is without sanitization. |
| **Secret key in JS bundle** | `VITE_GOOGLE_CLIENT_ID` and `VITE_CLOUDINARY_*` keys are exposed in the frontend build. |

### Documentation Gaps

| Gap | Details |
|-----|---------|
| **No API documentation beyond auto-generated** | Only the auto-generated `types/api.ts` describes the API. No Postman collection, OpenAPI spec export, or markdown API docs. |
| **No deployment guide** | `README.md` covers local dev setup but has no guide for deploying to production (Render, Northflank, etc.). |
| **No architecture diagram** | No visual diagram of system architecture, data flow, or smart contract interaction. |

### DevOps / Operations

| Gap | Details |
|-----|---------|
| **No database migration tooling** | `wipe_db.py` exists for development but no Alembic/ Flyway for production schema migrations. |
| **No health check endpoint** | No `/health` or `/api/v1/health` for load balancers/monitoring. |
| **No structured logging** | Uses Python `logging` with basic config. No structured JSON logging or log aggregation setup. |
| **No monitoring/alerting** | No Sentry, DataDog, or similar error tracking. |
| **No database backup script** | No automated backup strategy for PostgreSQL. |
| **No secrets management** | Relies on `.env` files. No HashiCorp Vault, AWS Secrets Manager, or similar. |