# SpeakUp

SpeakUp is a mobile-friendly English-practice starter app. It includes account registration and login, learner profiles, partner discovery and requests, nationwide quick matching, private one-to-one voice calls, topic-based group practice rooms with text chat, daily speaking prompts, protected one-to-one text chat, community reporting/blocking, an on-device demo tutor, browser speech input/output where supported, vocabulary, and local practice progress.

## Run locally

1. Install [Node.js](https://nodejs.org/) 20 or newer.
2. In this folder, run `npm start`.
3. Open [http://localhost:3000](http://localhost:3000).
4. Create accounts in separate browsers or browser profiles to try partner requests and chat.

To run the backend tests, run `npm test`.

## What is and isn't connected

- Sign-up, login, profile changes, partner requests, chat messages, blocks, and reports use the Node server. Passwords are stored as PBKDF2 hashes, session cookies are HTTP-only, and account data is kept in `data/store.json`.
- Learners who are signed in, have enabled availability, and have sent a heartbeat within the last 45 seconds appear online in partner search. Quick Match pairs online learners across the nationwide pool. The home screen's Start Human Call button quick-matches a learner and starts a private one-to-one voice call; online partner cards also have a Call now button, and accepted partner chats can start calls. Call signaling stays in the Node server's memory; unanswered calls expire after 45 seconds, and calls end when a participant hangs up, declines, logs out, or the server restarts. Group rooms support up to 8 learners in a shared topic-based text conversation, and close after 2 hours of inactivity.
- The tutor is a small local demo with fixed conversation prompts and a few example grammar tips. It is **not** a cloud AI model. Its conversations and practice history stay in the browser.
- To enable real AI replies, set `OPENAI_API_KEY` in the server environment before starting the app. Optionally set `OPENAI_MODEL` (defaults to `gpt-4o-mini`). The key is read only by the server; signed-in learners' tutor messages are sent to the configured OpenAI API for replies. Without the key, the app uses its clearly labeled local demo.
- Voice input and spoken replies use browser speech features when available. Browser permission and support are required; the app does not claim to score pronunciation.
- Voice calls require microphone permission and a secure browser context (HTTPS in a deployed app; localhost works for development). The app uses a public STUN server for direct peer connections. Some networks require a TURN relay; configure a TURN service before relying on calls in production. Nationwide matching depends on other learners being online and available; the app does not collect location.
- Live group voice calls are not configured; group room text practice works without an external calling service.
- Vocabulary, speaking goals, and AI practice history are stored in browser local storage, so they are specific to that device and browser.

This project is a single-process development starter, not a production deployment. Before opening it to the public, move storage to a managed database, add HTTPS, abuse/rate limiting and moderation operations, configure a real AI provider, and set up a TURN relay for reliable calls across restrictive networks. Keep any provider secrets on the server.
