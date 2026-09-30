const ROWS = 3;
const COLS = 6;

const socket = io();

const els = {
  menu: document.getElementById("view-menu"),
  teacher: document.getElementById("view-teacher"),
  student: document.getElementById("view-student"),
  formStart: document.getElementById("form-start"),
  formJoin: document.getElementById("form-join"),
  studentCount: document.getElementById("student-count"),
  studentName: document.getElementById("student-name"),
  teacherStatus: document.getElementById("teacher-status"),
  studentStatus: document.getElementById("student-status"),
  sessionBanner: document.getElementById("session-banner"),
  desks: document.getElementById("desks"),
  toast: document.getElementById("toast"),
  btnTeacher: document.getElementById("btn-teacher"),
  btnStudent: document.getElementById("btn-student"),
  btnResolve: document.getElementById("btn-resolve"),
  btnReset: document.getElementById("btn-reset"),
};

let role = null; // 'teacher' | 'student'
let me = null; // { studentId, name }
let state = null;
let toastTimer = null;

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

  socket.emit("student:pick", { deskId });
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
    const assignedName = state.assigned[id]; // null = taken but name hidden
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
      // Only teacher receives multiple names for a desk
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

  // Teacher panel
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

  // Student panel
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
  socket.emit("role:set", { role: "teacher" });
  showView("teacher");
  render();
});

els.btnStudent.addEventListener("click", () => {
  role = "student";
  socket.emit("role:set", { role: "student" });
  showView("student");
  render();
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    role = null;
    me = null;
    showView("menu");
  });
});

els.formStart.addEventListener("submit", (e) => {
  e.preventDefault();
  const studentCount = Number(els.studentCount.value);
  socket.emit("teacher:start", { studentCount });
});

els.btnReset.addEventListener("click", () => {
  if (confirm("Reset the whole placement session?")) {
    socket.emit("teacher:reset");
  }
});

els.btnResolve.addEventListener("click", () => {
  socket.emit("teacher:resolve");
});

els.formJoin.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = els.studentName.value.trim();
  if (!name) return;
  socket.emit("student:join", { name });
});

socket.on("state", (next) => {
  state = next;
  render();
});

socket.on("joined", ({ studentId, name }) => {
  me = { studentId, name };
  toast(`Joined as ${name}`);
  render();
});

socket.on("error", ({ message }) => {
  toast(message);
});

buildDesks();
showView("menu");
