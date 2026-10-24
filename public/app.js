const content = document.querySelector("#page-content");
const authDialog = document.querySelector("#auth-dialog");
const toast = document.querySelector("#toast");
const USER_KEY = "speakup-user";
let currentUser = null;
let currentPage = "home";
let authMode = "register";
let hindiHints = false;
let aiConversation = [];
let aiTopic = "Everyday conversation";
let partnerRefresh;
let chatRefresh;
let presenceRefresh;
let recognition;
let listening = false;
let aiLevel = "Beginner";
let aiConfigured = false;
let aiThinking = false;
let aiStatusMessage = "This is an on-device demo tutor, not a connected AI service. Your chat stays in this browser; no API key required.";
let roomRefresh;
let callRefresh;
let activeCall = null;
let peerConnection = null;
let localAudioStream = null;
let callPollBusy = false;
let quickHumanCallInProgress = false;
let answerStarted = false;
let appliedCandidateIds = new Set();
let pendingRemoteCandidates = [];
let lastEndedCallId = null;
let callConnectionLabel = "";
let selectedRoomId = new URLSearchParams(location.search).get("room");

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const initials = (name = "?") => escapeHtml(name.trim().slice(0, 1).toUpperCase() || "?");
const localKey = (kind) => `speakup-${kind}-${currentUser?.id || "guest"}`;
const readLocal = (kind, fallback = []) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(localKey(kind)) || "null");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }

  async function callOnlinePartner(partnerId) {
    if (!currentUser) return authPrompt();
    if (!currentUser.available) return showToast("Turn on your partner availability in your profile before calling learners.");
    if (activeCall && activeCall.status !== "ended") return showToast("Finish your current voice call first.");
    if (!navigator.mediaDevices?.getUserMedia) return showToast("Microphone access requires a supported browser and a secure connection (HTTPS or localhost).");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await startVoiceCall(null, stream, partnerId);
    } catch (error) {
      showToast(error.message);
    }
  }
};
const writeLocal = (kind, value) => localStorage.setItem(localKey(kind), JSON.stringify(value));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    credentials: "same-origin",
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function updateShell() {
  const authButton = document.querySelector("#auth-button");
  authButton.textContent = currentUser ? "Log out" : "Log in";
  document.querySelector("#sidebar-name").textContent = currentUser?.name || "Your profile";
  document.querySelector("#sidebar-level").textContent = currentUser?.level || "Set up your level";
  const avatar = document.querySelector("#sidebar-avatar");
  avatar.innerHTML = currentUser?.photo
    ? `<img src="${escapeHtml(currentUser.photo)}" alt="">`
    : initials(currentUser?.name || "S");
}

function setPage(page) {
  currentPage = page;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  renderPage();
  if (page === "partners") loadPartners();
  if (page === "rooms") loadRooms();
  if (page === "tutor") loadTutorStatus();
  if (page === "progress") renderPage();
  if (page === "chat") renderChat();
  clearInterval(partnerRefresh);
  clearInterval(chatRefresh);
  clearInterval(roomRefresh);
  clearInterval(callRefresh);
  if (page === "partners" && currentUser) partnerRefresh = setInterval(loadPartners, 15000);
  if (page === "chat" && currentUser) chatRefresh = setInterval(renderChat, 4000);
  if (page === "rooms" && currentUser) roomRefresh = setInterval(loadRooms, 5000);
  if (currentUser) {
    startPresenceUpdates();
    pollCall();
    callRefresh = setInterval(pollCall, 1500);
  }
}

function startPresenceUpdates() {
  if (!currentUser) return;
  refreshPresence();
  if (!presenceRefresh) presenceRefresh = setInterval(refreshPresence, 15_000);
}

async function refreshPresence() {
  if (!currentUser) return;
  try {
    await api("/api/presence", {
      method: currentUser.available ? "POST" : "DELETE",
      ...(currentUser.available ? { body: "{}" } : {}),
    });
  } catch (error) {
    console.error("Online status refresh failed:", error);
  }
}

function authPrompt(mode = "register") {
  setAuthMode(mode);
  authDialog.showModal();
}

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === "register";
  document.querySelector("#auth-title").textContent = isRegister ? "Welcome to SpeakUp" : "Welcome back";
  document.querySelector("#auth-subtitle").textContent = isRegister ? "Create a free account and find your speaking rhythm." : "Pick up where your speaking practice left off.";
  document.querySelector("#name-field").hidden = !isRegister;
  document.querySelector("#level-field").hidden = !isRegister;
  document.querySelector("#auth-form [name=name]").required = isRegister;
  document.querySelector("#auth-form [name=password]").autocomplete = isRegister ? "new-password" : "current-password";
  document.querySelector("#auth-submit").innerHTML = isRegister ? "Create my account <span>→</span>" : "Log in <span>→</span>";
  document.querySelector("#register-tab").classList.toggle("selected", isRegister);
  document.querySelector("#login-tab").classList.toggle("selected", !isRegister);
  document.querySelector("#auth-error").textContent = "";
}

function pageHeading(eyebrow, title, subtitle, action = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}

function renderHome() {
  const sessions = readLocal("sessions");
  const minutes = sessions.reduce((total, session) => total + (session.minutes || 0), 0);
  const streak = calculateStreak(sessions);
  const greeting = currentUser ? `Ready to practice, ${escapeHtml(currentUser.name.split(" ")[0])}?` : "Your English journey starts here.";
  return `
    <section class="practice-home">
      <div class="practice-welcome"><div class="eyebrow">SPEAK A LITTLE. GROW A LOT.</div><h1>${greeting}</h1><p>Choose a friendly human conversation or practice at your own pace with your AI teacher.</p></div>
      <section class="practice-feature-section">
        <h2>PRACTICE WITH HUMANS</h2>
        <article class="human-feature">
          <span class="feature-pill">1:1 AUDIO CALL</span>
          <div class="human-feature-copy"><span class="feature-caption">MEET LEARNERS ACROSS INDIA</span><h3>Real people.<br>Real conversations.</h3><p>Find an available learner and practice speaking English together.</p>
            <button class="button human-call-button" data-action="quick-human-call"><span aria-hidden="true">☎</span> Start Human Call</button>
          </div>
          <div class="human-feature-art" aria-hidden="true"><img src="/human-practice.svg" alt=""></div>
        </article>
      </section>
      <section class="practice-feature-section ai-feature-section">
        <h2>PRACTICE WITH AI TEACHER</h2>
        <article class="ai-feature">
          <div class="ai-feature-art" aria-hidden="true"><img src="/ai-teacher.svg" alt=""><span class="words-badge">WORDS<br><small>of the</small><br>DAY</span></div>
          <div class="ai-feature-copy"><div><span class="feature-caption">YOUR FRIENDLY SPEAKING BUDDY</span><h3>Build confidence, one chat at a time.</h3><p>Choose a topic, speak or type, and get gentle English practice.</p></div><button class="button button-primary" data-page="tutor">Start practicing <span>→</span></button></div>
        </article>
      </section>
      <section class="practice-summary" aria-label="Your practice summary">
        <div class="practice-summary-item"><span aria-hidden="true">◷</span><div><strong>${minutes}</strong><small>minutes practiced</small></div></div>
        <div class="practice-summary-item"><span aria-hidden="true">🔥</span><div><strong>${streak} day${streak === 1 ? "" : "s"}</strong><small>speaking streak</small></div></div>
        <button class="practice-summary-item" data-page="progress"><span aria-hidden="true">↗</span><div><strong>${sessions.length}</strong><small>practice sessions</small></div></button>
      </section>
      <div class="practice-daily-prompt"><span class="practice-card-icon ai">✳</span><div><strong>Today's speaking prompt</strong><p>${escapeHtml(getDailyChallenge().prompt)}</p></div><button class="link-button" data-page="tutor">Try it →</button></div>
    </section>
    ${!currentUser ? `<div class="hint" style="display:block;margin-top:18px">Create an account to connect with learners across India and keep your practice history. <button class="link-button" data-action="register">Join SpeakUp →</button></div>` : ""}
  `;
}

function calculateStreak(sessions) {
  const days = new Set(sessions.map((session) => session.date).filter(Boolean));
  let count = 0;
  const date = new Date();
  if (!days.has(date.toLocaleDateString("en-CA"))) date.setDate(date.getDate() - 1);
  while (days.has(date.toLocaleDateString("en-CA"))) {
    count++;
    date.setDate(date.getDate() - 1);
  }
  return count;
}

function renderPage() {
  document.body.classList.toggle("hindi-hints", hindiHints);
  updateShell();
  if (!currentUser && ["profile"].includes(currentPage)) {
    content.innerHTML = `${pageHeading("YOUR SPACE", "Your profile", "Create a free account to personalize your learning.")}<div class="empty-state"><strong>Your learning profile is waiting</strong>Save your English level and find a partner who shares your interests.<br><br><button class="button button-primary" data-action="register">Create a free account</button></div>`;
    return;
  }
  const renderers = {
    home: renderHome,
    partners: renderPartners,
    rooms: renderRooms,
    tutor: renderTutor,
    progress: renderProgress,
    review: renderReview,
    vocabulary: renderVocabulary,
    profile: renderProfile,
    chat: renderChat,
  };
  content.innerHTML = (renderers[currentPage] || renderHome)();
  if (currentPage === "chat") scrollChatToBottom();
}

function renderPartners() {
  return `${pageHeading("SPEAK WITH A PERSON", "Find your practice partner", "Meet learners across India who are here to practice, too.", currentUser ? `<button class="button button-primary" data-action="quick-match">Quick match →</button>` : `<button class="button button-primary" data-action="register">Join to connect</button>`)}
    <div class="filter-bar"><input class="search-input" id="partner-search" type="search" placeholder="Search by name or interests" aria-label="Search learners"><select id="partner-level" aria-label="Filter by English level"><option value="">All English levels</option><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></div>
    ${currentUser ? `<div id="partner-results"><div class="empty-state">Finding learners who are ready to practice…</div></div><div class="inbox-list" id="request-inbox"></div>` : `<div class="empty-state"><strong>Make your first connection</strong>Create an account to discover learners and send practice requests.<br><br><button class="button button-primary" data-action="register">Create a free account</button></div>`}
    <div class="call-info" style="margin-top:17px">Quick Match searches the nationwide learner pool. Once connected, start a private voice call from your chat. Only learners who are online and available can be matched.</div>`;
}

const speakingTopics = [
  "Introduce yourself and tell us one thing you enjoy.",
  "Describe a place you would love to visit.",
  "What makes a good friend?",
  "Talk about a food you enjoy and why.",
  "Share one goal you are working towards.",
  "What would you do with a completely free day?",
  "Describe a skill you would like to learn.",
];

function getDailyChallenge() {
  const date = new Date();
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
  return { date: date.toLocaleDateString("en-CA"), prompt: speakingTopics[((day % speakingTopics.length) + speakingTopics.length) % speakingTopics.length] };
}

function renderRooms() {
  if (!currentUser) return `${pageHeading("SPEAK TOGETHER", "Group practice rooms", "Meet a few English learners and practice around a shared topic.")}<div class="empty-state"><strong>Join the speaking circle</strong>Create an account to join or host a group text-practice room.<br><br><button class="button button-primary" data-action="register">Create a free account</button></div>`;
  const challenge = getDailyChallenge();
  const challengeDone = localStorage.getItem(localKey("challenge")) === challenge.date;
  return `${pageHeading("SPEAK TOGETHER", "Group practice rooms", "Join a small group, choose one topic, and take turns speaking.")}<div class="call-info" style="margin-bottom:15px">Today's speaking prompt: <strong>${escapeHtml(challenge.prompt)}</strong> ${challengeDone ? "✓ Done today" : `<button class="link-button" data-action="complete-challenge">Mark today's prompt done</button>`}</div>
    <form class="room-create" id="room-create-form"><input class="search-input" name="name" maxlength="50" required placeholder="Room name, e.g. Friendly introductions"><input class="search-input" name="topic" maxlength="120" required placeholder="Speaking topic, e.g. travel stories"><button class="button button-primary">Host a room <span>+</span></button></form>
    <div class="section-heading"><div><div class="eyebrow">OPEN CIRCLES</div><h2>Rooms ready to join</h2><p>Up to 8 learners · Rooms close after 2 hours of inactivity.</p></div></div><div id="room-results"><div class="empty-state">Finding open speaking rooms…</div></div>
    ${selectedRoomId ? `<section class="chat-panel room-chat-shell"><div class="room-chat-head"><div><strong id="active-room-name">Your speaking room</strong><small id="active-room-topic">Take turns and encourage everyone.</small></div><button class="button button-outline" data-action="leave-room">Leave room</button></div><div class="call-info" style="margin:10px 12px 0">Group text practice is ready. Live group voice needs a configured voice/signaling service.</div><div class="chat-window conversation-window" id="room-chat"><div class="empty-state">Loading the room…</div></div><form class="chat-composer" id="room-chat-form"><input name="text" maxlength="2000" required placeholder="Share a friendly message with the group…" aria-label="Group room message"><button class="button button-primary">Send <span>→</span></button></form></section>` : ""}`;
}

async function loadRooms() {
  if (!currentUser || currentPage !== "rooms") return;
  const results = document.querySelector("#room-results");
  if (!results) return;
  try {
    const { rooms } = await api("/api/rooms");
    if (currentPage !== "rooms") return;
    results.innerHTML = rooms.length ? `<div class="room-grid">${rooms.map((room) => `<article class="room-card"><span class="practice-card-icon">◎</span><h3>${escapeHtml(room.name)}</h3><p>${escapeHtml(room.topic)}</p><div class="room-meta"><span>Hosted by ${escapeHtml(room.host?.name || "a learner")}</span><span>${room.memberCount}/${room.maxMembers} learners</span></div><button class="button ${room.joined ? "button-secondary" : "button-outline"}" data-action="${room.joined ? "open-room" : "join-room"}" data-id="${escapeHtml(room.id)}">${room.joined ? "Open room →" : "Join this room →"}</button></article>`).join("")}</div>` : `<div class="empty-state"><strong>No rooms are open right now</strong>Host a speaking circle and invite learners to join.</div>`;
    if (selectedRoomId) await refreshRoomMessages();
  } catch (error) {
    results.innerHTML = `<div class="empty-state"><strong>We couldn't load rooms</strong>${escapeHtml(error.message)}<br><br><button class="button button-outline" data-action="retry-rooms">Try again</button></div>`;
  }
}

async function refreshRoomMessages() {
  if (currentPage !== "rooms" || !selectedRoomId) return;
  const container = document.querySelector("#room-chat");
  if (!container) return;
  try {
    const { room, messages } = await api(`/api/rooms/${selectedRoomId}/messages`);
    if (!document.querySelector("#room-chat")) return;
    document.querySelector("#active-room-name").textContent = room.name;
    document.querySelector("#active-room-topic").textContent = `${room.topic} · ${room.memberCount} learners`;
    container.innerHTML = messages.length ? messages.map((message) => `<div class="room-message ${message.senderId === currentUser.id ? "mine" : ""}"><small>${escapeHtml(message.senderName)} · ${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>${escapeHtml(message.text)}</div>`).join("") : `<div class="empty-state"><strong>Welcome to the circle</strong>Introduce yourself and invite others into the conversation.</div>`;
    container.scrollTop = container.scrollHeight;
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><strong>Room connection ended</strong>${escapeHtml(error.message)}<br><br><button class="button button-outline" data-action="leave-room">Back to rooms</button></div>`;
  }
}

async function loadPartners() {
  if (!currentUser || currentPage !== "partners") return;
  const results = document.querySelector("#partner-results");
  if (!results) return;
  const query = new URLSearchParams();
  const search = document.querySelector("#partner-search")?.value.trim();
  const level = document.querySelector("#partner-level")?.value;
  if (search) query.set("q", search);
  if (level) query.set("level", level);
  try {
    await refreshPresence();
    const [{ partners }, { requests }] = await Promise.all([
      api(`/api/partners?${query}`),
      api("/api/requests"),
    ]);
    if (currentPage !== "partners") return;
    const pending = new Set(requests.filter((request) => request.from === currentUser.id && request.status === "pending").map((request) => request.to));
    results.innerHTML = partners.length ? `<div class="partner-grid">${partners.map((partner) => `
      <article class="partner-card">
        <div class="partner-top"><span class="avatar">${partner.photo ? `<img src="${escapeHtml(partner.photo)}" alt="">` : initials(partner.name)}</span><div><div class="partner-name">${escapeHtml(partner.name)}</div><div class="partner-level">${escapeHtml(partner.level)} · ${escapeHtml(partner.language)}</div></div><span class="available-label">● Online</span></div>
        <p class="partner-interests">${escapeHtml(partner.interests || "Ready to practice everyday English.")}</p>
        <div class="partner-actions"><button class="button button-primary" data-action="call-partner" data-id="${escapeHtml(partner.id)}">Call now</button><button class="button ${pending.has(partner.id) ? "button-secondary" : "button-outline"}" data-action="request" data-id="${escapeHtml(partner.id)}" ${pending.has(partner.id) ? "disabled" : ""}>${pending.has(partner.id) ? "Request sent ✓" : "Say hello"}</button></div>
      </article>`).join("")}</div>` : `<div class="empty-state"><strong>No learners found just yet</strong>Try another search, or check back soon. You can practice with the AI tutor in the meantime.<br><br><button class="button button-secondary" data-page="tutor">Practice with AI</button></div>`;
    const inbox = document.querySelector("#request-inbox");
    inbox.innerHTML = requests.filter((request) => request.status === "accepted").map((request) => `
      <div class="request-row"><span class="avatar avatar-small">${initials(request.partner?.name)}</span><div class="request-copy"><strong>Practice with ${escapeHtml(request.partner?.name || "your partner")}</strong><small>${escapeHtml(request.partner?.level || "English learner")} · Text chat</small></div><button class="button button-primary" data-action="open-chat" data-id="${escapeHtml(request.id)}">Open chat →</button></div>`).join("") +
      requests.filter((request) => request.to === currentUser.id && request.status === "pending").map((request) => `
      <div class="request-row"><span class="avatar avatar-small">${initials(request.partner?.name)}</span><div class="request-copy"><strong>${escapeHtml(request.partner?.name || "A learner")} wants to practice</strong><small>${escapeHtml(request.partner?.level || "English learner")} · Accept to start a text chat</small></div><button class="button button-primary" data-action="accept" data-id="${escapeHtml(request.id)}">Accept</button><button class="button button-outline" data-action="decline" data-id="${escapeHtml(request.id)}">Decline</button></div>`).join("");
  } catch (error) {
    results.innerHTML = `<div class="empty-state"><strong>We couldn't load learners</strong>${escapeHtml(error.message)}<br><br><button class="button button-outline" data-action="retry-partners">Try again</button></div>`;
  }
}

function renderTutor() {
  const hasSession = aiConversation.length > 0;
  const intro = hasSession ? "" : `<div class="message ai-message"><small>YOUR AI SPEAKING BUDDY</small>Hi${currentUser ? `, ${escapeHtml(currentUser.name.split(" ")[0])}` : ""}! I'm your friendly English practice buddy. Choose a topic, then tell me a little about yourself. What would you like to talk about?</div>`;
  const history = readLocal("sessions").slice(0, 4);
  return `<div class="tutor-layout">
    <section class="chat-panel">
      <div class="chat-header"><div><strong>✳ Your AI speaking buddy</strong><small>Patient, friendly practice at your level</small></div><div class="chat-controls"><select class="small-select" id="topic-select" aria-label="Conversation topic">${["Everyday conversation", "Meeting someone new", "Travel and holidays", "Work and career", "Job interview", "Food and shopping"].map((topic) => `<option ${aiTopic === topic ? "selected" : ""}>${topic}</option>`).join("")}</select><select class="small-select" id="ai-level" aria-label="Your English level">${["Beginner", "Intermediate", "Advanced"].map((level) => `<option ${aiLevel === level ? "selected" : ""}>${level}</option>`).join("")}</select></div></div>
      <div class="call-info" id="tutor-status" style="margin:10px 12px 0">${escapeHtml(aiStatusMessage)}</div>
      <div class="chat-window" id="ai-chat">${intro}${aiConversation.map((message) => renderMessage(message)).join("")}${aiThinking ? `<div class="message ai-message"><small>YOUR AI BUDDY</small>Thinking of a helpful reply…</div>` : ""}</div>
      <form class="chat-composer" id="ai-form"><button type="button" class="button button-outline" data-action="voice" title="Speak your message">${listening ? "Stop" : "🎙"}</button><input id="ai-input" maxlength="1500" placeholder="Type in English, or tap the mic to speak…" aria-label="Your message"><button class="button button-primary" type="submit">Send <span>→</span></button></form>
    </section>
    <aside class="side-panel"><h3>A gentle nudge ✨</h3><p>There is no perfect way to say something. Try, keep going, and let the words come.</p><ul><li>Speak one sentence at a time</li><li>It's okay to make mistakes</li><li>Ask your tutor to repeat</li></ul><p class="side-note">Tip: Try answering in English, even if it's just a few words.</p><button class="button button-outline button-full" data-action="finish-ai" ${hasSession ? "" : "disabled"}>Finish & see my review</button><div class="call-info" style="margin-top:11px">Voice input/output depends on your browser. Pronunciation is not analyzed by this demo.</div>${history.length ? `<h3 style="margin-top:18px">Recent practice</h3><p>${history.map((session) => `${escapeHtml(session.topic)} · ${session.minutes} min`).join("<br>")}</p>` : ""}</aside>
  </div>`;
}

function renderMessage(message) {
  return `<div class="message ${message.role === "user" ? "user-message" : "ai-message"}"><small>${message.role === "user" ? "YOU" : "YOUR AI BUDDY"}</small>${escapeHtml(message.text)}</div>`;
}

function friendlyReply(text, topic, level) {
  const answer = text.trim();
  const correction = getCorrections(answer)[0]?.note || "";
  const encouragement = answer.split(/\s+/).length < 5
    ? "Nice start! Can you tell me a little more? "
    : "That's interesting! ";
  const followUps = {
    "Everyday conversation": "What do you enjoy doing in your free time?",
    "Meeting someone new": "What is something you really enjoy about your hometown?",
    "Travel and holidays": "Where would you love to travel next, and why?",
    "Work and career": "What is one skill you would like to learn for your work?",
    "Job interview": "What is one strength you would bring to this role?",
    "Food and shopping": "What is a dish you love, and who usually makes it?",
  };
  const levelNote = level === "Beginner" ? " You can answer in one or two short sentences." : "";
  return `${correction ? `${correction} ` : ""}${encouragement}${followUps[topic] || followUps["Everyday conversation"]}${levelNote}`;
}

function getCorrections(text) {
  const patterns = [
    { pattern: /\bi am agree\b/i, original: "I am agree", improved: "I agree", note: "Say “I agree” instead of “I am agree.”" },
    { pattern: /\byesterday i go\b/i, original: "Yesterday I go", improved: "Yesterday I went", note: "Use “went” for an action in the past: “Yesterday I went…”" },
    { pattern: /\bmore better\b/i, original: "more better", improved: "better", note: "“Better” already means “more good,” so you can simply say “better.”" },
    { pattern: /\bi have (\d+) years\b/i, original: "I have … years", improved: "I am … years old", note: "For your age, say “I am … years old.”" },
  ];
  return patterns.filter((entry) => entry.pattern.test(text)).map(({ original, improved, note }) => ({ original, improved, note }));
}

async function loadTutorStatus() {
  if (currentPage !== "tutor") return;
  const status = document.querySelector("#tutor-status");
  try {
    const result = await api("/api/tutor/status");
    aiConfigured = result.configured;
    aiStatusMessage = aiConfigured
      ? currentUser
        ? "AI tutor connected. Your conversation is sent securely to the configured AI service for replies."
        : "A real AI tutor is available after you sign in. Visitors can still try the local practice demo."
      : "Local practice demo: set OPENAI_API_KEY on the server to connect a real AI tutor. Your messages stay in this browser until you choose to connect one.";
  } catch {
    aiStatusMessage = "AI service status could not be checked. You can continue with the local practice tutor.";
  }
  if (status) status.textContent = aiStatusMessage;
}

async function startAIChat() {
  aiTopic = document.querySelector("#topic-select")?.value || aiTopic;
  aiLevel = document.querySelector("#ai-level")?.value || aiLevel;
  const level = aiLevel;
  const input = document.querySelector("#ai-input");
  const text = input?.value.trim();
  if (!text) {
    showToast("Type a message or tap the microphone to speak.");
    return;
  }
  const userMessage = { role: "user", text, time: Date.now() };
  aiConversation.push(userMessage);
  aiThinking = true;
  renderPage();
  try {
    let reply;
    if (aiConfigured && currentUser) {
      const { reply: aiReply } = await api("/api/tutor", {
        method: "POST",
        body: JSON.stringify({
          topic: aiTopic,
          level,
          messages: aiConversation.map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.text,
          })),
        }),
      });
      reply = aiReply;
    } else {
      reply = friendlyReply(text, aiTopic, level);
      if (aiConversation.length === 1) {
        aiConversation.unshift({ role: "assistant", text: `Let's talk about ${aiTopic.toLowerCase()}. Take your time!`, time: Date.now() });
      }
    }
    aiConversation.push({ role: "assistant", text: reply, time: Date.now() });
    aiThinking = false;
    renderPage();
    speak(reply);
  } catch (error) {
    aiConversation = aiConversation.filter((message) => message !== userMessage);
    aiThinking = false;
    renderPage();
    document.querySelector("#ai-input").value = text;
    showToast(error.message);
  }
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function toggleVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("Voice input isn't supported in this browser. Type your message instead.");
    return;
  }
  if (listening && recognition) {
    recognition.stop();
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = currentUser?.language === "Hindi" ? "en-IN" : "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    listening = true;
    const voiceButton = document.querySelector('[data-action="voice"]');
    if (voiceButton) voiceButton.textContent = "Stop";
  };
  recognition.onresult = (event) => {
    document.querySelector("#ai-input").value = event.results[0][0].transcript;
  };
  recognition.onerror = (event) => {
    if (event.error !== "aborted" && event.error !== "no-speech") showToast("We couldn't start the microphone. Check your browser permission.");
  };
  recognition.onend = () => {
    listening = false;
    const voiceButton = document.querySelector('[data-action="voice"]');
    if (voiceButton) voiceButton.textContent = "🎙";
  };
  recognition.start();
}

function finishAI() {
  if (!aiConversation.some((message) => message.role === "user")) {
    showToast("Send a message first, then your practice review will be ready.");
    return;
  }
  const userMessages = aiConversation.filter((message) => message.role === "user");
  const seconds = Math.max(60, Math.round((Date.now() - userMessages[0].time) / 1000));
  const sessions = readLocal("sessions");
  const session = {
    id: crypto.randomUUID(),
    topic: aiTopic,
    minutes: Math.max(1, Math.round(seconds / 60)),
    date: new Date().toLocaleDateString("en-CA"),
    createdAt: new Date().toISOString(),
    messages: userMessages.map((message) => message.text),
    corrections: userMessages.flatMap((message) => getCorrections(message.text)),
  };
  sessions.unshift(session);
  writeLocal("sessions", sessions);
  const improvements = session.corrections.length;
  aiConversation = [];
  setPage("review");
  showToast(`Practice saved! ${improvements ? `We found ${improvements} helpful language tip${improvements === 1 ? "" : "s"}.` : "Keep up the great work!"}`);
}

function renderReview() {
  const session = readLocal("sessions")[0];
  if (!session) return renderProgress();
  const corrections = session.corrections || [];
  return `${pageHeading("A MOMENT TO REFLECT", "Your conversation review", `You practiced “${escapeHtml(session.topic)}”. Every attempt helps you grow.`)}
    <section class="profile-panel"><h2>Look what you did ✨</h2><p style="color:#7f8983;font-size:11px">You shared ${session.messages.length} message${session.messages.length === 1 ? "" : "s"} and practiced for ${session.minutes} minute${session.minutes === 1 ? "" : "s"}. Give yourself credit for showing up.</p>
      <h2 style="margin-top:20px">A few useful ways to say it</h2>${corrections.length ? corrections.map((entry) => `<div class="vocab-item"><span class="practice-card-icon ai">✳</span><div><p>Instead of “${escapeHtml(entry.original)},” try <strong>“${escapeHtml(entry.improved)}.”</strong></p><p>${escapeHtml(entry.note)}</p><button class="link-button" data-action="save-review-word" data-word="${escapeHtml(entry.improved)}">Save phrase to my vocabulary +</button></div></div>`).join("") : `<p style="color:#7f8983;font-size:11px">No corrections to share this time. Keep practicing and notice one phrase you would like to try next time.</p>`}
      <h2 style="margin-top:20px">Your word for next time</h2><div class="vocab-item"><span class="practice-card-icon">▤</span><div><strong>confident</strong><p>“I feel more confident when I practice speaking.”</p><button class="link-button" data-action="save-review-word" data-word="confident">Save to my vocabulary +</button></div></div>
      <div class="call-info" style="margin-top:15px">Pronunciation feedback isn't available in this demo. No pronunciation score was recorded.</div>
      <div class="hero-actions" style="margin-top:18px"><button class="button button-primary" data-page="tutor">Practice again <span>→</span></button><button class="button button-outline" data-page="progress">See all progress</button></div>
    </section>`;
}

function renderProgress() {
  const sessions = readLocal("sessions");
  const minutes = sessions.reduce((total, session) => total + session.minutes, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setDate(day.getDate() - (6 - index));
    return { date: day.toLocaleDateString("en-CA"), label: day.toLocaleDateString("en", { weekday: "short" }) };
  });
  const highest = Math.max(1, ...days.map((day) => sessions.filter((entry) => entry.date === day.date).reduce((sum, entry) => sum + entry.minutes, 0)));
  return `${pageHeading("LOOK HOW FAR YOU'VE COME", "Your progress", "Every conversation counts. Take a moment to feel proud.")}
    <div class="stats-strip"><div class="stat"><span class="stat-icon">◷</span><div><strong>${minutes}</strong><small>minutes practiced</small></div></div><div class="stat"><span class="stat-icon">✳</span><div><strong>${calculateStreak(sessions)} day${calculateStreak(sessions) === 1 ? "" : "s"}</strong><small>current speaking streak</small></div></div><div class="stat"><span class="stat-icon">↗</span><div><strong>${sessions.length}</strong><small>practice sessions</small></div></div></div>
    <div class="progress-panel"><div class="section-heading"><div><h2>This week's practice</h2><p>Your daily speaking minutes</p></div></div><div class="progress-bars">${days.map((day) => { const total = sessions.filter((entry) => entry.date === day.date).reduce((sum, entry) => sum + entry.minutes, 0); return `<div class="progress-day"><div class="progress-bar ${day.date === new Date().toLocaleDateString("en-CA") ? "today" : ""}" style="height:${Math.max(total ? 8 : 3, total / highest * 105)}px" title="${total} minutes"></div>${day.label}</div>`; }).join("")}</div>
      <div class="goal-row"><strong>Today's speaking goal</strong><span>${sessions.filter((entry) => entry.date === new Date().toLocaleDateString("en-CA")).reduce((sum, entry) => sum + entry.minutes, 0)} / ${Number(localStorage.getItem(localKey("goal")) || 5)} minutes</span></div><div class="goal-row"><label for="daily-goal"><strong>Daily goal</strong></label><select id="daily-goal" class="small-select">${[5, 10, 15, 20].map((value) => `<option value="${value}" ${Number(localStorage.getItem(localKey("goal")) || 5) === value ? "selected" : ""}>${value} minutes</option>`).join("")}</select></div></div>
      <div class="section-heading" style="margin-top:24px"><div><h2>Your practice history</h2><p>Your sessions are saved on this device.</p></div></div>${sessions.length ? `<div class="vocab-list">${sessions.map((session) => `<article class="vocab-item"><span class="practice-card-icon ai">✳</span><div><strong>${escapeHtml(session.topic)}</strong><p>${escapeHtml(session.date)} · ${session.minutes} minute${session.minutes === 1 ? "" : "s"} · ${session.messages.length} messages</p></div></article>`).join("")}</div>` : `<div class="empty-state"><strong>Your first practice is just one tap away</strong>Finish a conversation with your AI tutor to see it here.<br><br><button class="button button-secondary" data-page="tutor">Start practicing</button></div>`}`;
}

function renderVocabulary() {
  const words = readLocal("vocabulary");
  return `${pageHeading("WORDS TO KEEP", "My vocabulary", "Save words and phrases you'd like to use in your next conversation.")}
    <form id="vocab-form" class="vocab-form"><input class="search-input" name="word" required maxlength="80" placeholder="New word or phrase" aria-label="New vocabulary word"><input class="search-input" name="example" maxlength="240" placeholder="Example sentence (optional)" aria-label="Example sentence"><button class="button button-primary">Save word <span>+</span></button></form>
    ${words.length ? `<div class="vocab-list">${words.map((entry) => `<article class="vocab-item"><span class="practice-card-icon">▤</span><div><strong>${escapeHtml(entry.word)}</strong><p>${escapeHtml(entry.example || "Add this word to your next conversation.")}</p></div><button data-action="remove-word" data-id="${escapeHtml(entry.id)}" aria-label="Remove ${escapeHtml(entry.word)}">×</button></article>`).join("")}</div>` : `<div class="empty-state"><strong>Your word collection starts here</strong>Save useful phrases as you learn them. They'll stay in this browser.</div>`}`;
}

function renderProfile() {
  if (!currentUser) return renderPage();
  return `${pageHeading("MAKE IT YOURS", "Your learning profile", "A little about you helps us find the right way for you to practice.")}
    <div class="profile-layout"><form class="profile-panel" id="profile-form"><h2>Your details</h2><label class="field">Display name<input name="name" required minlength="2" maxlength="40" value="${escapeHtml(currentUser.name)}"></label><label class="field">English level<select name="level">${["Beginner", "Intermediate", "Advanced"].map((level) => `<option ${currentUser.level === level ? "selected" : ""}>${level}</option>`).join("")}</select></label><label class="field">Your native language<input name="language" maxlength="40" value="${escapeHtml(currentUser.language || "")}" placeholder="e.g. Hindi"></label><label class="field">Things you enjoy talking about<input name="interests" maxlength="120" value="${escapeHtml(currentUser.interests || "")}" placeholder="e.g. movies, food, travel"></label><label class="field">My speaking goal<input name="goal" maxlength="120" value="${escapeHtml(currentUser.goal || "")}" placeholder="Speak confidently at work"></label><label class="field">Profile photo URL (optional)<input name="photo" type="url" maxlength="500" value="${escapeHtml(currentUser.photo || "")}" placeholder="https://example.com/photo.jpg"></label><label class="availability"><input type="checkbox" name="available" ${currentUser.available ? "checked" : ""}> Show me as online and available for human calls while I'm using the app</label><p class="inline-error" id="profile-error" role="alert"></p><button class="button button-primary">Save my profile <span>→</span></button></form>
    <aside class="profile-tip"><strong>A friendly reminder ✳</strong><br>Be kind to yourself. Every learner here is practicing, too.<p>Your email address is private. Your display name, English level, language, interests, learning goal, and optional photo are visible to other learners.</p><button class="danger-button" data-action="delete-account">Delete my account and data</button></aside></div>`;
}

async function refreshChat() {
  if (currentPage !== "chat") return;
  const conversationId = new URLSearchParams(location.search).get("chat");
  const container = document.querySelector("#partner-chat");
  if (!container || !conversationId) return;
  try {
    const { messages } = await api(`/api/chat/${conversationId}`);
    if (!document.querySelector("#partner-chat")) return;
    container.innerHTML = messages.length ? messages.map((message) => `<div class="message ${message.senderId === currentUser.id ? "user-message" : "ai-message"}"><small>${message.senderId === currentUser.id ? "YOU" : "YOUR PARTNER"} · ${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>${escapeHtml(message.text)}</div>`).join("") : `<div class="empty-state"><strong>Start with a friendly hello</strong>What would you like to practice today?</div>`;
    scrollChatToBottom();
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><strong>We couldn't load this chat</strong>${escapeHtml(error.message)}</div>`;
  }
}

function scrollChatToBottom() {
  const chat = document.querySelector("#partner-chat") || document.querySelector("#ai-chat");
  if (chat) chat.scrollTop = chat.scrollHeight;
}

function renderCallNotice(call) {
  const notice = document.querySelector("#call-notice");
  if (!notice) return;
  if (!currentUser || !call || call.status === "ended") {
    notice.hidden = true;
    notice.innerHTML = "";
    return;
  }
  const peerName = escapeHtml(call.peer?.name || "your practice partner");
  const incoming = call.calleeId === currentUser.id && call.status === "ringing";
  let controls = "";
  let message = "";
  if (incoming) {
    message = `${peerName} is calling for English practice.`;
    controls = `<button class="button button-primary" data-action="accept-call">Accept</button><button class="button button-outline" data-action="decline-call">Decline</button>`;
  } else if (call.status === "ringing") {
    message = `Calling ${peerName}…`;
    controls = `<button class="button button-outline" data-action="hangup-call">Cancel</button>`;
  } else {
    message = callConnectionLabel || (peerConnection ? `Voice practice with ${peerName}` : `Voice call with ${peerName} is active on this account.`);
    const audioTrack = localAudioStream?.getAudioTracks()[0];
    controls = `${audioTrack ? `<button class="button button-outline" data-action="mute-call">${audioTrack.enabled ? "Mute mic" : "Unmute mic"}</button>` : ""}<button class="button button-outline" data-action="hangup-call">End call</button>`;
  }
  notice.innerHTML = `<div class="call-notice-copy"><strong>${message}</strong><small>Private voice practice · anywhere in India</small></div><div class="call-notice-actions">${controls}</div>`;
  notice.hidden = false;
}

function releaseCallMedia() {
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  if (localAudioStream) {
    localAudioStream.getTracks().forEach((track) => track.stop());
    localAudioStream = null;
  }
  const remoteAudio = document.querySelector("#remote-audio");
  if (remoteAudio) remoteAudio.srcObject = null;
  answerStarted = false;
  appliedCandidateIds = new Set();
  pendingRemoteCandidates = [];
  callConnectionLabel = "";
}

async function createCallPeerConnection(call) {
  if (peerConnection) return peerConnection;
  if (!localAudioStream) throw new Error("Allow microphone access to start your voice call.");
  if (!window.RTCPeerConnection) throw new Error("Voice calls are not supported by this browser.");
  const connection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  peerConnection = connection;
  localAudioStream.getAudioTracks().forEach((track) => connection.addTrack(track, localAudioStream));
  connection.onicecandidate = (event) => {
    if (!event.candidate || activeCall?.id !== call.id) return;
    const candidate = event.candidate.toJSON();
    if (candidate.sdpMid === undefined) candidate.sdpMid = null;
    if (candidate.sdpMLineIndex === undefined) candidate.sdpMLineIndex = null;
    api(`/api/calls/${call.id}/signals`, {
      method: "POST",
      body: JSON.stringify({ type: "candidate", candidate }),
    }).catch((error) => {
      console.error("Voice call network signaling failed:", error);
      showToast("The voice call network connection could not be signaled. Please end the call and try again.");
    });
  };
  connection.ontrack = (event) => {
    const remoteAudio = document.querySelector("#remote-audio");
    if (!remoteAudio) return;
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch((error) => {
      console.error("Remote audio playback failed:", error);
      showToast("Tap your browser's audio controls to hear your partner.");
    });
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "connected") {
      callConnectionLabel = `Voice practice with ${escapeHtml(call.peer?.name || "your partner")}`;
    } else if (connection.connectionState === "failed") {
      callConnectionLabel = "The call could not connect. A TURN relay may be needed on this network.";
      showToast(callConnectionLabel);
    } else if (connection.connectionState === "disconnected") {
      callConnectionLabel = "Connection interrupted. Trying to reconnect…";
    }
    renderCallNotice(activeCall);
  };
  return connection;
}

async function addPendingCallCandidates() {
  if (!peerConnection?.remoteDescription) return;
  const pending = pendingRemoteCandidates.splice(0);
  for (const candidate of pending) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

async function applyCallSignals(call) {
  if (!peerConnection || !call || call.status === "ended") return;
  if (call.calleeId === currentUser.id && call.status === "accepted" && call.offer && !answerStarted && !peerConnection.remoteDescription) {
    answerStarted = true;
    await peerConnection.setRemoteDescription(call.offer);
    await addPendingCallCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await api(`/api/calls/${call.id}/signals`, {
      method: "POST",
      body: JSON.stringify({ type: "answer", description: peerConnection.localDescription }),
    });
  } else if (call.callerId === currentUser.id && call.answer && !peerConnection.remoteDescription) {
    await peerConnection.setRemoteDescription(call.answer);
    await addPendingCallCandidates();
  }
  for (const entry of call.candidates) {
    if (entry.senderId === currentUser.id || appliedCandidateIds.has(entry.id)) continue;
    appliedCandidateIds.add(entry.id);
    if (peerConnection.remoteDescription) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(entry.candidate));
    } else {
      pendingRemoteCandidates.push(entry.candidate);
    }
  }
}

async function pollCall() {
  if (!currentUser || callPollBusy) return;
  callPollBusy = true;
  try {
    const { call } = await api("/api/calls");
    if (call?.status === "ended") {
      if (activeCall?.id === call.id && lastEndedCallId !== call.id) {
        lastEndedCallId = call.id;
        releaseCallMedia();
        activeCall = null;
        renderCallNotice(null);
        showToast(call.reason === "unanswered" ? "No answer this time. Try calling again later." : "The voice call has ended.");
      }
      return;
    }
    if (!call) {
      if (activeCall) {
        releaseCallMedia();
        activeCall = null;
        renderCallNotice(null);
      }
      return;
    }
    if (activeCall && activeCall.id !== call.id) releaseCallMedia();
    activeCall = call;
    if (lastEndedCallId !== call.id) renderCallNotice(call);
    if (peerConnection) await applyCallSignals(call);
  } catch (error) {
    console.error("Voice call status refresh failed:", error);
  } finally {
    callPollBusy = false;
  }
}

async function startVoiceCall(conversationIdOverride = null, audioStream = null, partnerIdOverride = null) {
  if (!currentUser) return authPrompt();
  const conversationId = conversationIdOverride || new URLSearchParams(location.search).get("chat");
  if (!conversationId && !partnerIdOverride) return showToast("Open a partner chat or choose an online learner before starting a voice call.");
  if (activeCall && activeCall.status !== "ended") return showToast("Finish your current voice call first.");
  if (!navigator.mediaDevices?.getUserMedia) return showToast("Microphone access requires a supported browser and a secure connection (HTTPS or localhost).");
  try {
    localAudioStream = audioStream || await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const { call, request } = await api("/api/calls", {
      method: "POST",
      body: JSON.stringify(partnerIdOverride ? { partnerId: partnerIdOverride } : { conversationId }),
    });
    if (request) {
      const chats = readLocal("active-chat", []).filter((entry) => entry.conversationId !== request.conversationId);
      chats.push({ ...request, partner: call.peer });
      writeLocal("active-chat", chats);
      history.pushState({}, "", `?chat=${request.conversationId}`);
      setPage("chat");
    }
    activeCall = call;
    await createCallPeerConnection(call);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await api(`/api/calls/${call.id}/signals`, {
      method: "POST",
      body: JSON.stringify({ type: "offer", description: peerConnection.localDescription }),
    });
    activeCall.offer = peerConnection.localDescription;
    callConnectionLabel = `Calling ${escapeHtml(call.peer?.name || "your partner")}…`;
    renderCallNotice(activeCall);
    showToast("Calling your practice partner…");
  } catch (error) {
    if (activeCall?.callerId === currentUser.id) {
      try {
        await api(`/api/calls/${activeCall.id}/action`, { method: "POST", body: JSON.stringify({ action: "end" }) });
      } catch (endError) {
        console.error("Could not end the failed voice call:", endError);
      }
    }
    releaseCallMedia();
    activeCall = null;
    renderCallNotice(null);
    showToast(error.message);
  }
}

async function acceptVoiceCall() {
  if (!activeCall || activeCall.calleeId !== currentUser?.id) return;
  const call = activeCall;
  if (!navigator.mediaDevices?.getUserMedia) return showToast("Microphone access requires a supported browser and a secure connection (HTTPS or localhost).");
  let acceptedHere = false;
  try {
    localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    await createCallPeerConnection(call);
    const result = await api(`/api/calls/${call.id}/action`, { method: "POST", body: JSON.stringify({ action: "accept" }) });
    acceptedHere = true;
    activeCall = result.call;
    renderCallNotice(activeCall);
    await applyCallSignals(result.call);
  } catch (error) {
    if (acceptedHere) {
      try {
        await api(`/api/calls/${call.id}/action`, { method: "POST", body: JSON.stringify({ action: "end" }) });
      } catch (endError) {
        console.error("Could not end the failed voice call:", endError);
      }
      activeCall = null;
      renderCallNotice(null);
    }
    releaseCallMedia();
    showToast(error.message);
    if (error.message.includes("can no longer be accepted")) {
      activeCall = null;
      renderCallNotice(null);
    }
  }
}

async function declineVoiceCall() {
  if (!activeCall) return;
  try {
    await api(`/api/calls/${activeCall.id}/action`, { method: "POST", body: JSON.stringify({ action: "decline" }) });
    lastEndedCallId = activeCall.id;
    activeCall = null;
    releaseCallMedia();
    renderCallNotice(null);
  } catch (error) { showToast(error.message); }
}

async function endVoiceCall() {
  if (!activeCall) return;
  try {
    const { call } = await api(`/api/calls/${activeCall.id}/action`, { method: "POST", body: JSON.stringify({ action: "end" }) });
    lastEndedCallId = call.id;
    activeCall = null;
    releaseCallMedia();
    renderCallNotice(null);
    showToast("Voice call ended.");
  } catch (error) { showToast(error.message); }
}

function toggleCallMute() {
  const track = localAudioStream?.getAudioTracks()[0];
  if (!track) return showToast("Your microphone is not connected.");
  track.enabled = !track.enabled;
  renderCallNotice(activeCall);
  showToast(track.enabled ? "Microphone on." : "Microphone muted.");
}

async function connectPartner(id) {
  if (!currentUser) return authPrompt();
  try {
    await api("/api/requests", { method: "POST", body: JSON.stringify({ partnerId: id }) });
    showToast("Practice request sent. We'll let you know when they reply.");
    loadPartners();
  } catch (error) { showToast(error.message); }
}

async function quickMatch() {
  if (!currentUser) return authPrompt();
  try {
    await refreshPresence();
    const { request, partner } = await api("/api/quick-match", { method: "POST", body: "{}" });
    const chats = readLocal("active-chat", []).filter((entry) => entry.conversationId !== request.conversationId);
    chats.push({ ...request, partner });
    writeLocal("active-chat", chats);
    history.pushState({}, "", `?chat=${request.conversationId}`);
    setPage("chat");
    showToast(`Quick match found! Say hello to ${partner.name}.`);
  } catch (error) { showToast(error.message); }
}

async function quickHumanCall() {
  if (!currentUser) return authPrompt();
  if (quickHumanCallInProgress) return;
  if (activeCall && activeCall.status !== "ended") return showToast("Finish your current voice call first.");
  if (!currentUser.available) return showToast("Turn on your partner availability in your profile before starting a human call.");
  if (!navigator.mediaDevices?.getUserMedia) return showToast("Microphone access requires a supported browser and a secure connection (HTTPS or localhost).");
  quickHumanCallInProgress = true;
  const button = document.querySelector('[data-action="quick-human-call"]');
  if (button) {
    button.disabled = true;
    button.textContent = "Connecting…";
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const { request, partner } = await api("/api/quick-match", { method: "POST", body: "{}" });
    const chats = readLocal("active-chat", []).filter((entry) => entry.conversationId !== request.conversationId);
    chats.push({ ...request, partner });
    writeLocal("active-chat", chats);
    history.pushState({}, "", `?chat=${request.conversationId}`);
    setPage("chat");
    await startVoiceCall(request.conversationId, stream);
  } catch (error) {
    if (stream && !localAudioStream) stream.getTracks().forEach((track) => track.stop());
    showToast(error.message);
  } finally {
    quickHumanCallInProgress = false;
    const currentButton = document.querySelector('[data-action="quick-human-call"]');
    if (currentButton) {
      currentButton.disabled = false;
      currentButton.innerHTML = '<span aria-hidden="true">☎</span> Start Human Call';
    }
  }
}

async function joinRoom(id) {
  if (!currentUser) return authPrompt();
  try {
    await api(`/api/rooms/${id}`, { method: "POST", body: "{}" });
    selectedRoomId = id;
    history.pushState({}, "", `?room=${encodeURIComponent(id)}#rooms`);
    setPage("rooms");
    showToast("You joined the speaking circle.");
  } catch (error) { showToast(error.message); }
}

async function leaveRoom() {
  if (!selectedRoomId) return;
  const roomId = selectedRoomId;
  try {
    await api(`/api/rooms/${roomId}/leave`, { method: "POST", body: "{}" });
    selectedRoomId = null;
    history.pushState({}, "", "#rooms");
    setPage("rooms");
    showToast("You left the speaking room.");
  } catch (error) { showToast(error.message); }
}

async function updateRequest(id, status) {
  try {
    const { request } = await api(`/api/requests/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (status === "accepted") {
      const { requests } = await api("/api/requests");
      const chats = readLocal("active-chat", []).filter((entry) => entry.conversationId !== request.conversationId);
      chats.push({ ...request, partner: requests.find((entry) => entry.id === request.id)?.partner });
      writeLocal("active-chat", chats);
      history.pushState({}, "", `?chat=${request.conversationId}`);
      setPage("chat");
      showToast("Connected! Say hello to start your chat.");
    } else {
      showToast("Request declined.");
      loadPartners();
    }
  } catch (error) { showToast(error.message); }
}

async function reportOrBlock(targetId) {
  if (!targetId) return showToast("This conversation partner could not be identified.");
  const action = window.prompt("Type REPORT to report this person, or BLOCK to block and report them.");
  if (!action || !["REPORT", "BLOCK"].includes(action.trim().toUpperCase())) return;
  const type = action.trim().toLowerCase() === "block" ? "block" : "report";
  let reason = "";
  if (type === "report") reason = window.prompt("Optional: briefly tell us what happened.") || "";
  try {
    await api("/api/report", { method: "POST", body: JSON.stringify({ targetId, type, reason }) });
    if (type === "block") {
      const chats = readLocal("active-chat", []).filter((entry) => entry.partner?.id !== targetId);
      writeLocal("active-chat", chats);
      history.pushState({}, "", "/");
      setPage("partners");
    }
    showToast(type === "block" ? "User blocked and reported. You won't see them again." : "Report sent. Thank you for helping keep this community safe.");
  } catch (error) { showToast(error.message); }
}

document.addEventListener("click", async (event) => {
  const pageTarget = event.target.closest("[data-page]");
  if (pageTarget) {
    event.preventDefault();
    const page = pageTarget.dataset.page;
    if (page === "profile" && !currentUser) return authPrompt();
    history.pushState({}, "", page === "home" ? "/" : `#${page}`);
    return setPage(page);
  }
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;
  const { action, id } = actionTarget.dataset;
  if (action === "register") return authPrompt("register");
  if (action === "request") return connectPartner(id);
  if (action === "start-call") return startVoiceCall();
  if (action === "accept-call") return acceptVoiceCall();
  if (action === "decline-call") return declineVoiceCall();
  if (action === "hangup-call") return endVoiceCall();
  if (action === "mute-call") return toggleCallMute();
  if (action === "accept") return updateRequest(id, "accepted");
  if (action === "decline") return updateRequest(id, "declined");
  if (action === "open-chat") {
    try {
      const { requests } = await api("/api/requests");
      const accepted = requests.find((request) => request.id === id && request.status === "accepted");
      if (!accepted) return showToast("This conversation could not be found.");
      const chats = readLocal("active-chat", []).filter((entry) => entry.conversationId !== accepted.conversationId);
      chats.push(accepted);
      writeLocal("active-chat", chats);
      history.pushState({}, "", `?chat=${accepted.conversationId}`);
      return setPage("chat");
    } catch (error) { return showToast(error.message); }
  }
  if (action === "retry-partners") return loadPartners();
  if (action === "retry-rooms") return loadRooms();
  if (action === "quick-match") return quickMatch();
  if (action === "quick-human-call") return quickHumanCall();
  if (action === "call-partner") return callOnlinePartner(id);
  if (action === "join-room" || action === "open-room") return joinRoom(id);
  if (action === "leave-room") return leaveRoom();
  if (action === "complete-challenge") {
    const challenge = getDailyChallenge();
    localStorage.setItem(localKey("challenge"), challenge.date);
    showToast("Today's speaking prompt is complete. Great job showing up!");
    return renderPage();
  }
  if (action === "voice") return toggleVoiceInput();
  if (action === "finish-ai") return finishAI();
  if (action === "remove-word") {
    writeLocal("vocabulary", readLocal("vocabulary").filter((entry) => entry.id !== id));
    return renderPage();
  }
  if (action === "save-review-word") {
    const words = readLocal("vocabulary");
    const word = actionTarget.dataset.word;
    if (!words.some((entry) => entry.word.toLowerCase() === word.toLowerCase())) {
      words.unshift({ id: crypto.randomUUID(), word, example: `I can use “${word}” in my next conversation.` });
      writeLocal("vocabulary", words);
    }
    return showToast("Phrase saved to your vocabulary.");
  }
  if (action === "delete-account") {
    if (!window.confirm("Permanently delete your account and all associated profile, request, and chat data? This cannot be undone.")) return;
    try {
      await api("/api/account", { method: "DELETE" });
      const userId = currentUser.id;
      localStorage.removeItem(USER_KEY);
      ["sessions", "vocabulary", "goal", "active-chat"].forEach((kind) => localStorage.removeItem(`speakup-${kind}-${userId}`));
      releaseCallMedia();
      activeCall = null;
      renderCallNotice(null);
      currentUser = null;
      showToast("Your account has been deleted.");
      return setPage("home");
    } catch (error) { return showToast(error.message); }
  }
  if (action === "report") return reportOrBlock(id);
});

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.page === "profile" && !currentUser) return authPrompt();
  history.pushState({}, "", button.dataset.page === "home" ? "/" : `#${button.dataset.page}`);
  setPage(button.dataset.page);
}));

document.querySelector("#auth-button").addEventListener("click", async () => {
  if (!currentUser) return authPrompt("login");
  try {
    if (activeCall) await endVoiceCall();
    await api("/api/logout", { method: "POST" });
    clearInterval(presenceRefresh);
    presenceRefresh = null;
    releaseCallMedia();
    activeCall = null;
    currentUser = null;
    localStorage.removeItem(USER_KEY);
    updateShell();
    showToast("You have logged out.");
    setPage("home");
  } catch (error) { showToast(error.message); }
});
document.querySelector("#register-tab").addEventListener("click", () => setAuthMode("register"));
document.querySelector("#login-tab").addEventListener("click", () => setAuthMode("login"));
document.querySelector("#language-toggle").addEventListener("click", () => {
  hindiHints = !hindiHints;
  document.querySelector("#language-toggle").setAttribute("aria-pressed", String(hindiHints));
  document.body.classList.toggle("hindi-hints", hindiHints);
  showToast(hindiHints ? "Hindi learning hints are on." : "Hindi learning hints are off.");
});

document.querySelector("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  const endpoint = authMode === "register" ? "/api/register" : "/api/login";
  try {
    const { user } = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    currentUser = user;
    aiLevel = user.level || "Beginner";
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    document.querySelector("#auth-form").reset();
    authDialog.close();
    updateShell();
    showToast(authMode === "register" ? "Welcome to SpeakUp! You're all set." : "Welcome back. Let's keep practicing!");
    setPage(currentPage);
  } catch (error) {
    document.querySelector("#auth-error").textContent = error.message;
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "ai-form") {
    event.preventDefault();
    startAIChat();
  }
  if (event.target.id === "vocab-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    const words = readLocal("vocabulary");
    words.unshift({ id: crypto.randomUUID(), word: String(data.get("word")).trim(), example: String(data.get("example") || "").trim() });
    writeLocal("vocabulary", words);
    renderPage();
    showToast("Word saved to your vocabulary.");
  }
  if (event.target.id === "profile-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    const body = Object.fromEntries(data.entries());
    body.available = data.get("available") === "on";
    try {
      const { user } = await api("/api/profile", { method: "PATCH", body: JSON.stringify(body) });
      currentUser = user;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      refreshPresence();
      renderPage();
      showToast("Your profile has been updated.");
    } catch (error) {
      document.querySelector("#profile-error").textContent = error.message;
    }
  }
  if (event.target.id === "partner-chat-form") {
    event.preventDefault();
    const conversationId = new URLSearchParams(location.search).get("chat");
    const input = event.target.elements.text;
    try {
      await api(`/api/chat/${conversationId}`, { method: "POST", body: JSON.stringify({ text: input.value }) });
      input.value = "";
      await refreshChat();
    } catch (error) { showToast(error.message); }
  }
  if (event.target.id === "room-create-form") {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const { room } = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name: form.get("name"), topic: form.get("topic") }) });
      selectedRoomId = room.id;
      history.pushState({}, "", `?room=${encodeURIComponent(room.id)}#rooms`);
      setPage("rooms");
      showToast("Your speaking room is open. Invite learners to join!");
    } catch (error) { showToast(error.message); }
  }
  if (event.target.id === "room-chat-form") {
    event.preventDefault();
    const input = event.target.elements.text;
    try {
      await api(`/api/rooms/${selectedRoomId}/messages`, { method: "POST", body: JSON.stringify({ text: input.value }) });
      input.value = "";
      await refreshRoomMessages();
    } catch (error) { showToast(error.message); }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "partner-search") loadPartners();
});
document.addEventListener("change", (event) => {
  if (event.target.id === "partner-level") loadPartners();
  if (event.target.id === "topic-select") aiTopic = event.target.value;
  if (event.target.id === "ai-level") aiLevel = event.target.value;
  if (event.target.id === "daily-goal") {
    localStorage.setItem(localKey("goal"), event.target.value);
    renderPage();
  }
});

function renderChat() {
  const conversationId = new URLSearchParams(location.search).get("chat");
  const request = readLocal("active-chat", []).find((entry) => entry.conversationId === conversationId);
  if (!request || !currentUser) return `${pageHeading("PRACTICE TOGETHER", "Conversation", "Your chat is ready.")}<div class="empty-state"><strong>Choose a conversation to open</strong>Accept a practice request or ask a learner to connect.<br><br><button class="button button-primary" data-page="partners">Find a partner</button></div>`;
  queueMicrotask(refreshChat);
  return `${pageHeading("PRACTICE TOGETHER", `A chat with ${escapeHtml(request.partner?.name || "your partner")}`, "Say hello and help each other practice English.", `<button class="button button-outline" data-action="report" data-id="${escapeHtml(request.partner?.id || "")}">Report / block</button>`)}
    <section class="chat-panel"><div class="chat-header"><div><strong>${escapeHtml(request.partner?.name || "Your practice partner")}</strong><small>Text and private voice practice · Be kind and respectful</small></div><button class="button button-primary" data-action="start-call">Call partner</button></div><div class="call-info" style="margin:10px 12px 0">Voice calls connect learners across India. Allow microphone access when your browser asks. A secure HTTPS connection is required outside localhost.</div><div class="chat-window conversation-window" id="partner-chat"><div class="empty-state">Loading your conversation…</div></div><form class="chat-composer" id="partner-chat-form"><input name="text" maxlength="2000" required placeholder="Write a kind message in English…" aria-label="Message to your practice partner"><button class="button button-primary">Send <span>→</span></button></form></section>`;
}

window.addEventListener("popstate", () => {
  const page = location.hash.slice(1);
  selectedRoomId = new URLSearchParams(location.search).get("room");
  setPage(page || (location.search.includes("chat=") ? "chat" : "home"));
});

async function initialize() {
  try {
    const { user } = await api("/api/me");
    currentUser = user;
    aiLevel = user.level || "Beginner";
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch (error) {
    if (error.message !== "Please sign in to continue.") console.error("Session restore failed:", error);
    currentUser = null;
    localStorage.removeItem(USER_KEY);
  }
  selectedRoomId = new URLSearchParams(location.search).get("room");
  const page = location.hash.slice(1);
  setPage(page || (location.search.includes("chat=") ? "chat" : "home"));
}

initialize();
