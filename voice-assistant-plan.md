# Gigr AI Agent — Implementation Plan

## Overview
A powerful, background AI assistant for the Gigr marketplace app that lets users navigate, search, post jobs, find providers, and negotiate prices hands-free. The agent runs in the background and logs all its actions so users can review what it did on their behalf. Uses a free Groq LLM API with a robust rule-based fallback.

## Features
- **Background Async Execution**: Tasks are queued to a database and processed by a background worker loop, so the frontend isn't blocked.
- **Negotiation Engine**: The agent can search for services within a budget. If none match, it can automatically message the closest-priced providers to negotiate the price down (if enabled by the user).
- **Consolidated AI Core**: A single `ai.py` backend file and a single `agentStore.ts` frontend file handle all AI logic.
- **Agent Activity Panel**: A sleek slide-in UI panel showing the real-time status (queued/running/completed/failed) and detailed step-by-step logs of all agent tasks.
- **AI Settings Page**: Users can enable/disable the agent globally, toggle the floating microphone button, and opt-in to automatic negotiation messaging.
- **Free NLP**: Uses Groq's free API (`llama3-8b-8192`) for intent parsing, falling back to regex rules if no key is provided.

## Architecture

### Backend (FastAPI + Python)

1. **`backend/app/api/v1/endpoints/ai.py`** (The Core)
   - Parses intent (Groq + fallback rules).
   - Contains async handlers for `search`, `negotiate`, `post_job`, and `navigate`.
   - Runs the `agent_loop()` background task scanner.
   - Exposes REST routes for `POST /command`, `GET /tasks`, `DELETE /tasks/{id}`, `GET /settings`.
2. **Database Models**
   - `AgentTask` (`models/agent_task.py`): Represents a user command (e.g., "Find a plumber for 5k").
   - `AgentLog` (`models/agent_log.py`): Step-by-step audit logs of what the agent did for a task.
3. **Startup Registration**
   - `main.py` starts `asyncio.create_task(agent_loop())` on startup.

### Frontend (React + Zustand + TypeScript)

1. **`frontend/src/store/agentStore.ts`**
   - Centralized Zustand store with persistence.
   - Polls the backend for task updates every N seconds (configurable via `VITE_AI_AGENT_POLL_MS`).
   - Stores AI Settings (negotiation opt-in, voice UI toggle).
2. **`frontend/src/components/agent/AgentActivityPanel.tsx`**
   - Slide-in panel displaying tasks and logs.
3. **`frontend/src/components/agent/AgentBell.tsx`**
   - Header notification icon showing unread agent activity.
4. **`frontend/src/pages/AISettingsPage.tsx`**
   - Dedicated settings page for agent preferences and system status.
5. **`frontend/src/components/VoiceAssistant.tsx`**
   - Floating mic button and text input popup to submit commands.

## Setup Instructions

1. (Optional) Get a free Groq API key from [console.groq.com](https://console.groq.com)
2. Add to `backend/.env`:
   ```env
   GROQ_API_KEY=your_key_here
   AI_AGENT_ENABLED=true
   ```
3. Restart the backend and frontend servers.
4. (Optional) In the frontend UI, go to AI Settings and enable "Allow AI to negotiate".
5. Say or type: "Find a plumber for under 5k and negotiate".