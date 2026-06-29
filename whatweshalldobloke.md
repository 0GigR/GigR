### 6. Updated Comprehensive Task List

| # | Area | Priority | Task | Files Involved |
|---|------|----------|------|----------------|
| 1 | **Database** | 🔴 Critical | Fix connection pool exhaustion | `database.py` |
| 2 | **Vouch** | 🔴 Critical | Fix 500 error + pending ID | `vouches.py` |
| 3 | **Amendments** | 🔴 Critical | Fix 422 error (missing field) | `jobs.py` or `amendments.py`, frontend form |
| 4 | **UI: Buttons** | 🟡 High | Add loading/disabled state on all action buttons | `JobsPage.tsx`, `ActivityPage.tsx` |
| 5 | **UI: Messages** | 🟡 High | Send button loading animation | `MessagesPage.tsx` |
| 6 | **UI: Images** | 🟡 High | Add missing image icon in contract room | `JobsPage.tsx`, `ActivityPage.tsx` |
| 7 | **UI: Images** | 🟡 High | Tap image to open full‑screen in app | All pages with images |
| 8 | **UI: Descriptions** | 🟡 High | Add “See more” for long descriptions | `ServicesPage.tsx`, `JobsPage.tsx` |
| 9 | **Public Profile** | 🟡 High | Back navigation + responsive layout | `PublicProfilePage.tsx` |
| 10 | **Jury/Disputes** | 🟡 High | Test with real users (need script) | Backend `init_db` or separate script |
| 11 | **AI Integration** | 🟢 Medium | Dispute summariser via LLM | New endpoint + contract room |
| 12 | **Solana Integration** | 🟢 Medium | Soulbound NFT for identity (Civic Pass) | `users.py`, `civic_client.py` |
| 13 | **Polish** | 🟢 Medium | Timestamps, empty states, dark mode | Multiple |

---

### What to do now

1. Apply the `database.py` and `vouches.py` fixes above and restart the backend.
2. Vouch again and check the terminal for the `[vouches] Underdog result:` print. Send that output to me.
3. Send the requested frontend files so I can give you the exact UI fixes.

After the backend is stable, we’ll knock out all the UI issues in one sweep.