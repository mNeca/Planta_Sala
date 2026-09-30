/* global Peer, PlantaGame */

const { ROWS, COLS, GameSession } = PlantaGame;
const PEER_PREFIX = "plantasala-";

const els = {
  menu: document.getElementById("view-menu"),
  teacher: document.getElementById("view-teacher"),
  student: document.getElementById("view-student"),
  formStart: document.getElementById("form-start"),
  formJoin: document.getElementById("form-join"),
  studentCount: document.getElementById("student-count"),
  studentName: document.getElementById("student-name"),
  roomCodeInput: document.getElementById("room-code"),
  teacherStatus: document.getElementById("teacher-status"),
  studentStatus: document.getElementById("student-status"),
  sessionBanner: document.getElementById("session-banner"),
  desks: document.getElementById("desks"),
  toast: document.getElementById("toast"),
  btnTeacher: document.getElementById("btn-teacher"),
  btnStudent: document.getElementById("btn-student"),
  btnResolve: document.getElementById("btn-resolve"),
  btnReset: document.getElementById("btn-reset"),
  btnCopyRoom: document.getElementById("btn-copy-room"),
  roomDisplay: document.getElementById("room-display"),
  roomCodeText: document.getElementById("room-code-text"),
  connectionStatus: document.getElementById("connection-status"),
};

let role = null; // 'teacher' | 'student'
let me = null; // { studentId, name }
let state = null;
let toastTimer = null;
let roomCode = "";

/** @type {GameSession | null} */
let session = null;
/** @type {import('peerjs').Peer | null} */
let peer = null;
/** @type {Map<string, { conn: any, role: string | null, studentId: string | null }>} */
const clients = new Map();
/** @type {any} */
let hostConn = null;

function showView(view) {
  els.menu.classList.toggle("hidden", view !== "menu");
  els.teacher.classList.toggle("hidden", view !== "teacher");
  els.student.classList.toggle("hidden", view !== "student");
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3200);
}

function setConnectionStatus(text, kind = "muted") {
  els.connectionStatus.textContent = text;
  els.connectionStatus.dataset.kind = kind;
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function peerIdFor(code) {
  return PEER_PREFIX + String(code).trim().toUpperCase();
}

function parseRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const room = (params.get("room") || "").trim().toUpperCase();
  return room || "";
}

function updateUrlRoom(code) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.replaceState(null, "", url);
}

function shareUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  return url.toString();
}

function destroyPeer() {
  for (const { conn } of clients.values()) {
    try {
      conn.close();
    } catch (_) {
      /* ignore */
    }
  }
  clients.clear();
  if (hostConn) {
    try {
      hostConn.close();
    } catch (_) {
      /* ignore */
    }
    hostConn = null;
  }
  if (peer) {
    try {
      peer.destroy();
    } catch (_) {
      /* ignore */
    }
    peer = null;
  }
}

function send(conn, type, payload = {}) {
  if (!conn || !conn.open) return;
  conn.send({ type, ...payload });
}

function broadcastState() {
  if (!session) return;
  state = session.stateFor({ role: "teacher", studentId: null });
  render();

  for (const client of clients.values()) {
    if (!client.conn.open) continue;
    const viewer = {
      role: client.role === "teacher" ? "teacher" : "student",
      studentId: client.studentId,
    };
    send(client.conn, "state", { state: session.stateFor(viewer) });
  }
}

function handleHostMessage(client, msg) {
  if (!session || !msg || !msg.type) return;

  switch (msg.type) {
    case "role:set": {
      if (msg.role === "teacher" || msg.role === "student") {
        client.role = msg.role;
        send(client.conn, "state", {
          state: session.stateFor({
            role: client.role,
            studentId: client.studentId,
          }),
        });
      }
      break;
    }
    case "teacher:start": {
      if (client.role !== "teacher") {
        send(client.conn, "error", {
          message: "Only the teacher can start placement.",
        });
        return;
      }
      const result = session.start(msg.studentCount);
      if (!result.ok) {
        send(client.conn, "error", { message: result.error });
        return;
      }
      broadcastState();
      break;
    }
    case "teacher:reset": {
      if (client.role !== "teacher") {
        send(client.conn, "error", { message: "Only the teacher can reset." });
        return;
      }
      session.reset();
      broadcastState();
      break;
    }
    case "teacher:resolve": {
      if (client.role !== "teacher") {
        send(client.conn, "error", {
          message: "Only the teacher can resolve a round.",
        });
        return;
      }
      session.forceResolve();
      broadcastState();
      break;
    }
    case "student:join": {
      const result = session.join(msg.name, client.studentId);
      if (!result.ok) {
        send(client.conn, "error", { message: result.error });
        return;
      }
      client.role = "student";
      client.studentId = result.studentId;
      send(client.conn, "joined", {
        studentId: result.studentId,
        name: result.name,
      });
      broadcastState();
      break;
    }
    case "student:pick": {
      const result = session.pick(client.studentId, msg.deskId);
      if (!result.ok) {
        send(client.conn, "error", { message: result.error });
        return;
      }
      broadcastState();
      break;
    }
    default:
      break;
  }
}

function attachClient(conn) {
  const client = { conn, role: null, studentId: null };
  clients.set(conn.peer, client);

  conn.on("data", (msg) => handleHostMessage(client, msg));
  conn.on("close", () => clients.delete(conn.peer));
  conn.on("error", () => clients.delete(conn.peer));

  // Push current snapshot once the data channel is ready
  if (session) {
    send(conn, "state", {
      state: session.stateFor({ role: "guest", studentId: null }),
    });
  }
}

function startAsHost(preferredCode) {
  destroyPeer();
  session = new GameSession();
  me = null;
  state = session.stateFor({ role: "teacher", studentId: null });

  const code = (preferredCode || makeRoomCode()).toUpperCase();
  roomCode = code;
  els.roomCodeText.textContent = code;
  els.roomDisplay.classList.remove("hidden");
  updateUrlRoom(code);
  setConnectionStatus("Opening room…", "muted");

  peer = new Peer(peerIdFor(code), { debug: 0 });

  peer.on("open", () => {
    setConnectionStatus("Room open — share the code with students", "ok");
    broadcastState();
  });

  peer.on("connection", (conn) => {
    conn.on("open", () => attachClient(conn));
  });

  peer.on("error", (err) => {
    const type = err?.type || "";
    if (type === "unavailable-id") {
      toast("Room code taken — creating a new one…");
      startAsHost(makeRoomCode());
      return;
    }
    setConnectionStatus("Connection error — try refreshing", "error");
    toast(err?.message || "Could not open room");
  });

  peer.on("disconnected", () => {
    setConnectionStatus("Disconnected — reconnecting…", "error");
    try {
      peer.reconnect();
    } catch (_) {
      /* ignore */
    }
  });
}

function connectAsStudent(code) {
  const normalized = String(code || "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    toast("Enter the room code from the teacher.");
    return;
  }

  destroyPeer();
  session = null;
  roomCode = normalized;
  updateUrlRoom(normalized);
  setConnectionStatus("Connecting to room…", "muted");

  peer = new Peer({ debug: 0 });

  peer.on("open", () => {
    hostConn = peer.connect(peerIdFor(normalized), { reliable: true });

    hostConn.on("open", () => {
      setConnectionStatus(`Connected to room ${normalized}`, "ok");
      send(hostConn, "role:set", { role: "student" });
    });

    hostConn.on("data", (msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "state") {
        state = msg.state;
        render();
      } else if (msg.type === "joined") {
        me = { studentId: msg.studentId, name: msg.name };
        toast(`Joined as ${msg.name}`);
        render();
      } else if (msg.type === "error") {
        toast(msg.message);
      }
    });

    hostConn.on("close", () => {
      setConnectionStatus("Disconnected from teacher room", "error");
    });

    hostConn.on("error", () => {
      setConnectionStatus("Could not reach room", "error");
      toast("Could not connect. Check the room code and that the teacher tab is open.");
    });
  });

  peer.on("error", (err) => {
    setConnectionStatus("Connection error", "error");
    toast(err?.message || "Connection failed");
  });
}

function emitToHost(type, payload = {}) {
  if (role === "teacher" && session) {
    if (type === "teacher:start") {
      const result = session.start(payload.studentCount);
      if (!result.ok) {
        toast(result.error);
        return;
      }
      broadcastState();
      return;
    }
    if (type === "teacher:reset") {
      session.reset();
      broadcastState();
      return;
    }
    if (type === "teacher:resolve") {
      session.forceResolve();
      broadcastState();
      return;
    }
  }
  if (!hostConn || !hostConn.open) {
    toast("Not connected to a room yet.");
    return;
  }
  send(hostConn, type, payload);
}

function buildDesks() {
  els.desks.innerHTML = "";
  for (let r = 0; r < ROWS; r++) {
    const row = document.createElement("div");
    row.className = "desk-row";
    for (let c = 0; c < COLS; c++) {
      const id = String(r * COLS + c);
      const desk = document.createElement("button");
      desk.type = "button";
      desk.className = "desk";
      desk.dataset.deskId = id;
      desk.setAttribute("aria-label", `Desk ${Number(id) + 1}`);
      desk.addEventListener("click", () => onDeskClick(id));
      row.appendChild(desk);
    }
    els.desks.appendChild(row);
  }
}

function onDeskClick(deskId) {
  if (role !== "student" || !me || !state) return;
  if (state.status !== "placing") return;

  const mine = state.students.find((s) => s.id === me.studentId);
  if (!mine || !mine.isPending) return;
  if (!state.availableDesks.includes(deskId)) return;

  emitToHost("student:pick", { deskId });
}

function renderDesks() {
  if (!state) return;

  const isTeacher = role === "teacher";
  const canPick =
    role === "student" &&
    me &&
    state.status === "placing" &&
    state.students.some((s) => s.id === me.studentId && s.isPending);

  document.querySelectorAll(".desk").forEach((desk) => {
    const id = desk.dataset.deskId;
    const assigned = Object.prototype.hasOwnProperty.call(state.assigned, id);
    const assignedName = state.assigned[id];
    const claimants = state.deskClaims[id] || [];

    desk.className = "desk";
    desk.disabled = false;

    if (assigned) {
      desk.classList.add("assigned");
      desk.textContent = assignedName || "";
      desk.disabled = true;
      return;
    }

    if (claimants.length > 1) {
      desk.classList.add("conflict");
      desk.textContent = isTeacher ? claimants.join(", ") : claimants[0] || "";
    } else if (claimants.length === 1) {
      if (!isTeacher) desk.classList.add("mine");
      desk.textContent = claimants[0];
    } else {
      desk.textContent = "";
    }

    if (canPick && state.availableDesks.includes(id)) {
      desk.classList.add("selectable");
    } else if (!assigned) {
      desk.classList.add("disabled");
      if (!claimants.length) desk.disabled = true;
    }
  });
}

function renderStatus() {
  if (!state) return;

  if (state.status === "idle") {
    els.sessionBanner.textContent =
      "Waiting for the teacher to start placement…";
  } else if (state.status === "placing") {
    const parts = [
      `Round ${state.round}`,
      `${state.joinedCount}/${state.studentCount} joined`,
      `${state.picksCount}/${state.pendingCount} picks this round`,
    ];
    els.sessionBanner.textContent = parts.join(" · ");
  } else if (state.status === "done") {
    const seated = Object.keys(state.assigned).length;
    els.sessionBanner.textContent = `Placement finished — ${seated} seat(s) assigned.`;
  }

  if (state.status === "idle") {
    els.teacherStatus.className = "status-box empty";
    els.teacherStatus.textContent = "No active session.";
  } else {
    els.teacherStatus.className = "status-box";
    const assignedList = Object.entries(state.assigned)
      .filter(([, name]) => name)
      .map(([desk, name]) => `${name} → desk ${Number(desk) + 1}`)
      .join("; ");
    const pending = state.students.filter((s) => s.isPending).map((s) => s.name);
    els.teacherStatus.innerHTML = [
      `<strong>Status:</strong> ${state.status}`,
      `<br><strong>Assigned:</strong> ${assignedList || "none yet"}`,
      pending.length
        ? `<br><strong>Still choosing:</strong> ${pending.join(", ")}`
        : "",
      state.status === "placing"
        ? `<br>When several students pick the same desk, they must choose again among the free ones.`
        : "",
    ].join("");
  }

  if (!me) {
    els.studentStatus.className = "status-box empty";
    els.studentStatus.textContent =
      state.status === "placing"
        ? "Enter your name to join the placement."
        : "Wait for the teacher to start, then join with your name.";
  } else {
    const mine = state.students.find((s) => s.id === me.studentId);
    els.studentStatus.className = "status-box";
    if (mine?.assignedDesk != null) {
      els.studentStatus.textContent = `You are seated at desk ${
        Number(mine.assignedDesk) + 1
      }.`;
    } else if (mine?.isPending && mine?.hasPicked) {
      els.studentStatus.textContent =
        "Pick submitted. Waiting for others… If your desk has a conflict, you will pick again.";
    } else if (mine?.isPending) {
      els.studentStatus.textContent =
        "Select an available desk on the plan below.";
    } else {
      els.studentStatus.textContent = `Joined as ${me.name}.`;
    }
  }

  els.btnResolve.disabled = state.status !== "placing" || state.picksCount === 0;
}

function render() {
  renderDesks();
  renderStatus();
}

els.btnTeacher.addEventListener("click", () => {
  role = "teacher";
  me = null;
  showView("teacher");
  startAsHost(parseRoomFromUrl() || makeRoomCode());
  render();
});

els.btnStudent.addEventListener("click", () => {
  role = "student";
  me = null;
  showView("student");
  const fromUrl = parseRoomFromUrl();
  if (fromUrl) {
    els.roomCodeInput.value = fromUrl;
    connectAsStudent(fromUrl);
  } else {
    setConnectionStatus("Enter the room code to connect", "muted");
  }
  render();
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    role = null;
    me = null;
    state = null;
    destroyPeer();
    els.roomDisplay.classList.add("hidden");
    setConnectionStatus("");
    showView("menu");
  });
});

els.formStart.addEventListener("submit", (e) => {
  e.preventDefault();
  const studentCount = Number(els.studentCount.value);
  emitToHost("teacher:start", { studentCount });
});

els.btnReset.addEventListener("click", () => {
  if (confirm("Reset the whole placement session?")) {
    emitToHost("teacher:reset");
  }
});

els.btnResolve.addEventListener("click", () => {
  emitToHost("teacher:resolve");
});

els.formJoin.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = els.roomCodeInput.value.trim();
  const name = els.studentName.value.trim();
  if (!name) return;

  if (!hostConn || !hostConn.open || roomCode !== code.toUpperCase()) {
    connectAsStudent(code);
    const started = Date.now();
    const wait = () => {
      if (hostConn && hostConn.open) {
        send(hostConn, "student:join", { name });
      } else if (Date.now() - started < 12000) {
        setTimeout(wait, 200);
      } else {
        toast("Timed out connecting to the room.");
      }
    };
    wait();
    return;
  }

  emitToHost("student:join", { name });
});

els.btnCopyRoom.addEventListener("click", async () => {
  if (!roomCode) return;
  const link = shareUrl(roomCode);
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite link copied");
  } catch (_) {
    toast(`Room code: ${roomCode}`);
  }
});

buildDesks();
showView("menu");

const initialRoom = parseRoomFromUrl();
if (initialRoom) {
  els.roomCodeInput.value = initialRoom;
}
