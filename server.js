const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.SPEAKUP_DATA_DIR || path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const COOKIE_NAME = "speakup_session";
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

function readStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    return { users: [], sessions: [], requests: [], messages: [], reports: [], rooms: [], roomMessages: [] };
  }

  try {
    const stored = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      users: stored.users || [],
      sessions: stored.sessions || [],
      requests: stored.requests || [],
      messages: stored.messages || [],
      reports: stored.reports || [],
      rooms: stored.rooms || [],
      roomMessages: stored.roomMessages || [],
    };
  } catch (error) {
    throw new Error(`Could not read ${STORE_FILE}: ${error.message}`);
  }
}

let store = readStore();

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, STORE_FILE);
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return ["", ""];
      return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }).filter(([key]) => key),
  );
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_000) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    const error = new Error("Please send valid JSON.");
    error.status = 400;
    throw error;
  }
}

function cleanText(value, maxLength = 160) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeUser(user) {
  const { id, name, level, language, interests, goal, available, photo, createdAt } = user;
  return { id, name, level, language, interests, goal, available, photo, createdAt };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const actual = crypto.pbkdf2Sync(password, user.salt, 120_000, 32, "sha256");
  const expected = Buffer.from(user.passwordHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sessionUser(request) {
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  const session = store.sessions.find((entry) => entry.token === token && entry.expiresAt > Date.now());
  return session ? store.users.find((user) => user.id === session.userId) : null;
}

function setSession(response, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  store.sessions = store.sessions.filter((session) => session.expiresAt > Date.now());
  store.sessions.push({ token, userId, expiresAt: Date.now() + SESSION_TTL });
  saveStore();
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
}

function clearSession(request, response) {
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  store.sessions = store.sessions.filter((session) => session.token !== token);
  saveStore();
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function samePair(first, second, left, right) {
  return (first === left && second === right) || (first === right && second === left);
}

function publicMessage(message) {
  return { id: message.id, senderId: message.senderId, text: message.text, createdAt: message.createdAt };
}

function pruneRooms() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const expiredIds = new Set(store.rooms.filter((room) => new Date(room.lastActivityAt || room.createdAt).getTime() < cutoff).map((room) => room.id));
  if (!expiredIds.size) return;
  store.rooms = store.rooms.filter((room) => !expiredIds.has(room.id));
  store.roomMessages = store.roomMessages.filter((message) => !expiredIds.has(message.roomId));
  saveStore();
}

function createServer() {
  const calls = new Map();
  const presence = new Map();
  const PRESENCE_TTL = 45_000;
  const removeExpiredPresence = () => {
    const now = Date.now();
    for (const [token, lastSeen] of presence) {
      const session = store.sessions.find((entry) => entry.token === token && entry.expiresAt > now);
      if (!session || now - lastSeen > PRESENCE_TTL) presence.delete(token);
    }
  };
  const isOnline = (userId) => {
    removeExpiredPresence();
    const now = Date.now();
    return store.users.some((entry) => entry.id === userId && entry.available) &&
      store.sessions.some((session) => session.userId === userId && session.expiresAt > now && presence.has(session.token));
  };
  const expireCalls = () => {
    const now = Date.now();
    for (const [id, call] of calls) {
      if (call.status === "ringing" && now - call.createdAt > 45_000) {
        call.status = "ended";
        call.reason = "unanswered";
        call.endedAt = now;
      } else if (call.status === "accepted" && now - call.createdAt > 2 * 60 * 60 * 1000) {
        call.status = "ended";
        call.reason = "expired";
        call.endedAt = now;
      } else if (call.endedAt && now - call.endedAt > 2 * 60 * 1000) {
        calls.delete(id);
      }
    }
  };
  const callView = (call, userId) => ({
    id: call.id,
    conversationId: call.conversationId,
    status: call.status,
    callerId: call.callerId,
    calleeId: call.calleeId,
    peer: safeUser(store.users.find((entry) => entry.id === (call.callerId === userId ? call.calleeId : call.callerId))),
    offer: call.offer,
    answer: call.answer,
    candidates: call.candidates,
    reason: call.reason,
  });

  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const method = request.method;

    if (pathname.startsWith("/api/")) {
      try {
        if (method === "POST" && pathname === "/api/register") {
          const body = await readJson(request);
          const name = cleanText(body.name, 40);
          const email = cleanText(body.email, 254).toLowerCase();
          const password = typeof body.password === "string" ? body.password : "";
          if (name.length < 2) return sendJson(response, 400, { error: "Name must have at least 2 characters." });
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(response, 400, { error: "Enter a valid email address." });
          if (password.length < 8 || password.length > 128) return sendJson(response, 400, { error: "Password must be 8–128 characters." });
          if (store.users.some((user) => user.email === email)) return sendJson(response, 409, { error: "An account with this email already exists." });

          const credentials = hashPassword(password);
          const user = {
            id: crypto.randomUUID(),
            name,
            email,
            ...credentials,
            passwordHash: credentials.hash,
            level: ["Beginner", "Intermediate", "Advanced"].includes(body.level) ? body.level : "Beginner",
            language: cleanText(body.language, 40) || "Hindi",
            interests: cleanText(body.interests, 120),
            goal: cleanText(body.goal, 120) || "Speak with more confidence",
            available: true,
            photo: "",
            createdAt: new Date().toISOString(),
          };
          delete user.hash;
          store.users.push(user);
          setSession(response, user.id);
          return sendJson(response, 201, { user: safeUser(user) });
        }

        if (method === "POST" && pathname === "/api/login") {
          const body = await readJson(request);
          const email = cleanText(body.email, 254).toLowerCase();
          const user = store.users.find((entry) => entry.email === email);
          if (!user || typeof body.password !== "string" || !verifyPassword(body.password, user)) {
            return sendJson(response, 401, { error: "Email or password is incorrect." });
          }
          setSession(response, user.id);
          return sendJson(response, 200, { user: safeUser(user) });
        }

        const user = sessionUser(request);
        const sessionToken = parseCookies(request.headers.cookie)[COOKIE_NAME];
        if (method === "GET" && pathname === "/api/me") {
          return user
            ? sendJson(response, 200, { user: safeUser(user) })
            : sendJson(response, 401, { error: "Please sign in to continue." });
        }
        if (method === "POST" && pathname === "/api/logout") {
          if (sessionToken) presence.delete(sessionToken);
          if (user) {
            for (const call of calls.values()) {
              if ((call.callerId === user.id || call.calleeId === user.id) && call.status !== "ended") {
                call.status = "ended";
                call.reason = "ended";
                call.endedAt = Date.now();
              }
            }
          }
          clearSession(request, response);
          return sendJson(response, 200, { ok: true });
        }
        if (method === "GET" && pathname === "/api/tutor/status") {
          return sendJson(response, 200, { configured: Boolean(process.env.OPENAI_API_KEY) });
        }
        if (!user) return sendJson(response, 401, { error: "Please sign in to continue." });

        if (method === "POST" && pathname === "/api/presence") {
          removeExpiredPresence();
          if (!user.available) return sendJson(response, 409, { error: "Turn on your partner availability to appear online." });
          presence.set(sessionToken, Date.now());
          return sendJson(response, 200, { online: true });
        }
        if (method === "DELETE" && pathname === "/api/presence") {
          if (sessionToken) presence.delete(sessionToken);
          return sendJson(response, 200, { online: false });
        }

        if (method === "GET" && pathname === "/api/calls") {
          expireCalls();
          const userCalls = [...calls.values()].filter((call) => call.callerId === user.id || call.calleeId === user.id);
          const activeCall = userCalls.filter((call) => call.status !== "ended").sort((left, right) => right.createdAt - left.createdAt).at(0);
          const recentlyEnded = userCalls.filter((call) => call.status === "ended" && Date.now() - call.endedAt < 10_000).sort((left, right) => right.endedAt - left.endedAt).at(0);
          const call = activeCall || recentlyEnded;
          return sendJson(response, 200, { call: call ? callView(call, user.id) : null });
        }

        if (method === "POST" && pathname === "/api/calls") {
          expireCalls();
          const body = await readJson(request);
          let conversation;
          let newConnection = false;
          if (typeof body.conversationId === "string") {
            conversation = store.requests.find((entry) =>
              entry.conversationId === body.conversationId &&
              entry.status === "accepted" &&
              (entry.from === user.id || entry.to === user.id),
            );
          } else if (typeof body.partnerId === "string") {
            const partner = store.users.find((entry) => entry.id === body.partnerId && entry.id !== user.id && entry.available);
            if (!partner || !isOnline(partner.id)) return sendJson(response, 404, { error: "That learner is no longer online." });
            if (store.reports.some((entry) => entry.type === "block" && samePair(entry.reporterId, entry.targetId, user.id, partner.id))) {
              return sendJson(response, 403, { error: "Calls with this learner are blocked." });
            }
            conversation = store.requests.find((entry) =>
              entry.status === "accepted" && samePair(entry.from, entry.to, user.id, partner.id),
            );
            if (!conversation) {
              conversation = {
                id: crypto.randomUUID(),
                from: user.id,
                to: partner.id,
                status: "accepted",
                conversationId: crypto.randomUUID(),
                matchType: "direct-call",
                createdAt: new Date().toISOString(),
              };
              newConnection = true;
            }
          } else {
            return sendJson(response, 400, { error: "Choose an online learner or an accepted practice conversation." });
          }
          if (!conversation) return sendJson(response, 404, { error: "This practice conversation is not available for calls." });
          const peerId = conversation.from === user.id ? conversation.to : conversation.from;
          if (store.reports.some((entry) => entry.type === "block" && samePair(entry.reporterId, entry.targetId, user.id, peerId))) {
            return sendJson(response, 403, { error: "Calls with this learner are blocked." });
          }
          if ([...calls.values()].some((call) => call.status !== "ended" && [call.callerId, call.calleeId].some((id) => id === user.id || id === peerId))) {
            return sendJson(response, 409, { error: "Finish your current voice call before starting another." });
          }
          if (newConnection) store.requests.push(conversation);
          const call = {
            id: crypto.randomUUID(),
            conversationId: conversation.conversationId,
            callerId: user.id,
            calleeId: peerId,
            status: "ringing",
            createdAt: Date.now(),
            offer: null,
            answer: null,
            candidates: [],
            reason: "",
            endedAt: 0,
          };
          calls.set(call.id, call);
          if (newConnection) saveStore();
          return sendJson(response, 201, { call: callView(call, user.id), request: conversation });
        }

        const callMatch = pathname.match(/^\/api\/calls\/([0-9a-f-]+)(?:\/(signals|action))?$/i);
        if (callMatch) {
          expireCalls();
          const call = calls.get(callMatch[1]);
          if (!call || (call.callerId !== user.id && call.calleeId !== user.id)) {
            return sendJson(response, 404, { error: "Voice call not found." });
          }
          const endpoint = callMatch[2];
          if (method === "GET" && !endpoint) return sendJson(response, 200, { call: callView(call, user.id) });
          if (method === "POST" && endpoint === "action") {
            const body = await readJson(request);
            if (body.action === "accept") {
              if (call.calleeId !== user.id || call.status !== "ringing") return sendJson(response, 409, { error: "This call can no longer be accepted." });
              call.status = "accepted";
            } else if (body.action === "decline") {
              if (call.calleeId !== user.id || call.status !== "ringing") return sendJson(response, 409, { error: "This call can no longer be declined." });
              call.status = "ended";
              call.reason = "declined";
              call.endedAt = Date.now();
            } else if (body.action === "end") {
              call.status = "ended";
              call.reason = "ended";
              call.endedAt = Date.now();
            } else {
              return sendJson(response, 400, { error: "Choose accept, decline, or end." });
            }
            return sendJson(response, 200, { call: callView(call, user.id) });
          }
          if (method === "POST" && endpoint === "signals") {
            if (call.status === "ended") return sendJson(response, 409, { error: "This voice call has ended." });
            const body = await readJson(request);
            if (body.type === "offer" || body.type === "answer") {
              const expectedType = body.type;
              const expectedUser = expectedType === "offer" ? call.callerId : call.calleeId;
              const allowedStatus = expectedType === "offer" ? "ringing" : "accepted";
              if (user.id !== expectedUser || call.status !== allowedStatus) return sendJson(response, 403, { error: "This call signal is not allowed." });
              const description = body.description;
              if (!description || description.type !== expectedType || typeof description.sdp !== "string" || !description.sdp.trim() || description.sdp.length > 20_000) {
                return sendJson(response, 400, { error: "The voice call description is invalid." });
              }
              call[expectedType] = { type: description.type, sdp: description.sdp };
            } else if (body.type === "candidate") {
              const candidate = body.candidate;
              if (call.status !== "ringing" && call.status !== "accepted") return sendJson(response, 409, { error: "This voice call is not active." });
              if (!candidate || typeof candidate.candidate !== "string" || !candidate.candidate || candidate.candidate.length > 2_000 ||
                  !(candidate.sdpMid === null || typeof candidate.sdpMid === "string") ||
                  !(candidate.sdpMLineIndex === null || Number.isInteger(candidate.sdpMLineIndex)) ||
                  call.candidates.length >= 200) {
                return sendJson(response, 400, { error: "The voice call network candidate is invalid or the call has too many candidates." });
              }
              call.candidates.push({
                id: crypto.randomUUID(),
                senderId: user.id,
                candidate: {
                  candidate: candidate.candidate,
                  sdpMid: candidate.sdpMid,
                  sdpMLineIndex: candidate.sdpMLineIndex,
                },
              });
            } else {
              return sendJson(response, 400, { error: "Choose a valid voice call signal." });
            }
            return sendJson(response, 200, { ok: true });
          }
          return sendJson(response, 405, { error: "Method not allowed." });
        }

        if (method === "POST" && pathname === "/api/tutor") {
          if (!process.env.OPENAI_API_KEY) return sendJson(response, 503, { error: "Real AI is not configured. The local practice tutor is still available." });
          const body = await readJson(request);
          const allowedTopics = ["Everyday conversation", "Meeting someone new", "Travel and holidays", "Work and career", "Job interview", "Food and shopping"];
          if (!allowedTopics.includes(body.topic)) return sendJson(response, 400, { error: "Choose a valid conversation topic." });
          if (!["Beginner", "Intermediate", "Advanced"].includes(body.level)) return sendJson(response, 400, { error: "Choose a valid English level." });
          if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 20) return sendJson(response, 400, { error: "Send between 1 and 20 conversation messages." });
          const messages = body.messages.map((message) => {
            if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim() || message.content.length > 1500) {
              return null;
            }
            return { role: message.role, content: message.content.trim() };
          });
          if (messages.some((message) => !message) || messages.at(-1).role !== "user") return sendJson(response, 400, { error: "Conversation messages are invalid." });
          let providerResponse;
          try {
            providerResponse = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                messages: [
                  {
                    role: "system",
                    content: `You are a patient, encouraging spoken-English tutor. The learner's level is ${body.level}; the topic is ${body.topic}. Speak naturally using vocabulary and sentence length appropriate to that level. Reply in friendly, clear English. Gently correct at most one important error without shaming the learner, then ask one relevant follow-up question. Never claim you heard pronunciation or analyzed audio because this chat contains text only.`,
                  },
                  ...messages,
                ],
                temperature: 0.7,
                max_tokens: 350,
              }),
              signal: AbortSignal.timeout(20_000),
            });
          } catch (error) {
            console.error("AI provider request failed:", error.message);
            return sendJson(response, 502, { error: "The AI service could not be reached. Please try again shortly." });
          }
          if (!providerResponse.ok) {
            console.error("AI provider returned HTTP", providerResponse.status);
            return sendJson(response, 502, { error: "The AI service could not complete this reply. Please try again." });
          }
          let providerResult;
          try {
            providerResult = await providerResponse.json();
          } catch {
            return sendJson(response, 502, { error: "The AI service returned an invalid reply. Please try again." });
          }
          const reply = providerResult.choices?.[0]?.message?.content;
          if (typeof reply !== "string" || !reply.trim()) return sendJson(response, 502, { error: "The AI service returned an empty reply. Please try again." });
          return sendJson(response, 200, { reply: reply.trim().slice(0, 4000) });
        }

        if (method === "PATCH" && pathname === "/api/profile") {
          const body = await readJson(request);
          for (const field of ["name", "level", "language", "interests", "goal", "photo", "available"]) {
            if (body[field] !== undefined && !["string", "boolean"].includes(typeof body[field])) {
              return sendJson(response, 400, { error: `${field} must be a string or boolean.` });
            }
          }
          if (body.name !== undefined && cleanText(body.name, 40).length < 2) return sendJson(response, 400, { error: "Name must have at least 2 characters." });
          if (body.level !== undefined && !["Beginner", "Intermediate", "Advanced"].includes(body.level)) return sendJson(response, 400, { error: "Choose a valid English level." });
          if (body.photo && !/^https:\/\/[^\s]{1,500}$/i.test(body.photo)) return sendJson(response, 400, { error: "Profile photo must be a secure HTTPS URL." });
          if (body.name !== undefined) user.name = cleanText(body.name, 40);
          if (body.level !== undefined) user.level = body.level;
          if (body.language !== undefined) user.language = cleanText(body.language, 40);
          if (body.interests !== undefined) user.interests = cleanText(body.interests, 120);
          if (body.goal !== undefined) user.goal = cleanText(body.goal, 120);
          if (body.photo !== undefined) user.photo = cleanText(body.photo, 500);
          if (body.available !== undefined) {
            if (typeof body.available !== "boolean") return sendJson(response, 400, { error: "Availability must be true or false." });
            user.available = body.available;
          }
          saveStore();
          return sendJson(response, 200, { user: safeUser(user) });
        }

        if (method === "DELETE" && pathname === "/api/account") {
          const conversations = new Set(store.requests.filter((entry) => entry.from === user.id || entry.to === user.id).map((entry) => entry.conversationId).filter(Boolean));
          for (const [id, call] of calls) {
            if (call.callerId === user.id || call.calleeId === user.id) calls.delete(id);
          }
          store.users = store.users.filter((entry) => entry.id !== user.id);
          store.sessions = store.sessions.filter((entry) => entry.userId !== user.id);
          store.requests = store.requests.filter((entry) => entry.from !== user.id && entry.to !== user.id);
          store.messages = store.messages.filter((entry) => !conversations.has(entry.conversationId));
          const hostedRooms = new Set(store.rooms.filter((room) => room.hostId === user.id && room.members.length === 1).map((room) => room.id));
          store.rooms = store.rooms.filter((room) => !hostedRooms.has(room.id));
          for (const room of store.rooms) {
            room.members = room.members.filter((memberId) => memberId !== user.id);
            if (room.hostId === user.id) room.hostId = room.members[0];
          }
          store.roomMessages = store.roomMessages.filter((message) => !hostedRooms.has(message.roomId) && message.senderId !== user.id);
          store.reports = store.reports.filter((entry) => entry.reporterId !== user.id && entry.targetId !== user.id);
          saveStore();
          response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
          return sendJson(response, 200, { ok: true });
        }

        if (method === "GET" && pathname === "/api/partners") {
          removeExpiredPresence();
          const blockedIds = new Set(store.reports.filter((entry) => entry.type === "block" && (entry.reporterId === user.id || entry.targetId === user.id)).flatMap((entry) => [entry.reporterId, entry.targetId]));
          const search = new URL(request.url, "http://localhost").searchParams;
          const partners = store.users.filter((entry) =>
            entry.id !== user.id && isOnline(entry.id) && !blockedIds.has(entry.id) &&
            (!search.get("level") || entry.level === search.get("level")) &&
            (!search.get("q") || `${entry.name} ${entry.interests}`.toLowerCase().includes(search.get("q").toLowerCase())),
          ).map(safeUser);
          return sendJson(response, 200, { partners });
        }

        if (method === "POST" && pathname === "/api/quick-match") {
          if (!user.available) return sendJson(response, 409, { error: "Turn on your partner availability in your profile first." });
          const blockedIds = new Set(store.reports.filter((entry) => entry.type === "block" && (entry.reporterId === user.id || entry.targetId === user.id)).flatMap((entry) => [entry.reporterId, entry.targetId]));
          const existingPartners = new Set(store.requests.filter((entry) => entry.status === "accepted" || entry.status === "pending").filter((entry) => entry.from === user.id || entry.to === user.id).map((entry) => entry.from === user.id ? entry.to : entry.from));
          const busyIds = new Set(store.requests.filter((entry) => entry.status === "accepted" || entry.status === "pending").flatMap((entry) => [entry.from, entry.to]));
          const candidates = store.users.filter((entry) =>
            entry.id !== user.id &&
            isOnline(entry.id) &&
            !busyIds.has(entry.id) &&
            !blockedIds.has(entry.id) &&
            !existingPartners.has(entry.id) &&
            !store.reports.some((report) => report.type === "block" && samePair(report.reporterId, report.targetId, user.id, entry.id)),
          );
          if (!candidates.length) return sendJson(response, 404, { error: "No available learner is ready for a quick match right now." });
          const partner = candidates[crypto.randomInt(candidates.length)];
          const practiceRequest = {
            id: crypto.randomUUID(),
            from: user.id,
            to: partner.id,
            status: "accepted",
            conversationId: crypto.randomUUID(),
            matchType: "quick",
            createdAt: new Date().toISOString(),
          };
          store.requests.push(practiceRequest);
          saveStore();
          return sendJson(response, 201, { request: practiceRequest, partner: safeUser(partner) });
        }

        if (method === "GET" && pathname === "/api/rooms") {
          pruneRooms();
          const rooms = store.rooms.filter((room) => room.members.length < room.maxMembers || room.members.includes(user.id)).map((room) => ({
            id: room.id,
            name: room.name,
            topic: room.topic,
            memberCount: room.members.length,
            maxMembers: room.maxMembers,
            joined: room.members.includes(user.id),
            host: safeUser(store.users.find((entry) => entry.id === room.hostId)),
          }));
          return sendJson(response, 200, { rooms });
        }

        if (method === "POST" && pathname === "/api/rooms") {
          const body = await readJson(request);
          const name = cleanText(body.name, 50);
          const topic = cleanText(body.topic, 120);
          if (name.length < 3) return sendJson(response, 400, { error: "Room name must have at least 3 characters." });
          if (topic.length < 3) return sendJson(response, 400, { error: "Enter a speaking topic for your room." });
          const room = {
            id: crypto.randomUUID(),
            name,
            topic,
            hostId: user.id,
            members: [user.id],
            maxMembers: 8,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
          };
          store.rooms.push(room);
          saveStore();
          return sendJson(response, 201, { room: { id: room.id, name: room.name, topic: room.topic, memberCount: 1, maxMembers: room.maxMembers, joined: true, host: safeUser(user) } });
        }

        const roomMatch = pathname.match(/^\/api\/rooms\/([0-9a-f-]+)$/i);
        if (roomMatch && method === "POST") {
          pruneRooms();
          const room = store.rooms.find((entry) => entry.id === roomMatch[1]);
          if (!room) return sendJson(response, 404, { error: "Practice room not found or it has closed." });
          if (!room.members.includes(user.id) && room.members.length >= room.maxMembers) return sendJson(response, 409, { error: "This practice room is full." });
          if (!room.members.includes(user.id)) room.members.push(user.id);
          room.lastActivityAt = new Date().toISOString();
          saveStore();
          return sendJson(response, 200, { room: { id: room.id, name: room.name, topic: room.topic, memberCount: room.members.length, maxMembers: room.maxMembers, joined: true, host: safeUser(store.users.find((entry) => entry.id === room.hostId)) } });
        }

        const roomChatMatch = pathname.match(/^\/api\/rooms\/([0-9a-f-]+)\/messages$/i);
        if (roomChatMatch) {
          const room = store.rooms.find((entry) => entry.id === roomChatMatch[1] && entry.members.includes(user.id));
          if (!room) return sendJson(response, 404, { error: "Join this practice room before opening its chat." });
          if (method === "GET") {
            return sendJson(response, 200, {
              room: { id: room.id, name: room.name, topic: room.topic, memberCount: room.members.length, maxMembers: room.maxMembers },
              messages: store.roomMessages.filter((entry) => entry.roomId === room.id).slice(-100).map((entry) => ({
                id: entry.id,
                senderId: entry.senderId,
                senderName: entry.senderName,
                text: entry.text,
                createdAt: entry.createdAt,
              })),
            });
          }
          if (method === "POST") {
            const body = await readJson(request);
            const text = cleanText(body.text, 2000);
            if (!text) return sendJson(response, 400, { error: "Write a message before sending." });
            const message = { id: crypto.randomUUID(), roomId: room.id, senderId: user.id, senderName: user.name, text, createdAt: new Date().toISOString() };
            store.roomMessages.push(message);
            room.lastActivityAt = message.createdAt;
            saveStore();
            return sendJson(response, 201, { message });
          }
        }

        const roomLeaveMatch = pathname.match(/^\/api\/rooms\/([0-9a-f-]+)\/leave$/i);
        if (roomLeaveMatch && method === "POST") {
          const roomIndex = store.rooms.findIndex((entry) => entry.id === roomLeaveMatch[1]);
          if (roomIndex < 0) return sendJson(response, 404, { error: "Practice room not found." });
          const room = store.rooms[roomIndex];
          if (!room.members.includes(user.id)) return sendJson(response, 404, { error: "You haven't joined this practice room." });
          room.members = room.members.filter((id) => id !== user.id);
          if (room.members.length === 0) {
            store.rooms.splice(roomIndex, 1);
            store.roomMessages = store.roomMessages.filter((entry) => entry.roomId !== room.id);
          } else if (room.hostId === user.id) {
            room.hostId = room.members[0];
          }
          saveStore();
          return sendJson(response, 200, { ok: true });
        }

        if (method === "GET" && pathname === "/api/requests") {
          return sendJson(response, 200, {
            requests: store.requests.filter((entry) => entry.to === user.id || entry.from === user.id).map((entry) => ({
              ...entry,
              partner: safeUser(store.users.find((other) => other.id === (entry.from === user.id ? entry.to : entry.from))),
            })),
          });
        }

        if (method === "POST" && pathname === "/api/requests") {
          const body = await readJson(request);
          const partner = store.users.find((entry) => entry.id === body.partnerId && entry.available);
          if (!partner || partner.id === user.id) return sendJson(response, 404, { error: "That practice partner is not available." });
          if (store.reports.some((entry) => entry.type === "block" && samePair(entry.reporterId, entry.targetId, user.id, partner.id))) return sendJson(response, 403, { error: "This user is blocked." });
          const existing = store.requests.find((entry) => entry.status === "pending" && samePair(entry.from, entry.to, user.id, partner.id));
          if (existing) return sendJson(response, 409, { error: "A practice request is already waiting." });
          const practiceRequest = { id: crypto.randomUUID(), from: user.id, to: partner.id, status: "pending", createdAt: new Date().toISOString() };
          store.requests.push(practiceRequest);
          saveStore();
          return sendJson(response, 201, { request: practiceRequest });
        }

        const requestMatch = pathname.match(/^\/api\/requests\/([0-9a-f-]+)$/i);
        if (method === "PATCH" && requestMatch) {
          const body = await readJson(request);
          const entry = store.requests.find((item) => item.id === requestMatch[1] && item.to === user.id);
          if (!entry || entry.status !== "pending") return sendJson(response, 404, { error: "That request is no longer waiting." });
          if (!["accepted", "declined"].includes(body.status)) return sendJson(response, 400, { error: "Choose accept or decline." });
          entry.status = body.status;
          if (body.status === "accepted") entry.conversationId = crypto.randomUUID();
          saveStore();
          return sendJson(response, 200, { request: entry });
        }

        const chatMatch = pathname.match(/^\/api\/chat\/([0-9a-f-]+)$/i);
        if (chatMatch) {
          const requestEntry = store.requests.find((entry) => entry.conversationId === chatMatch[1] && entry.status === "accepted" && (entry.from === user.id || entry.to === user.id));
          if (!requestEntry) return sendJson(response, 404, { error: "Conversation not found." });
          if (method === "GET") {
            return sendJson(response, 200, { messages: store.messages.filter((entry) => entry.conversationId === chatMatch[1]).map(publicMessage) });
          }
          if (method === "POST") {
            const body = await readJson(request);
            const text = cleanText(body.text, 2000);
            if (!text) return sendJson(response, 400, { error: "Write a message before sending." });
            const message = { id: crypto.randomUUID(), conversationId: chatMatch[1], senderId: user.id, text, createdAt: new Date().toISOString() };
            store.messages.push(message);
            saveStore();
            return sendJson(response, 201, { message: publicMessage(message) });
          }
        }

        if (method === "POST" && pathname === "/api/report") {
          const body = await readJson(request);
          const target = store.users.find((entry) => entry.id === body.targetId && entry.id !== user.id);
          if (!target || !["report", "block"].includes(body.type)) return sendJson(response, 400, { error: "Choose a valid user and action." });
          store.reports.push({ id: crypto.randomUUID(), reporterId: user.id, targetId: target.id, type: body.type, reason: cleanText(body.reason, 300), createdAt: new Date().toISOString() });
          if (body.type === "block") {
            const blockedConversations = new Set(store.requests.filter((entry) => samePair(entry.from, entry.to, user.id, target.id)).map((entry) => entry.conversationId).filter(Boolean));
            for (const call of calls.values()) {
              if (samePair(call.callerId, call.calleeId, user.id, target.id) && call.status !== "ended") {
                call.status = "ended";
                call.reason = "blocked";
                call.endedAt = Date.now();
              }
            }
            store.requests = store.requests.filter((entry) => !samePair(entry.from, entry.to, user.id, target.id));
            store.messages = store.messages.filter((entry) => !blockedConversations.has(entry.conversationId));
          }
          saveStore();
          return sendJson(response, 201, { ok: true });
        }

        return sendJson(response, 404, { error: "API route not found." });
      } catch (error) {
        console.error("API request failed:", error);
        return sendJson(response, error.status || 500, { error: error.status ? error.message : "Something went wrong. Please try again." });
      }
    }

    if (method !== "GET" && method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed." });
    let requestedPath;
    try {
      requestedPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    } catch {
      return sendJson(response, 400, { error: "Invalid page path." });
    }
    const filePath = path.resolve(PUBLIC_DIR, requestedPath);
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
      return sendJson(response, 403, { error: "Forbidden." });
    }
    fs.readFile(filePath, (error, content) => {
      if (error) return sendJson(response, 404, { error: "Page not found." });
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
      response.writeHead(200, {
        "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' https: data:; connect-src 'self';",
        "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=3600",
      });
      if (method === "HEAD") response.end();
      else response.end(content);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`SpeakUp is running at http://localhost:${port}`));
}

module.exports = { createServer };
