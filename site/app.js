// The whole point of this file: `gym_open_fit_sidecar` is a WebMCP tool whose
// result carries an MCP Apps View. WebMCP tools have no `_meta` and WebMCP has
// no resources, so two MCP Apps pieces move into the result: the tool's
// `_meta.ui.resourceUri` link, and the `resources/read` contents as an embedded
// resource. Rendering it is a private convention between this page and the
// extension - not MCP Apps interoperability.

const BRIDGE_CHANNEL = "form-factor-webmcp";
const SIDECAR_URI = "ui://form-factor/equipment-fit";
const APP_MIME_TYPE = "text/html;profile=mcp-app";
// Fields MCP Apps doesn't define live under their own key, never under `_meta.ui`.
const EXTENSION_META_KEY = "webmcp-apps";

const equipment = Object.freeze([
  {
    id: "adjustable-dumbbells",
    name: "Adjustable dumbbells",
    code: "AD-32",
    image: "/assets/equipment/adjustable-dumbbells.jpg",
    room: "compact",
    mix: { strength: 30, variety: 30, convenience: 40 },
    footprint: "0.3 m²",
    capacity: 64,
  },
  {
    id: "folding-rack",
    name: "Folding wall rack",
    code: "FR-21",
    image: "/assets/equipment/folding-rack.jpg",
    room: "standard",
    mix: { strength: 55, variety: 15, convenience: 30 },
    footprint: "1.2 m²",
    capacity: 250,
  },
  {
    id: "power-rack",
    name: "Four-post power rack",
    code: "PR-48",
    image: "/assets/equipment/power-rack.jpg",
    room: "dedicated",
    mix: { strength: 70, variety: 20, convenience: 10 },
    footprint: "2.4 m²",
    capacity: 450,
  },
  {
    id: "functional-trainer",
    name: "Compact functional trainer",
    code: "FT-76",
    image: "/assets/equipment/functional-trainer.jpg",
    room: "standard",
    mix: { strength: 25, variety: 60, convenience: 15 },
    footprint: "1.8 m²",
    capacity: 180,
  },
]);

const roomRank = Object.freeze({ compact: 0, standard: 1, dedicated: 2 });
const roomLabel = Object.freeze({
  compact: "Compact",
  standard: "Standard",
  dedicated: "Dedicated",
});

const state = {
  profile: { height: 178, weight: 78, age: 34 },
  preferences: { room: "standard", mix: { strength: 45, variety: 35, convenience: 20 } },
  revision: 1,
  engaged: false,
};

const elements = {
  name: document.querySelector("#recommendation-name"),
  code: document.querySelector("#recommendation-code"),
  reason: document.querySelector("#recommendation-reason"),
  revision: document.querySelector("#result-revision"),
  room: document.querySelector("#room-summary"),
  mix: document.querySelector("#mix-summary"),
  profile: document.querySelector("#profile-summary"),
  load: document.querySelector("#load-summary"),
  footprint: document.querySelector("#visual-footprint"),
  image: document.querySelector("#stage-photo"),
};

function requiredCapacity() {
  const ageFactor = state.profile.age >= 55 ? 1.05 : state.profile.age >= 40 ? 1.18 : 1.3;
  return Math.round(state.profile.weight * ageFactor);
}

function score(item) {
  const desired = state.preferences.mix;
  const mixDistance = Math.hypot(
    item.mix.strength - desired.strength,
    item.mix.variety - desired.variety,
    item.mix.convenience - desired.convenience,
  );
  const roomDifference = roomRank[item.room] - roomRank[state.preferences.room];
  const roomPenalty = roomDifference > 0 ? roomDifference * 48 : Math.abs(roomDifference) * 4;
  const loadShortfall = Math.max(0, requiredCapacity() - item.capacity);
  return mixDistance + roomPenalty + loadShortfall * (desired.strength / 100) * 0.2;
}

function recommendation() {
  const candidates = equipment.filter(
    (item) => roomRank[item.room] <= roomRank[state.preferences.room],
  );
  return candidates.reduce((best, item) => (score(item) < score(best) ? item : best));
}

function reasonFor(item) {
  const priority = Object.entries(state.preferences.mix).sort((a, b) => b[1] - a[1])[0][0];
  const fit =
    item.room === state.preferences.room
      ? `fits a ${roomLabel[item.room].toLowerCase()} room`
      : `uses less than the available ${roomLabel[state.preferences.room].toLowerCase()} footprint`;
  return `${item.name} ${fit} and is closest to your ${priority}-led training mix. Its ${item.capacity} kg rated load is compared with a ${requiredCapacity()} kg planning load.`;
}

function snapshot() {
  const selected = recommendation();
  return {
    profile: { ...state.profile },
    preferences: { room: state.preferences.room, mix: { ...state.preferences.mix } },
    recommendation: {
      id: selected.id,
      name: selected.name,
      code: selected.code,
      reason: reasonFor(selected),
      requiredCapacity: requiredCapacity(),
    },
    revision: state.revision,
    engaged: state.engaged,
  };
}

function render() {
  const selected = recommendation();
  const mix = state.preferences.mix;
  elements.name.textContent = selected.name;
  elements.code.textContent = selected.code;
  elements.reason.textContent = reasonFor(selected);
  elements.revision.textContent = state.engaged ? `Updated · r${state.revision}` : "Starting point";
  elements.room.textContent = roomLabel[state.preferences.room];
  elements.mix.textContent = `Strength ${mix.strength} · Variety ${mix.variety} · Convenience ${mix.convenience}`;
  elements.profile.textContent = `${state.profile.height} cm · ${state.profile.weight} kg · age ${state.profile.age}`;
  elements.load.textContent = `${requiredCapacity()} kg`;
  elements.footprint.textContent = `${selected.footprint} floor`;
  if (elements.image.getAttribute("src") !== selected.image) elements.image.src = selected.image;
  elements.image.alt = `${selected.name} product photograph`;
}

function broadcast() {
  window.postMessage(
    {
      channel: BRIDGE_CHANNEL,
      direction: "page-event",
      type: "CONTEXT_CHANGED",
      state: snapshot(),
    },
    location.origin,
  );
}

function validateNumber(value, min, max, label, round = true) {
  const number = value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return round ? Math.round(number) : number;
}

function normalizeMix(input) {
  const raw = {
    strength: validateNumber(input.strength, 0, 100, "Strength", false),
    variety: validateNumber(input.variety, 0, 100, "Variety", false),
    convenience: validateNumber(input.convenience, 0, 100, "Convenience", false),
  };
  const total = raw.strength + raw.variety + raw.convenience;
  if (!total) throw new Error("Training mix must contain at least one point.");
  const shares = Object.entries(raw).map(([name, value]) => ({
    name,
    value: (value / total) * 100,
  }));
  const mix = Object.fromEntries(shares.map(({ name, value }) => [name, Math.floor(value)]));
  const remaining = 100 - Object.values(mix).reduce((sum, value) => sum + value, 0);
  shares.sort((a, b) => (b.value % 1) - (a.value % 1));
  for (let i = 0; i < remaining; i++) mix[shares[i].name]++;
  return mix;
}

// Page tools return an MCP CallToolResult: text for the model, state for Views.
function commit(summary) {
  state.engaged = true;
  state.revision += 1;
  render();
  broadcast();
  const current = snapshot();
  return {
    content: [{ type: "text", text: `${summary} Recommendation: ${current.recommendation.name}.` }],
    structuredContent: current,
  };
}

const tools = [
  {
    name: "gym_open_fit_sidecar",
    title: "Open equipment fit sidecar",
    description:
      "Open interactive equipment-fit controls for the user. Returns an MCP Apps UI resource.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      // Single-file View HTML, inlined by server.mjs into /fit-sidecar.resource.js.
      const html = globalThis.FIT_SIDECAR_HTML;
      if (typeof html !== "string" || !html)
        throw new Error("Equipment fit controls are unavailable.");
      return {
        content: [
          { type: "text", text: "Interactive equipment fit controls opened for the user." },
          // Stands in for `resources/read`: the same TextResourceContents, as a
          // standard MCP embedded resource. Agents that can't render it can
          // ignore it and use the text block above.
          { type: "resource", resource: { uri: SIDECAR_URI, mimeType: APP_MIME_TYPE, text: html } },
        ],
        structuredContent: snapshot(),
        _meta: {
          // MCP Apps puts this on the tool definition; WebMCP's registerTool()
          // has no `_meta`, so the result carries it.
          ui: { resourceUri: SIDECAR_URI },
          // Not standard: WebMCP cannot mark tools with MCP Apps' visibility:
          // ["app"], so the page names the tools its View may call.
          [EXTENSION_META_KEY]: {
            allowedPageTools: ["gym_update_profile", "gym_set_preferences"],
          },
        },
      };
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "gym_update_profile",
    title: "Update body profile",
    description: "Update height, weight, and age used by the equipment-fit model.",
    inputSchema: {
      type: "object",
      properties: {
        height: {
          type: "number",
          minimum: 145,
          maximum: 210,
          description: "Standing height in centimetres.",
        },
        weight: {
          type: "number",
          minimum: 45,
          maximum: 160,
          description: "Body weight in kilograms. Drives the planning load shown on the page.",
        },
        age: { type: "number", minimum: 18, maximum: 80, description: "Age in years." },
      },
      required: ["height", "weight", "age"],
    },
    async execute(input) {
      state.profile = {
        height: validateNumber(input.height, 145, 210, "Height"),
        weight: validateNumber(input.weight, 45, 160, "Weight"),
        age: validateNumber(input.age, 18, 80, "Age"),
      };
      return commit("Profile updated.");
    },
  },
  {
    name: "gym_set_preferences",
    title: "Set room and training mix",
    description:
      "Set the available room and how much the training should favour strength, variety, and convenience. Pass each priority between 0 and 100, including fractions, with a positive total; they are rescaled to 100 integer points.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          enum: ["compact", "standard", "dedicated"],
          description:
            "Floor space available: compact up to 0.6 m², standard up to 1.8 m², dedicated 2.4 m² or more.",
        },
        strength: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Relative weight on heavy barbell and rack work.",
        },
        variety: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Relative weight on movement range and exercise choice.",
        },
        convenience: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "Relative weight on fast setup and small footprint.",
        },
      },
      required: ["room", "strength", "variety", "convenience"],
    },
    async execute(input) {
      if (typeof input.room !== "string" || !Object.hasOwn(roomRank, input.room))
        throw new Error("Room must be compact, standard, or dedicated.");
      state.preferences = { room: input.room, mix: normalizeMix(input) };
      return commit("Room and training mix updated.");
    },
  },
];

// Registrations belong to the document and disappear when the page navigates.
async function registerWebMcpTools() {
  if (!document.modelContext?.registerTool) return;
  for (const tool of tools) await document.modelContext.registerTool(tool);
}

render();
registerWebMcpTools().catch((error) => console.error("WebMCP registration failed", error));
