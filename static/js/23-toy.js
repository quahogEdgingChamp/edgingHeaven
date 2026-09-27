/* ==========================================================================
   Toy sync — Intiface Central over the Buttplug protocol (spec v3)

   Intiface Central is a free app that talks to the toys over Bluetooth and
   opens a websocket (ws://127.0.0.1:12345 by default) on the device it runs
   on. The page connects to it straight from the browser; nothing goes
   through the server. The running mode says how strong (0–1) at any
   moment: Escalation from its ramp, Session and Red light from their phase,
   Beat pulses on every beat. "Max intensity" scales all of it, and leaving
   a mode, hiding the tab or panicking stops everything.
   ========================================================================== */

const toy = {
  socket: null,
  status: "off",
  error: "",
  devices: new Map(),
  nextId: 1,
  level: 0,
  sent: -1,
  sendTimer: 0,
  pingTimer: 0,
  lastSend: 0,
};

function toyConnected() {
  return toy.status === "connected";
}

function toySend(message) {
  if (!toy.socket || toy.socket.readyState !== WebSocket.OPEN) return 0;
  const id = toy.nextId++;
  const [type] = Object.keys(message);
  message[type].Id = id;
  toy.socket.send(JSON.stringify([message]));
  return id;
}

function toyConnect() {
  toyDisconnect(true);
  const url = String(state.settings.toyUrl || "ws://127.0.0.1:12345").trim();
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    toy.status = "error";
    toy.error = "That address is not a websocket URL.";
    syncToyPanel();
    return;
  }
  toy.socket = socket;
  toy.status = "connecting";
  toy.error = "";
  syncToyPanel();
  socket.addEventListener("open", () => {
    toySend({ RequestServerInfo: { ClientName: "Edging Heaven", MessageVersion: 3 } });
  });
  socket.addEventListener("message", (event) => {
    let messages;
    try {
      messages = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    (Array.isArray(messages) ? messages : [messages]).forEach(handleToyMessage);
  });
  socket.addEventListener("error", () => {
    toy.error = `Could not reach Intiface at ${url}. Is Intiface Central running with its server started?`;
  });
  socket.addEventListener("close", () => {
    if (toy.socket !== socket) return;
    window.clearInterval(toy.pingTimer);
    toy.socket = null;
    toy.devices.clear();
    toy.status = toy.error ? "error" : "off";
    syncToyPanel();
  });
}

function toyDisconnect(quiet = false) {
  window.clearInterval(toy.pingTimer);
  window.clearTimeout(toy.sendTimer);
  const socket = toy.socket;
  toy.socket = null;
  toy.devices.clear();
  toy.status = "off";
  toy.error = "";
  toy.sent = -1;
  if (socket) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify([{ StopAllDevices: { Id: toy.nextId++ } }]));
      socket.close();
    } catch (error) {
      /* already gone */
    }
  }
  if (!quiet) syncToyPanel();
}

function handleToyMessage(message) {
  const [type] = Object.keys(message || {});
  const body = message[type] || {};
  if (type === "ServerInfo") {
    toy.status = "connected";
    if (body.MaxPingTime > 0) {
      // The server stops every device if it stops hearing from us.
      toy.pingTimer = window.setInterval(() => toySend({ Ping: {} }), Math.max(200, body.MaxPingTime / 2));
    }
    toySend({ RequestDeviceList: {} });
    toySend({ StartScanning: {} });
  } else if (type === "DeviceList") {
    (body.Devices || []).forEach(addToyDevice);
  } else if (type === "DeviceAdded") {
    addToyDevice(body);
  } else if (type === "DeviceRemoved") {
    toy.devices.delete(body.DeviceIndex);
  } else if (type === "Error") {
    toy.error = body.ErrorMessage || "Intiface reported an error.";
  }
  syncToyPanel();
}

function addToyDevice(device) {
  // Only what can take a strength: vibrators, oscillators, constrictors…
  const scalars = (device.DeviceMessages?.ScalarCmd || []).map((feature, index) => ({ index, type: feature.ActuatorType }));
  if (!scalars.length) return;
  toy.devices.set(device.DeviceIndex, { name: device.DeviceName, scalars });
}

// Modes call this as often as they like; it goes out at most ten times a
// second, and only when the value moved.
function toySet(level) {
  toy.level = clampNumber(Number(level) || 0, 0, 1);
  if (!toyConnected() || toy.sendTimer) return;
  const wait = Math.max(0, 100 - (performance.now() - toy.lastSend));
  toy.sendTimer = window.setTimeout(flushToy, wait);
}

function flushToy() {
  toy.sendTimer = 0;
  if (!toyConnected()) return;
  const scaled = Math.round(toy.level * clampNumber(Number(state.settings.toyMax ?? 0.7), 0, 1) * 100) / 100;
  if (scaled === toy.sent) return;
  toy.sent = scaled;
  toy.lastSend = performance.now();
  toy.devices.forEach((device, index) => {
    toySend({ ScalarCmd: { DeviceIndex: index, Scalars: device.scalars.map((s) => ({ Index: s.index, Scalar: scaled, ActuatorType: s.type })) } });
  });
}

function toyStop() {
  toy.level = 0;
  window.clearTimeout(toy.sendTimer);
  toy.sendTimer = 0;
  if (toyConnected() && toy.sent !== 0) {
    toy.sent = 0;
    toySend({ StopAllDevices: {} });
  }
}

function toyTest() {
  if (!toyConnected() || !toy.devices.size) {
    toast("Connect to Intiface and pair a toy first.");
    return;
  }
  toySet(1);
  window.setTimeout(toyStop, 900);
}

function syncToyPanel() {
  const status = el("toyStatus");
  if (!status) return;
  const labels = {
    off: "Not connected.",
    connecting: "Connecting…",
    connected: toy.devices.size ? `Connected · ${[...toy.devices.values()].map((d) => d.name).join(", ")}` : "Connected · scanning for toys. Turn one on.",
    error: toy.error || "Could not connect.",
  };
  status.textContent = labels[toy.status] || "";
  status.classList.toggle("is-error", toy.status === "error");
  const connect = el("toyConnect");
  connect.textContent = toy.status === "off" || toy.status === "error" ? "Connect" : "Disconnect";
  el("toyTest").disabled = !toyConnected() || !toy.devices.size;
}

function bindToyPanel() {
  const url = el("toyUrl");
  url.value = state.settings.toyUrl || "ws://127.0.0.1:12345";
  url.addEventListener("change", () => {
    state.settings.toyUrl = url.value.trim() || "ws://127.0.0.1:12345";
    queueSettingsSave();
  });
  el("toyConnect").addEventListener("click", () => {
    if (toy.status === "off" || toy.status === "error") {
      state.settings.toyUrl = url.value.trim() || "ws://127.0.0.1:12345";
      queueSettingsSave();
      toyConnect();
    } else {
      toyDisconnect();
    }
  });
  el("toyTest").addEventListener("click", toyTest);
  syncToyPanel();
}
