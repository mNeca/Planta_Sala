const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const ROWS = 3;
const COLS = 6;
const TOTAL_DESKS = ROWS * COLS;

function createInitialState() {
  return {
    status: "idle", // idle | placing | done
    studentCount: 0,
    assigned: {}, // deskId -> studentName
    students: {}, // studentId -> { id, name, assignedDesk }
    pendingIds: [], // students who still need a seat this round
    picks: {}, // studentId -> deskId (current round)
    round: 0,
  };
}

let state = createInitialState();

function getAvailableDesks() {
  const available = [];
  for (let i = 0; i < TOTAL_DESKS; i++) {
    if (!state.assigned[String(i)]) available.push(String(i));
  }
  return available;
}

function newStudentId() {
  return crypto.randomUUID();
}

function stateFor(socket) {
  const isTeacher = socket.role === "teacher";
  const studentId = socket.studentId;
  const me = studentId ? state.students[studentId] : null;

  // Teacher sees every claim; students only see their own pick.
  const deskClaims = {};
  for (const [sid, deskId] of Object.entries(state.picks)) {
    if (!isTeacher && sid !== studentId) continue;
    if (!deskClaims[deskId]) deskClaims[deskId] = [];
    const student = state.students[sid];
    deskClaims[deskId].push(student ? student.name : "???");
  }

  // Teacher sees all assigned names; students only see their own name
  // on their seat (other taken desks stay occupied but unnamed).
  const assigned = {};
  for (const [deskId, name] of Object.entries(state.assigned)) {
    if (isTeacher || (me && me.name === name)) {
      assigned[deskId] = name;
    } else {
      assigned[deskId] = null; // taken, name hidden
    }
  }

  const students = isTeacher
    ? Object.values(state.students).map((s) => ({
        id: s.id,
        name: s.name,
        assignedDesk: s.assignedDesk,
        hasPicked: state.picks[s.id] !== undefined,
        isPending: state.pendingIds.includes(s.id),
      }))
    : me
      ? [
          {
            id: me.id,
            name: me.name,
            assignedDesk: me.assignedDesk,
            hasPicked: state.picks[me.id] !== undefined,
            isPending: state.pendingIds.includes(me.id),
          },
        ]
      : [];

  return {
    status: state.status,
    studentCount: state.studentCount,
    assigned,
    pendingCount: state.pendingIds.length,
    joinedCount: Object.keys(state.students).length,
    picksCount: Object.keys(state.picks).length,
    deskClaims,
    round: state.round,
    students,
    availableDesks: getAvailableDesks(),
    viewer: isTeacher ? "teacher" : studentId ? "student" : "guest",
  };
}

function broadcast() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit("state", stateFor(socket));
  }
}

function resolveRound() {
  const claims = {};
  for (const [studentId, deskId] of Object.entries(state.picks)) {
    const desk = String(deskId);
    if (!claims[desk]) claims[desk] = [];
    // Keep unique student ids per desk (guards against duplicated pending state)
    if (!claims[desk].includes(studentId)) {
      claims[desk].push(studentId);
    }
  }

  const stillPending = [];

  for (const [deskId, studentIds] of Object.entries(claims)) {
    if (studentIds.length === 1) {
      const studentId = studentIds[0];
      const student = state.students[studentId];
      if (student) {
        state.assigned[deskId] = student.name;
        student.assignedDesk = deskId;
      }
    } else {
      // Conflict: nobody gets this desk; all claimants pick again
      stillPending.push(...studentIds);
    }
  }

  // Students who never picked this round stay pending
  for (const id of state.pendingIds) {
    if (state.picks[id] === undefined && !stillPending.includes(id)) {
      stillPending.push(id);
    }
  }

  state.picks = {};
  state.pendingIds = [...new Set(stillPending)];
  state.round += 1;

  const available = getAvailableDesks();
  if (state.pendingIds.length === 0 || available.length === 0) {
    state.status = "done";
    state.pendingIds = [];
  }
}

function everyoneJoined() {
  return Object.keys(state.students).length >= state.studentCount;
}

function tryAutoResolve() {
  if (state.status !== "placing") return false;
  if (!everyoneJoined()) return false;
  if (state.pendingIds.length === 0) return false;

  const allPicked = state.pendingIds.every(
    (id) => state.picks[id] !== undefined
  );
  if (!allPicked) return false;

  resolveRound();
  return true;
}

io.on("connection", (socket) => {
  socket.emit("state", stateFor(socket));

  socket.on("role:set", ({ role }) => {
    if (role === "teacher" || role === "student") {
      socket.role = role;
      socket.emit("state", stateFor(socket));
    }
  });

  socket.on("teacher:start", ({ studentCount }) => {
    if (socket.role !== "teacher") {
      socket.emit("error", { message: "Only the teacher can start placement." });
      return;
    }

    const count = Number(studentCount);
    if (!Number.isInteger(count) || count < 1 || count > TOTAL_DESKS) {
      socket.emit("error", {
        message: `Number of students must be between 1 and ${TOTAL_DESKS}.`,
      });
      return;
    }

    state = createInitialState();
    state.status = "placing";
    state.studentCount = count;
    state.round = 1;
    broadcast();
  });

  socket.on("teacher:reset", () => {
    if (socket.role !== "teacher") {
      socket.emit("error", { message: "Only the teacher can reset." });
      return;
    }
    state = createInitialState();
    broadcast();
  });

  socket.on("teacher:resolve", () => {
    if (socket.role !== "teacher") {
      socket.emit("error", { message: "Only the teacher can resolve a round." });
      return;
    }
    if (state.status !== "placing") return;
    if (Object.keys(state.picks).length === 0) return;
    resolveRound();
    broadcast();
  });

  socket.on("student:join", ({ name }) => {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      socket.emit("error", { message: "Please enter your name." });
      return;
    }
    if (state.status !== "placing") {
      socket.emit("error", { message: "Placement has not started yet." });
      return;
    }

    socket.role = "student";

    // Reconnect: same name keeps the same student identity
    const existing = Object.values(state.students).find(
      (s) => s.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) {
      socket.studentId = existing.id;
      socket.emit("joined", { studentId: existing.id, name: existing.name });
      socket.emit("state", stateFor(socket));
      return;
    }

    // This socket is already seated/joined as someone else — don't overwrite them
    if (socket.studentId && state.students[socket.studentId]) {
      socket.emit("error", {
        message: `You are already joined as ${state.students[socket.studentId].name}. Open another browser/tab for a different student.`,
      });
      return;
    }

    if (Object.keys(state.students).length >= state.studentCount) {
      socket.emit("error", {
        message: "All student slots are already taken.",
      });
      return;
    }

    const id = newStudentId();
    state.students[id] = { id, name: trimmed, assignedDesk: null };
    if (!state.pendingIds.includes(id)) {
      state.pendingIds.push(id);
    }
    socket.studentId = id;
    socket.emit("joined", { studentId: id, name: trimmed });
    broadcast();
  });

  socket.on("student:pick", ({ deskId }) => {
    const studentId = socket.studentId;
    if (!studentId || !state.students[studentId]) {
      socket.emit("error", { message: "Join with your name first." });
      return;
    }
    if (state.status !== "placing") {
      socket.emit("error", { message: "Placement is not active." });
      return;
    }
    if (!state.pendingIds.includes(studentId)) {
      socket.emit("error", { message: "You already have a seat." });
      return;
    }

    const desk = String(deskId);
    if (!getAvailableDesks().includes(desk)) {
      socket.emit("error", { message: "That desk is not available." });
      return;
    }

    state.picks[studentId] = desk;
    tryAutoResolve();
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Classroom seat allocator running at http://localhost:${PORT}`);
});
