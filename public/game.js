const ROWS = 3;
const COLS = 6;
const TOTAL_DESKS = ROWS * COLS;

function createInitialState() {
  return {
    status: "idle", // idle | placing | done
    studentCount: 0,
    assigned: {}, // deskId -> studentName
    students: {}, // studentId -> { id, name, assignedDesk }
    pendingIds: [],
    picks: {}, // studentId -> deskId
    round: 0,
  };
}

function newStudentId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Authoritative classroom session (runs in the teacher / host browser). */
class GameSession {
  constructor() {
    this.state = createInitialState();
  }

  reset() {
    this.state = createInitialState();
  }

  getAvailableDesks() {
    const available = [];
    for (let i = 0; i < TOTAL_DESKS; i++) {
      if (!this.state.assigned[String(i)]) available.push(String(i));
    }
    return available;
  }

  stateFor(viewer) {
    const isTeacher = viewer.role === "teacher";
    const studentId = viewer.studentId || null;
    const me = studentId ? this.state.students[studentId] : null;

    const deskClaims = {};
    for (const [sid, deskId] of Object.entries(this.state.picks)) {
      if (!isTeacher && sid !== studentId) continue;
      if (!deskClaims[deskId]) deskClaims[deskId] = [];
      const student = this.state.students[sid];
      deskClaims[deskId].push(student ? student.name : "???");
    }

    const assigned = {};
    for (const [deskId, name] of Object.entries(this.state.assigned)) {
      if (isTeacher || (me && me.name === name)) {
        assigned[deskId] = name;
      } else {
        assigned[deskId] = null;
      }
    }

    const students = isTeacher
      ? Object.values(this.state.students).map((s) => ({
          id: s.id,
          name: s.name,
          assignedDesk: s.assignedDesk,
          hasPicked: this.state.picks[s.id] !== undefined,
          isPending: this.state.pendingIds.includes(s.id),
        }))
      : me
        ? [
            {
              id: me.id,
              name: me.name,
              assignedDesk: me.assignedDesk,
              hasPicked: this.state.picks[me.id] !== undefined,
              isPending: this.state.pendingIds.includes(me.id),
            },
          ]
        : [];

    return {
      status: this.state.status,
      studentCount: this.state.studentCount,
      assigned,
      pendingCount: this.state.pendingIds.length,
      joinedCount: Object.keys(this.state.students).length,
      picksCount: Object.keys(this.state.picks).length,
      deskClaims,
      round: this.state.round,
      students,
      availableDesks: this.getAvailableDesks(),
      viewer: isTeacher ? "teacher" : studentId ? "student" : "guest",
    };
  }

  resolveRound() {
    const claims = {};
    for (const [studentId, deskId] of Object.entries(this.state.picks)) {
      const desk = String(deskId);
      if (!claims[desk]) claims[desk] = [];
      if (!claims[desk].includes(studentId)) {
        claims[desk].push(studentId);
      }
    }

    const stillPending = [];

    for (const [deskId, studentIds] of Object.entries(claims)) {
      if (studentIds.length === 1) {
        const studentId = studentIds[0];
        const student = this.state.students[studentId];
        if (student) {
          this.state.assigned[deskId] = student.name;
          student.assignedDesk = deskId;
        }
      } else {
        stillPending.push(...studentIds);
      }
    }

    for (const id of this.state.pendingIds) {
      if (this.state.picks[id] === undefined && !stillPending.includes(id)) {
        stillPending.push(id);
      }
    }

    this.state.picks = {};
    this.state.pendingIds = [...new Set(stillPending)];
    this.state.round += 1;

    const available = this.getAvailableDesks();
    if (this.state.pendingIds.length === 0 || available.length === 0) {
      this.state.status = "done";
      this.state.pendingIds = [];
    }
  }

  everyoneJoined() {
    return Object.keys(this.state.students).length >= this.state.studentCount;
  }

  tryAutoResolve() {
    if (this.state.status !== "placing") return false;
    if (!this.everyoneJoined()) return false;
    if (this.state.pendingIds.length === 0) return false;

    const allPicked = this.state.pendingIds.every(
      (id) => this.state.picks[id] !== undefined
    );
    if (!allPicked) return false;

    this.resolveRound();
    return true;
  }

  start(studentCount) {
    const count = Number(studentCount);
    if (!Number.isInteger(count) || count < 1 || count > TOTAL_DESKS) {
      return {
        ok: false,
        error: `Number of students must be between 1 and ${TOTAL_DESKS}.`,
      };
    }
    this.state = createInitialState();
    this.state.status = "placing";
    this.state.studentCount = count;
    this.state.round = 1;
    return { ok: true };
  }

  forceResolve() {
    if (this.state.status !== "placing") return { ok: false };
    if (Object.keys(this.state.picks).length === 0) return { ok: false };
    this.resolveRound();
    return { ok: true };
  }

  join(name, existingStudentId) {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      return { ok: false, error: "Please enter your name." };
    }
    if (this.state.status !== "placing") {
      return { ok: false, error: "Placement has not started yet." };
    }

    const existing = Object.values(this.state.students).find(
      (s) => s.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) {
      return {
        ok: true,
        studentId: existing.id,
        name: existing.name,
        rejoined: true,
      };
    }

    if (existingStudentId && this.state.students[existingStudentId]) {
      return {
        ok: false,
        error: `You are already joined as ${this.state.students[existingStudentId].name}. Open another browser/tab for a different student.`,
      };
    }

    if (Object.keys(this.state.students).length >= this.state.studentCount) {
      return { ok: false, error: "All student slots are already taken." };
    }

    const id = newStudentId();
    this.state.students[id] = { id, name: trimmed, assignedDesk: null };
    if (!this.state.pendingIds.includes(id)) {
      this.state.pendingIds.push(id);
    }
    return { ok: true, studentId: id, name: trimmed, rejoined: false };
  }

  pick(studentId, deskId) {
    if (!studentId || !this.state.students[studentId]) {
      return { ok: false, error: "Join with your name first." };
    }
    if (this.state.status !== "placing") {
      return { ok: false, error: "Placement is not active." };
    }
    if (!this.state.pendingIds.includes(studentId)) {
      return { ok: false, error: "You already have a seat." };
    }

    const desk = String(deskId);
    if (!this.getAvailableDesks().includes(desk)) {
      return { ok: false, error: "That desk is not available." };
    }

    this.state.picks[studentId] = desk;
    this.tryAutoResolve();
    return { ok: true };
  }
}

window.PlantaGame = { ROWS, COLS, TOTAL_DESKS, GameSession };
