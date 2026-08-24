const PROTOCOL_VERSION = "2026-01-26";
const INITIALIZE_ID = "initialize";

const elements = {
  form: document.querySelector("#fit-form"),
  height: document.querySelector("#height"),
  weight: document.querySelector("#weight"),
  age: document.querySelector("#age"),
  heightOutput: document.querySelector("#height-output"),
  weightOutput: document.querySelector("#weight-output"),
  ageOutput: document.querySelector("#age-output"),
  roomInputs: [...document.querySelectorAll('input[name="room"]')],
  triangle: document.querySelector("#mix-triangle"),
  target: document.querySelector("#mix-target"),
  strength: document.querySelector("#strength-value"),
  variety: document.querySelector("#variety-value"),
  convenience: document.querySelector("#convenience-value"),
  mixSummary: document.querySelector("#mix-summary"),
  sync: document.querySelector("#sync-state"),
  announcer: document.querySelector("#announcer"),
};

let state = null;
let requestNumber = 0;
let profileTimer = null;
let preferenceTimer = null;
let draftMix = null;
const edits = { profile: 0, preferences: 0 };
const dirty = { profile: false, preferences: false };
let writes = Promise.resolve();
const pending = new Map();

function send(message) {
  window.parent.postMessage(message, "*");
}

function callTool(name, args) {
  const id = `sidecar-${++requestNumber}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The page did not answer the controls."));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  });
}

function setSync(label, mode) {
  elements.sync.textContent = label;
  elements.sync.dataset.state = mode;
}

function mixToPoint(mix) {
  const y = (mix.strength + mix.convenience) / 100;
  return { x: mix.variety / 200 + mix.convenience / 100, y };
}

function pointToMix(rawX, rawY) {
  const y = Math.max(0.02, Math.min(0.98, rawY));
  const left = (1 - y) / 2;
  const right = 1 - left;
  const x = Math.max(left, Math.min(right, rawX));
  const variety = Math.round((1 - y) * 100);
  const remaining = 100 - variety;
  const convenience = Math.round(remaining * ((x - left) / (right - left)));
  return { strength: remaining - convenience, variety, convenience };
}

function leadingSummary(mix) {
  const ordered = Object.entries(mix).sort((a, b) => b[1] - a[1]);
  const labels = { strength: "Strength", variety: "Variety", convenience: "Convenience" };
  if (ordered[0][1] - ordered[2][1] < 12) return "A nearly even training mix.";
  if (ordered[0][1] - ordered[1][1] < 10)
    return `${labels[ordered[0][0]]} and ${ordered[1][0]} share the lead.`;
  return `${labels[ordered[0][0]]} leads the training mix.`;
}

function updateProfileOutputs() {
  elements.heightOutput.value = `${elements.height.value} cm`;
  elements.weightOutput.value = `${elements.weight.value} kg`;
  elements.ageOutput.value = elements.age.value;
}

function renderMix(mix) {
  const point = mixToPoint(mix);
  elements.target.style.left = `${point.x * 100}%`;
  elements.target.style.top = `${point.y * 100}%`;
  elements.strength.textContent = String(mix.strength);
  elements.variety.textContent = String(mix.variety);
  elements.convenience.textContent = String(mix.convenience);
  elements.mixSummary.textContent = leadingSummary(mix);
  elements.triangle.setAttribute(
    "aria-valuetext",
    `Strength ${mix.strength}, variety ${mix.variety}, convenience ${mix.convenience}`,
  );
}

function render(nextState, announce = false) {
  if (!nextState?.profile || !nextState?.preferences?.mix) return;
  if (!state || nextState.revision >= state.revision) state = nextState;
  if (!dirty.profile) {
    elements.height.value = String(state.profile.height);
    elements.weight.value = String(state.profile.weight);
    elements.age.value = String(state.profile.age);
    updateProfileOutputs();
  }
  if (!dirty.preferences) {
    for (const input of elements.roomInputs) input.checked = input.value === state.preferences.room;
    draftMix = { ...state.preferences.mix };
    renderMix(draftMix);
  }
  setSync(state.engaged ? `Applied · r${state.revision}` : "Ready", "ready");
  if (dirty.profile || dirty.preferences) setSync("Applying", "pending");
  if (announce)
    elements.announcer.textContent = "Controls applied. The result updated on the website.";
}

function profilePayload() {
  return {
    height: Number(elements.height.value),
    weight: Number(elements.weight.value),
    age: Number(elements.age.value),
  };
}

function preferencePayload(
  mix = state?.preferences?.mix ?? { strength: 45, variety: 35, convenience: 20 },
) {
  const room = elements.roomInputs.find((input) => input.checked)?.value ?? "standard";
  return { room, ...mix };
}

function enqueueUpdate(group, version, name, args) {
  // Serialize mutations so older requests cannot commit after newer ones.
  writes = writes.then(async () => {
    if (version !== edits[group]) return;
    try {
      const result = await callTool(name, args);
      if (version === edits[group]) dirty[group] = false;
      render(result, true);
    } catch (error) {
      // Keep the draft visible. A subsequent edit can submit it again explicitly.
      setSync("Update failed", "error");
      elements.announcer.textContent = error.message;
    }
  });
}

function scheduleProfileUpdate() {
  if (!state) return;
  updateProfileOutputs();
  const args = profilePayload();
  const version = ++edits.profile;
  dirty.profile = true;
  clearTimeout(profileTimer);
  setSync("Applying", "pending");
  profileTimer = setTimeout(
    () => enqueueUpdate("profile", version, "gym_update_profile", args),
    140,
  );
}

function schedulePreferenceUpdate(mix) {
  if (!state) return;
  draftMix = { ...mix };
  const args = preferencePayload(draftMix);
  const version = ++edits.preferences;
  dirty.preferences = true;
  renderMix(draftMix);
  clearTimeout(preferenceTimer);
  setSync("Applying", "pending");
  preferenceTimer = setTimeout(
    () => enqueueUpdate("preferences", version, "gym_set_preferences", args),
    100,
  );
}

for (const input of [elements.height, elements.weight, elements.age])
  input.addEventListener("input", scheduleProfileUpdate);
elements.form.addEventListener("submit", (event) => event.preventDefault());
for (const input of elements.roomInputs)
  input.addEventListener("change", () => schedulePreferenceUpdate(draftMix));

elements.triangle.addEventListener("pointerdown", (event) => {
  if (!state) return;
  const box = elements.triangle.getBoundingClientRect();
  schedulePreferenceUpdate(
    pointToMix((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height),
  );
});

elements.triangle.addEventListener("keydown", (event) => {
  if (!state || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const point = mixToPoint(draftMix);
  const delta = event.shiftKey ? 0.1 : 0.035;
  const x = point.x + (event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0);
  const y = point.y + (event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0);
  schedulePreferenceUpdate(pointToMix(x, y));
});

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
  const data = event.data;
  if (data.id === INITIALIZE_ID) {
    if (data.error || data.result?.protocolVersion !== PROTOCOL_VERSION) {
      setSync("Connection failed", "error");
      return;
    }
    // The host answered ui/initialize, so the handshake is complete.
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  } else if (data.method === "ui/notifications/tool-result") {
    render(data.params?.structuredContent, false);
  } else if (data.method === "ui/notifications/tool-input") {
    // gym_open_fit_sidecar takes no arguments, so there is nothing to apply.
  } else if (data.id && pending.has(data.id)) {
    const request = pending.get(data.id);
    clearTimeout(request.timer);
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error.message ?? "Tool call failed"));
    else request.resolve(data.result);
  }
});

// The app opens the handshake. The host replies with McpUiInitializeResult.
send({
  jsonrpc: "2.0",
  id: INITIALIZE_ID,
  method: "ui/initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    appCapabilities: { tools: {} },
    appInfo: { name: "Equipment fit sidecar", version: "1.0.0" },
  },
});
