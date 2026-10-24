const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "speakup-test-"));
process.env.SPEAKUP_DATA_DIR = dataDirectory;
delete process.env.OPENAI_API_KEY;
const { createServer } = require("../server");
const server = createServer();
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(dataDirectory, { recursive: true, force: true });
  delete process.env.SPEAKUP_DATA_DIR;
});

async function api(route, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  const setCookie = response.headers.get("set-cookie")?.split(";")[0];
  return { status: response.status, result, cookie: setCookie || cookie };
}

async function markOnline(cookie) {
  return api("/api/presence", { method: "POST", cookie, body: {} });
}

test("accounts keep email private and partners can safely chat and delete their data", async () => {
  const alice = await api("/api/register", {
    method: "POST",
    body: { name: "Alice Learner", email: "alice@example.com", password: "secure-pass-123", level: "Beginner" },
  });
  assert.equal(alice.status, 201);
  assert.equal(alice.result.user.email, undefined);
  assert.equal(alice.result.user.passwordHash, undefined);
  assert.equal(alice.result.user.salt, undefined);

  const bob = await api("/api/register", {
    method: "POST",
    body: { name: "Bob Learner", email: "bob@example.com", password: "secure-pass-456", level: "Intermediate", interests: "Travel" },
  });
  assert.equal(bob.status, 201);
  assert.equal((await markOnline(alice.cookie)).status, 200);
  assert.equal((await markOnline(bob.cookie)).status, 200);

  const invalidLogin = await api("/api/login", { method: "POST", body: { email: "alice@example.com", password: "wrong-password" } });
  assert.equal(invalidLogin.status, 401);

  const found = await api("/api/partners", { cookie: alice.cookie });
  assert.equal(found.status, 200);
  assert.equal(found.result.partners.length, 1);
  assert.equal(found.result.partners[0].email, undefined);

  const sent = await api("/api/requests", { method: "POST", cookie: alice.cookie, body: { partnerId: bob.result.user.id } });
  assert.equal(sent.status, 201);
  const incoming = await api("/api/requests", { cookie: bob.cookie });
  const accepted = await api(`/api/requests/${sent.result.request.id}`, {
    method: "PATCH",
    cookie: bob.cookie,
    body: { status: "accepted" },
  });
  assert.equal(incoming.result.requests[0].partner.name, "Alice Learner");
  assert.equal(accepted.status, 200);

  const sentMessage = await api(`/api/chat/${accepted.result.request.conversationId}`, {
    method: "POST",
    cookie: alice.cookie,
    body: { text: "Hello! What would you like to practice today?" },
  });
  assert.equal(sentMessage.status, 201);
  const readChat = await api(`/api/chat/${accepted.result.request.conversationId}`, { cookie: bob.cookie });
  assert.equal(readChat.result.messages[0].text, "Hello! What would you like to practice today?");

  const blocked = await api("/api/report", {
    method: "POST",
    cookie: bob.cookie,
    body: { targetId: alice.result.user.id, type: "block" },
  });
  assert.equal(blocked.status, 201);
  const blockedChat = await api(`/api/chat/${accepted.result.request.conversationId}`, { cookie: alice.cookie });
  assert.equal(blockedChat.status, 404);

  const deleted = await api("/api/account", { method: "DELETE", cookie: alice.cookie });
  assert.equal(deleted.status, 200);
  const removedChat = await api(`/api/chat/${accepted.result.request.conversationId}`, { cookie: bob.cookie });
  assert.equal(removedChat.status, 404);
  const bobUnavailable = await api("/api/profile", { method: "PATCH", cookie: bob.cookie, body: { available: false } });
  assert.equal(bobUnavailable.status, 200);
  const offlinePartners = await api("/api/partners", { cookie: bob.cookie });
  assert.equal(offlinePartners.result.partners.some((partner) => partner.id === alice.result.user.id), false);
});

test("registration and profile updates validate input", async () => {
  const anonymousLogout = await api("/api/logout", { method: "POST" });
  assert.equal(anonymousLogout.status, 200);

  const tutorStatus = await api("/api/tutor/status");
  assert.equal(tutorStatus.status, 200);
  assert.equal(tutorStatus.result.configured, false);

  const weakPassword = await api("/api/register", {
    method: "POST",
    body: { name: "A", email: "not-an-email", password: "short" },
  });
  assert.equal(weakPassword.status, 400);

  const user = await api("/api/register", {
    method: "POST",
    body: { name: "Casey", email: "casey@example.com", password: "a-safe-password", level: "Beginner" },
  });
  assert.equal(user.status, 201);
  const invalidAvailability = await api("/api/profile", { method: "PATCH", cookie: user.cookie, body: { available: "false" } });
  assert.equal(invalidAvailability.status, 400);
  const invalidPhoto = await api("/api/profile", { method: "PATCH", cookie: user.cookie, body: { photo: "javascript:alert(1)" } });
  assert.equal(invalidPhoto.status, 400);
  const localTutorFallback = await api("/api/tutor", {
    method: "POST",
    cookie: user.cookie,
    body: { topic: "Everyday conversation", level: "Beginner", messages: [{ role: "user", content: "Hello" }] },
  });
  assert.equal(localTutorFallback.status, 503);
  const caseyUnavailable = await api("/api/profile", { method: "PATCH", cookie: user.cookie, body: { available: false } });
  assert.equal(caseyUnavailable.status, 200);
});

test("voice calls are limited to accepted partners and exchange private WebRTC signals", async () => {
  const caller = await api("/api/register", {
    method: "POST",
    body: { name: "Call Caller", email: "caller@example.com", password: "a-safe-password" },
  });
  const callee = await api("/api/register", {
    method: "POST",
    body: { name: "Call Callee", email: "callee@example.com", password: "a-safe-password" },
  });
  const outsider = await api("/api/register", {
    method: "POST",
    body: { name: "Call Outsider", email: "outsider@example.com", password: "a-safe-password" },
  });
  await Promise.all([markOnline(caller.cookie), markOnline(callee.cookie), markOnline(outsider.cookie)]);
  const onlineLearners = await api("/api/partners", { cookie: caller.cookie });
  assert.equal(onlineLearners.result.partners.some((partner) => partner.id === callee.result.user.id), true);
  assert.equal(onlineLearners.result.partners.some((partner) => partner.id === outsider.result.user.id), true);
  const request = await api("/api/requests", {
    method: "POST",
    cookie: caller.cookie,
    body: { partnerId: callee.result.user.id },
  });
  const accepted = await api(`/api/requests/${request.result.request.id}`, {
    method: "PATCH",
    cookie: callee.cookie,
    body: { status: "accepted" },
  });

  const unauthorizedCall = await api("/api/calls", {
    method: "POST",
    cookie: outsider.cookie,
    body: { conversationId: accepted.result.request.conversationId },
  });
  assert.equal(unauthorizedCall.status, 404);

  const started = await api("/api/calls", {
    method: "POST",
    cookie: caller.cookie,
    body: { conversationId: accepted.result.request.conversationId },
  });
  assert.equal(started.status, 201);
  assert.equal(started.result.call.status, "ringing");
  assert.equal(started.result.call.peer.name, "Call Callee");
  assert.equal(started.result.call.peer.email, undefined);
  const callId = started.result.call.id;
  const incoming = await api("/api/calls", { cookie: callee.cookie });
  assert.equal(incoming.result.call.id, callId);

  const activeConflict = await api("/api/calls", {
    method: "POST",
    cookie: callee.cookie,
    body: { conversationId: accepted.result.request.conversationId },
  });
  assert.equal(activeConflict.status, 409);

  const offer = { type: "offer", sdp: "test caller offer" };
  const sentOffer = await api(`/api/calls/${callId}/signals`, {
    method: "POST",
    cookie: caller.cookie,
    body: { type: "offer", description: offer },
  });
  assert.equal(sentOffer.status, 200);
  const visibleOffer = await api(`/api/calls/${callId}`, { cookie: callee.cookie });
  assert.deepEqual(visibleOffer.result.call.offer, offer);

  const forgedOffer = await api(`/api/calls/${callId}/signals`, {
    method: "POST",
    cookie: callee.cookie,
    body: { type: "offer", description: offer },
  });
  assert.equal(forgedOffer.status, 403);

  const joined = await api(`/api/calls/${callId}/action`, {
    method: "POST",
    cookie: callee.cookie,
    body: { action: "accept" },
  });
  assert.equal(joined.result.call.status, "accepted");
  const answer = { type: "answer", sdp: "test callee answer" };
  const sentAnswer = await api(`/api/calls/${callId}/signals`, {
    method: "POST",
    cookie: callee.cookie,
    body: { type: "answer", description: answer },
  });
  assert.equal(sentAnswer.status, 200);

  const candidate = { candidate: "candidate:1 1 UDP 1 127.0.0.1 1234 typ host", sdpMid: "0", sdpMLineIndex: 0 };
  const sentCandidate = await api(`/api/calls/${callId}/signals`, {
    method: "POST",
    cookie: caller.cookie,
    body: { type: "candidate", candidate },
  });
  assert.equal(sentCandidate.status, 200);
  const callState = await api(`/api/calls/${callId}`, { cookie: callee.cookie });
  assert.deepEqual(callState.result.call.answer, answer);
  assert.equal(callState.result.call.candidates[0].candidate.candidate, candidate.candidate);

  const outsiderRead = await api(`/api/calls/${callId}`, { cookie: outsider.cookie });
  assert.equal(outsiderRead.status, 404);
  const ended = await api(`/api/calls/${callId}/action`, {
    method: "POST",
    cookie: callee.cookie,
    body: { action: "end" },
  });
  assert.equal(ended.result.call.status, "ended");

  const directCall = await api("/api/calls", {
    method: "POST",
    cookie: caller.cookie,
    body: { partnerId: outsider.result.user.id },
  });
  assert.equal(directCall.status, 201);
  assert.equal(directCall.result.request.matchType, "direct-call");
  assert.equal(directCall.result.call.peer.id, outsider.result.user.id);
  const directIncoming = await api("/api/calls", { cookie: outsider.cookie });
  assert.equal(directIncoming.result.call.id, directCall.result.call.id);
});

test("quick match connects available learners and group rooms support private membership chat", async () => {
  const matchmaker = await api("/api/register", {
    method: "POST",
    body: { name: "Matchmaker", email: "matchmaker@example.com", password: "a-safe-password" },
  });
  const match = await api("/api/register", {
    method: "POST",
    body: { name: "Quick Match", email: "quickmatch@example.com", password: "a-safe-password" },
  });
  assert.equal(matchmaker.status, 201);
  assert.equal(match.status, 201);
  await Promise.all([markOnline(matchmaker.cookie), markOnline(match.cookie)]);

  const quickMatch = await api("/api/quick-match", { method: "POST", cookie: matchmaker.cookie, body: {} });
  assert.equal(quickMatch.status, 201);
  assert.equal(quickMatch.result.partner.id, match.result.user.id);
  const recipientRequests = await api("/api/requests", { cookie: match.cookie });
  assert.equal(recipientRequests.result.requests[0].status, "accepted");
  assert.equal(recipientRequests.result.requests[0].matchType, "quick");

  const host = await api("/api/register", {
    method: "POST",
    body: { name: "Room Host", email: "roomhost@example.com", password: "a-safe-password" },
  });
  const guest = await api("/api/register", {
    method: "POST",
    body: { name: "Room Guest", email: "roomguest@example.com", password: "a-safe-password" },
  });
  const roomResult = await api("/api/rooms", {
    method: "POST",
    cookie: host.cookie,
    body: { name: "Travel stories", topic: "A place I want to visit" },
  });
  assert.equal(roomResult.status, 201);
  const roomId = roomResult.result.room.id;

  const guestBeforeJoin = await api(`/api/rooms/${roomId}/messages`, { cookie: guest.cookie });
  assert.equal(guestBeforeJoin.status, 404);
  const joined = await api(`/api/rooms/${roomId}`, { method: "POST", cookie: guest.cookie, body: {} });
  assert.equal(joined.status, 200);
  assert.equal(joined.result.room.memberCount, 2);

  const roomMessage = await api(`/api/rooms/${roomId}/messages`, {
    method: "POST",
    cookie: guest.cookie,
    body: { text: "I would love to visit London." },
  });
  assert.equal(roomMessage.status, 201);
  const roomMessages = await api(`/api/rooms/${roomId}/messages`, { cookie: host.cookie });
  assert.equal(roomMessages.result.messages[0].senderName, "Room Guest");

  const guestLeave = await api(`/api/rooms/${roomId}/leave`, { method: "POST", cookie: guest.cookie, body: {} });
  assert.equal(guestLeave.status, 200);
  const roomList = await api("/api/rooms", { cookie: guest.cookie });
  assert.equal(roomList.result.rooms[0].memberCount, 1);
  const hostLeave = await api(`/api/rooms/${roomId}/leave`, { method: "POST", cookie: host.cookie, body: {} });
  assert.equal(hostLeave.status, 200);
  const emptyRoomList = await api("/api/rooms", { cookie: matchmaker.cookie });
  assert.equal(emptyRoomList.result.rooms.length, 0);
});
