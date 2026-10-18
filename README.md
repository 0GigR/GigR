# Gigr: Verifiable Trust for Local Work

Gigr is a hyper-local services marketplace with a cryptographically secured trust and escrow layer. It solves the dual-sided trust deficit in the informal economy:
- **Clients** hold money securely in an on-chain escrow until the job is completed to satisfaction.
- **Providers** get guaranteed payment without risk of non-payment, and build permanent, verifiable reputation.

All blockchain interactions are hidden from the user, providing a Web2-like seamless experience (via mobile or PWA) while maintaining Web3 guarantees.  

---

## 🏗 Architecture

Gigr operates on a split architecture:

- **Frontend**: A Progressive Web App (PWA) built with **React**, **Vite**, **TypeScript**, and **TailwindCSS**. Configured for deployment on **Render** (or Vercel). Uses `react-query` for server state and `zustand` for local auth state. Includes `react-leaflet` for hyper-local Neighborhood Maps.
- **Backend**: A **FastAPI** Python application acting as the orchestrator. Uses **PostgreSQL** + **PostGIS** for database and geospatial proximity queries. Integrates natively with the Solana blockchain using Anchor and `solders`. Configured for deployment on **Northflank** (or Render).
- **Blockchain**: A custom **Solana Anchor Smart Contract** deployed on Devnet that handles atomic escrow funding, releasing, and refunding.
- **Reputation**: Uses the **Underdog Protocol API** to mint compressed NFTs (cNFTs) to provider wallets as "Vouches", acting as on-chain verifiable reputation.

---

## 🚀 Environment Setup

### 1. Backend Setup

The backend relies on PostgreSQL, Solana, and external APIs.

```bash
cd backend
python -m venv venv
# On Windows
venv\Scripts\activate
# On Linux/Mac
source venv/bin/activate

pip install -r requirements.txt
```

**Required Environment Variables (`backend/.env`)**:
```env
ADMIN_SECRET=your_admin_secret_here
#Solana
GIGR_PROGRAM_ID=your_solana_program_id_here

#Emails
BREVO_API_KEY=your_brevo_api_key_here
BREVO_SENDER_EMAIL=your_sender_email@example.com

#Object storage
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name

#Database
DATABASE_URL=postgresql://user:password@host:port/database

#fromtend origin
FRONTEND_URL=http://localhost:5173

#OAuth (google)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Solana
PLATFORM_KEYPAIR="[your, solana, platform, keypair, array]"

#fastapi
SECRET_KEY=your_fastapi_secret_key
SECURE_COOKIES=False

#solana
SOLANA_RPC_URL="https://api.devnet.solana.com" I used helius tho

#cNFTs
UNDERDOG_API_KEY=your_underdog_protocol_api_key
UNDERDOG_API_URL=https://devnet.underdogprotocol.com

#solana
USDC_MINT_DEVNET=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
WALLET_ENCRYPTION_KEY="your_base64_wallet_encryption_key="

#Notifications
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=private_key.pem
VAPID_CLAIM_EMAIL=mailto:admin@example.com

#AI Agent
GROQ_API_KEYS=your_groq_api_key_1,your_groq_api_key_2
GROQ_MODEL=llama-3.1-8b-instant
GROQ_WHISPER_MODEL=whisper-large-v3-turbo
AI_AGENT_ENABLED=true
AI_AGENT_POLL_INTERVAL_SECONDS=30
AI_AGENT_MAX_CONCURRENT_TASKS=5
AI_AGENT_TASK_TIMEOUT_SECONDS=300

#Human verification
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA # Use dummy for testing, real key for production
```

**Run Backend Server**:
```bash
uvicorn app.main:app --reload --port 8000
```

### 2. Frontend Setup

The frontend connects to the backend and external services like Cloudinary.

```bash
cd frontend
npm install
```

**Required Environment Variables (`frontend/.env`)**:
```env
VITE_API_URL=http://localhost:8000/api/v1
VITE_CLOUDINARY_CLOUD_NAME=your_cloudinary_name
VITE_CLOUDINARY_UPLOAD_PRESET=your_preset
VITE_GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
```

**Run Frontend Server**:
```bash
npm run dev
```

**Run WebMCP tool tests** (see [`WEBMCP_TOOLS.md`](WEBMCP_TOOLS.md)):
```bash
npm test
```

---

## 💳 Payment rails

Both payment rails run side by side. A **Solana / PayPal toggle** in the app header (and on the landing page) switches the whole app between them for that browser:

- **Solana**: the original on-chain USDC escrow, wallets and cNFT vouches. This is the original app.
- **PayPal**: the client approves a PayPal payment, it is captured and held, and release pays the provider through PayPal Payouts. Cancels and disputes refund the capture. Jobs can also be paid in stages, one PayPal payment per milestone. Setup: [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md).

A rail is offered when its settings are present: the Solana variables (`GIGR_PROGRAM_ID`, `SOLANA_RPC_URL`, `PLATFORM_KEYPAIR`, `WALLET_ENCRYPTION_KEY`, `USDC_MINT_DEVNET`) and/or the PayPal ones (`PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, optionally `PAYPAL_WEBHOOK_ID`). The toggle shows when both are set.

The frontend sends the choice as an `X-Payment-Rail` header, so the backend uses the matching code for each request. `PAYMENT_RAIL` in `backend/.env` is only the default for visitors who haven't chosen; if it is unset it is `solana` when Solana is configured, otherwise `paypal`. Each job keeps the rail it was funded on, so switching never strands money already in escrow.

See [docs/HACKATHON.md](docs/HACKATHON.md) for the PayPal and AI details.

---

## 💡 Key Features

### 1. Escrow Smart Contract Integration (Solana rail)
The backend securely orchestrates SOL and USDC transactions on behalf of users. When a job is funded, USDC is transferred into a Program Derived Address (PDA). The backend signs the transaction using the client's decrypted base58 keypair.

### 2. Non-Blocking Vouching (cNFTs)
Minting reputation NFTs via the Underdog Protocol can be slow during Devnet congestion. Gigr uses `asyncio.create_task` to handle minting optimistically in the background, keeping the user interface lightning fast.

### 3. Hyper-Local Discoverability
Gigr utilizes PostgreSQL PostGIS features (`ST_DWithin`, `ST_DistanceSphere`) to match clients with providers inside a specified radius, rendering the results visually on a `react-leaflet` map.

### 4. Rich Media & Communication
Users can post jobs with images, showcase service portfolios, and exchange photo attachments within the secure Contract Room messaging system via Cloudinary.

### 5. Google OAuth + Profile Sync
Frictionless onboarding using Google OAuth, which automatically pulls and syncs the user's Google profile picture to their Gigr account.

### 6. Agent-native (WebMCP)
Gigr is **built for humans and their agents together** via [WebMCP](WEBMCP_TOOLS.md). AI agents browsing the app can call structured tools — `search_providers`, `get_provider_reputation`, `post_job`, `fund_escrow`, `release_escrow`, `accept_job`, `send_message`, … — that run in the user's authenticated tab. An agent can find a real provider, verify their on-chain vouches, hire them, fund the Solana escrow and release payment on the user's behalf. Payment tools are only ever **exposed** (registered) while the user is signed in.

---# GigR
# GigR
