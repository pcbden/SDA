'use strict';

// ── Capabilities ──────────────────────────────────────
// Without Web Serial (iOS, Firefox, …) the page still works in MQTT mode.
const SERIAL_OK  = SerialManager.isSupported();
const IS_ANDROID = /Android/i.test(navigator.userAgent);

// ── State ─────────────────────────────────────────────
const serial      = new SerialManager();
const graphCh     = new BroadcastChannel('sda_graph');
let graphWin      = null;
let rxCount       = 0;
let txCount       = 0;
let paused        = false;
let breakTimer    = null;
let commands      = [];
let pendingModbus = null; // { buf[], resultEl, mbType, mbSize, mbOrder, isAscii, timer }
let slaveMode     = false;
let slaveBuf      = [];
let slaveTimer    = null;
const mqttMgr   = new MqttManager();
let mqttMode    = false;
let pollActive   = false;
let pollTimerId  = null;
let pollIndex    = 0;
let cmdResultEls = []; // populated by buildCmdRow; gives poller access to each row's result input
const expandedCmds = new WeakSet(); // commands whose config is open (mobile layout)

// Serial line errors (wrong baud/parity etc.)
let lineErrCount  = 0;
let lineErrNoteAt = 0;
let reconfPending = 0;

// Log state
let logFileHandle = null;
let logWritable   = null;
let logEnabled    = false;

// ── DOM ───────────────────────────────────────────────
const $ = id => document.getElementById(id);

const elPortName   = $('portName');
const elBaud       = $('baud');
const elDataBits   = $('dataBits');
const elParity     = $('parity');
const elStopBits   = $('stopBits');
const elBtnOpen    = $('btnOpen');
const elRxArea     = $('rxArea');
const elRxHex      = $('rxHex');
const elAutoBreak  = $('autoBreak');
const elBreakMs    = $('breakMs');
const elBtnPause   = $('btnPause');
const elBtnClearRx = $('btnClearRx');
const elTxInput    = $('txInput');
const elTxHex      = $('txHex');
const elAppendNL   = $('appendNL');
const elBtnSend    = $('btnSend');
const elCmdList    = $('cmdList');
const elConnDot    = $('connDot');
const elConnStatus = $('connStatus');
const elRxStat     = $('rxStat');
const elTxStat     = $('txStat');
const elPortInfo   = $('portInfo');
const elBtnLog       = $('btnLog');
const elChkLogAppend = $('chkLogAppend');
const elLogFileName  = $('logFileName');
const elParamSummary = $('paramSummary');
const elLineErr      = $('lineErr');
let   portLabel      = '';

// ── Graph helpers ─────────────────────────────────────
function randomGraphColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue},70%,60%)`;
}

function ensureGraphOpen() {
  if (!graphWin || graphWin.closed) {
    graphWin = window.open('graph.html', 'sda_graph');
  } else {
    graphWin.focus();
  }
}

function broadcastGraphPoint(name, color, value) {
  const v = typeof value === 'bigint' ? Number(value) : Number(value);
  if (isNaN(v)) return;
  graphCh.postMessage({ type: 'data', name, color, t: Date.now(), v });
}

graphCh.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'graph_closed') {
    graphWin = null;
    commands.forEach(cmd => { cmd.graph = false; });
    Storage.saveCommands(commands);
    renderCommands();
  } else if (m.type === 'delete_series') {
    commands.forEach(cmd => { if (cmd.name === m.name) cmd.graph = false; });
    Storage.saveCommands(commands);
    renderCommands();
  } else if (m.type === 'graph_ready') {
    // Graph tab just loaded — send current result values for all graph-enabled commands
    sendCurrentGraphValues();
  }
});

function sendCurrentGraphValues() {
  commands.forEach((c, i) => {
    if (!c.graph || !c.graphColor) return;
    const el = cmdResultEls[i];
    if (!el || el.dataset.state !== 'ok') return;
    const v = parseFloat(el.value);
    if (!isNaN(v)) broadcastGraphPoint(c.name || `CMD${i+1}`, c.graphColor, v);
  });
}

// ── Connection ────────────────────────────────────────
function uartOptions() {
  return {
    baudRate: parseInt(elBaud.value, 10),
    dataBits: parseInt(elDataBits.value, 10),
    parity:   elParity.value,
    stopBits: parseInt(elStopBits.value, 10),
  };
}

function uartSummary(o) {
  return `${o.baudRate} ${o.dataBits}${o.parity[0].toUpperCase()}${o.stopBits}`;
}

function setUartSelects(o) {
  elBaud.value     = String(o.baudRate);
  elDataBits.value = String(o.dataBits);
  elParity.value   = o.parity;
  elStopBits.value = String(o.stopBits);
}

function updateParamSummary() {
  const sum = uartSummary(uartOptions());
  elParamSummary.textContent = sum;
  if (serial.connected && !mqttMode) elPortInfo.textContent = `${portLabel} · ${uartSummary(serial.options)}`;
}

elBtnOpen.addEventListener('click', async () => {
  if (mqttMode) { alert('MQTT is active. Disconnect MQTT first.'); return; }
  if (!SERIAL_OK) {
    alert('Web Serial is not available in this browser.\n\n'
        + 'Use Chrome or Edge on a computer, or Chrome on Android (Bluetooth serial). '
        + 'The page must be served from https:// or localhost.\n\n'
        + 'MQTT mode works in any browser.');
    return;
  }
  if (serial.connected) {
    await serial.disconnect();
    if (pendingModbus) { clearTimeout(pendingModbus.timer); clearTimeout(pendingModbus.hardTimeout); }
    pendingModbus = null;
    stopPoll();
    setConnected(false, '');
    return;
  }

  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (err) {
    if (err.name !== 'NotFoundError') alert('Failed to select port:\n' + err.message);
    return;
  }

  // Desktop pickers also list built-in ttyS*/COM ports that are almost never
  // what you want. Android only lists real devices, so skip the check there.
  const info = port.getInfo();
  if (!IS_ANDROID && info.usbVendorId === undefined && info.bluetoothServiceClassId === undefined) {
    alert('The selected port is not a USB or Bluetooth device.\nPlease select your connected device (e.g. ttyUSB0, ttyACM0, COMx).');
    return;
  }

  try {
    const label = await serial.connect(uartOptions(), port);
    resetLineErrors();
    setConnected(true, label);
  } catch (err) {
    alert('Failed to open port:\n' + err.message);
  }
});

// ── Live UART reconfiguration ─────────────────────────
// Changing Baud/Data/Parity/Stop while the port is open closes and reopens
// the same port with the new settings — no need to pick it again.
async function applyUartChange() {
  updateParamSummary();
  if (mqttMode || !serial.connected) return;

  const opts = uartOptions();
  reconfPending++;
  elConnStatus.textContent = 'Reconfiguring…';
  try {
    await serial.reconfigure(opts);
    resetLineErrors();
    appendNote(`Port settings → ${uartSummary(opts)}`);
  } catch (err) {
    // Show what the port is really using now
    if (serial.connected && serial.options) {
      setUartSelects(serial.options);
      saveSettings();
    }
    alert('Could not apply serial settings:\n' + err.message);
  } finally {
    reconfPending--;
    if (reconfPending === 0 && serial.connected) elConnStatus.textContent = 'Connected';
    updateParamSummary();
  }
}

[elBaud, elDataBits, elParity, elStopBits].forEach(el => el.addEventListener('change', applyUartChange));

// ── Line errors ───────────────────────────────────────
// Framing/break/parity errors no longer close the port; they are counted here.
serial.onLineError = (err) => {
  lineErrCount++;
  elLineErr.style.display = '';
  elLineErr.textContent = `⚠ ${lineErrCount} line error${lineErrCount === 1 ? '' : 's'}`;
  elLineErr.title = `Last: ${err.name}. This usually means Baud / Data / Parity / Stop `
                  + `don't match the device. You can change them while the port is open. Click to reset.`;
  const now = Date.now();
  if (now - lineErrNoteAt > 3000) {
    lineErrNoteAt = now;
    appendNote(`⚠ ${err.name} at ${uartSummary(serial.options || uartOptions())} — check baud rate / parity`, true);
  }
};

function resetLineErrors() {
  lineErrCount  = 0;
  lineErrNoteAt = 0;
  elLineErr.style.display = 'none';
}

elLineErr.addEventListener('click', resetLineErrors);

function handleIncomingData(data) {
  rxCount += data.length;
  updateStats();

  if (pendingModbus) {
    for (const b of data) pendingModbus.buf.push(b);
    // Reset only the silence timer, not the hard timeout
    clearTimeout(pendingModbus.timer);
    pendingModbus.timer = setTimeout(processModbusResponse, 200);
  }

  if (slaveMode && commands.length > 0) {
    for (const b of data) slaveBuf.push(b);
    clearTimeout(slaveTimer);
    slaveTimer = setTimeout(processSlaveRequest, 50);
  }

  if (paused) return;

  if (elAutoBreak.checked) {
    clearTimeout(breakTimer);
    breakTimer = setTimeout(appendBreak, parseInt(elBreakMs.value, 10) || 500);
  }

  const text = elRxHex.checked
    ? Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') + ' '
    : new TextDecoder('utf-8', { fatal: false }).decode(data);

  appendRx(text);
}

serial.onData = handleIncomingData;

// For MQTT: Modbus processing uses parsed binary bytes; terminal gets the raw ASCII hex string
mqttMgr.onData = (bytes) => {
  rxCount += bytes.length;
  updateStats();
  if (pendingModbus) {
    for (const b of bytes) pendingModbus.buf.push(b);
    clearTimeout(pendingModbus.timer);
    pendingModbus.timer = setTimeout(processModbusResponse, 200);
  }
  if (slaveMode && commands.length > 0) {
    for (const b of bytes) slaveBuf.push(b);
    clearTimeout(slaveTimer);
    slaveTimer = setTimeout(processSlaveRequest, 50);
  }
};

mqttMgr.onDisplay = (text, topic) => {
  if (paused) return;
  if (elAutoBreak.checked) {
    clearTimeout(breakTimer);
    breakTimer = setTimeout(appendBreak, parseInt(elBreakMs.value, 10) || 500);
  }
  appendRx(`[${topic}] ${text}\n`);
};

serial.onDisconnect = (err) => {
  if (pendingModbus) { clearTimeout(pendingModbus.timer); clearTimeout(pendingModbus.hardTimeout); }
  pendingModbus = null;
  stopPoll();
  setConnected(false, '');
  appendNote(`Port closed: ${err?.message || 'device disconnected'}. Click Open to reconnect.`, true);
  if (err) console.warn('Serial port disconnected:', err);
};

mqttMgr.onDisconnect = (err) => {
  mqttMode = false;
  if (pendingModbus) { clearTimeout(pendingModbus.timer); clearTimeout(pendingModbus.hardTimeout); }
  pendingModbus = null;
  stopPoll();
  setConnected(false, '');
  setMqttDevStatus(null);
  const btn = $('btnMqttConnect');
  if (btn) { btn.textContent = 'Connect'; btn.classList.remove('is-open'); }
  if (err) console.warn('MQTT disconnected:', err.message);
};

mqttMgr.onStatus = (raw) => { setMqttDevStatus(raw); };

function setMqttDevStatus(raw) {
  const sep  = $('mqttStatusSep');
  const dot  = $('mqttDevDot');
  const info = $('mqttDevInfo');
  if (!sep || !dot || !info) return;

  if (raw === null) {
    [sep, dot, info].forEach(el => { el.style.display = 'none'; });
    dot.className = 'conn-dot';
    return;
  }
  [sep, dot, info].forEach(el => { el.style.display = ''; });

  if (raw === 'waiting') {
    dot.className = 'conn-dot';
    info.textContent = 'No status';
    info.style.color = '#888';
  } else {
    dot.className = 'conn-dot connected';
    info.textContent = raw;
    info.style.color = '#444';
  }
}

function setConnected(connected, label) {
  portLabel = connected ? label : '';
  elBtnOpen.textContent = connected ? 'Close' : 'Open';
  elBtnOpen.classList.toggle('is-open', connected);
  elConnDot.classList.toggle('connected', connected);
  elConnStatus.textContent = connected ? 'Connected' : 'Disconnected';
  elPortName.textContent   = connected ? label : (SERIAL_OK ? '—' : 'Serial n/a — MQTT only');
  elPortName.classList.toggle('is-empty', !connected && SERIAL_OK);
  elPortInfo.textContent   = connected ? label : 'No Port';
  if (!connected) resetLineErrors();
  // UART settings stay editable: changes are applied live (see applyUartChange)
  updateParamSummary();
}

// ── Receive display ───────────────────────────────────
function appendRx(text) {
  const atBottom = isAtBottom(elRxArea);
  if ($('showTs').checked) {
    const ts = document.createElement('span');
    ts.className = 'rx-ts';
    ts.textContent = `[${getTimestamp()}] `;
    elRxArea.appendChild(ts);
  }
  elRxArea.appendChild(document.createTextNode(text));
  trimRx();
  if (atBottom) elRxArea.scrollTop = elRxArea.scrollHeight;
  if (logEnabled) writeLog(`[${getTimestamp()}] ${text}`);
}

function appendTxEcho(bytes, prefix = '→') {
  if (!$('showTx').checked || paused) return;
  const atBottom = isAtBottom(elRxArea);
  if ($('showTs').checked) {
    const ts = document.createElement('span');
    ts.className = 'rx-ts';
    ts.textContent = `[${getTimestamp()}] `;
    elRxArea.appendChild(ts);
  }
  const text = elRxHex.checked
    ? Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    : new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/[\r\n]+$/, '');
  const span = document.createElement('span');
  span.className = 'tx-echo';
  span.textContent = `${prefix} ${text}\n`;
  elRxArea.appendChild(span);
  trimRx();
  if (atBottom) elRxArea.scrollTop = elRxArea.scrollHeight;
  if (logEnabled) writeLog(`[${getTimestamp()}] ${span.textContent}`);
}

// Informational line in the receive area (not device data)
function appendNote(text, warn = false) {
  if (paused) return;
  const atBottom = isAtBottom(elRxArea);
  const el = document.createElement('div');
  el.className   = warn ? 'rx-note warn' : 'rx-note';
  el.textContent = `[${getTimestamp()}] ${text}`;
  elRxArea.appendChild(el);
  trimRx();
  if (atBottom) elRxArea.scrollTop = elRxArea.scrollHeight;
  if (logEnabled) writeLog(`[${getTimestamp()}] ${text}\n`);
}

// Frame break: after a silence, start the next frame on a new line.
// Adds nothing if the output already ends with a newline (no blank lines).
// Timestamps come from the Time option, not from here.
function appendBreak() {
  const last = elRxArea.lastChild;
  if (!last || last.nodeName === 'DIV' || last.textContent.endsWith('\n')) return;
  const atBottom = isAtBottom(elRxArea);
  elRxArea.appendChild(document.createTextNode('\n'));
  trimRx();
  if (atBottom) elRxArea.scrollTop = elRxArea.scrollHeight;
  if (logEnabled) writeLog('\n');
}

function trimRx() {
  while (elRxArea.childNodes.length > 1000) {
    elRxArea.removeChild(elRxArea.firstChild);
  }
}

function isAtBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
}

elBtnPause.addEventListener('click', () => {
  paused = !paused;
  elBtnPause.textContent = paused ? 'Resume' : 'Pause';
  elBtnPause.classList.toggle('active', paused);
});

elBtnClearRx.addEventListener('click', () => {
  elRxArea.textContent = '';
  rxCount = 0;
  updateStats();
});

// ── CRC-16 (Modbus RTU) ───────────────────────────────
function calcModbusCRC16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
  }
  return crc;
}

// ── LRC (Modbus ASCII) ────────────────────────────────
function calcModbusLRC(data) {
  let sum = 0;
  for (const b of data) sum += b;
  return ((~sum) + 1) & 0xFF;
}

// ── Modbus response parsing ───────────────────────────

// Reorders raw bytes into big-endian layout for DataView consumption.
// All four orderings ultimately produce [MSB ... LSB] so DataView can
// use littleEndian=false uniformly.
function reorderBytes(raw, order, count) {
  const out = new Uint8Array(count);
  if (count === 1) {
    out[0] = raw[0];
  } else if (count === 2) {
    // ABCD/CDAB → big-endian word; DCBA/BADC → little-endian word
    if (order === 'DCBA' || order === 'BADC') {
      out[0] = raw[1]; out[1] = raw[0];
    } else {
      out[0] = raw[0]; out[1] = raw[1];
    }
  } else if (count === 4) {
    switch (order) {
      case 'ABCD': out.set(raw.slice(0, 4)); break;
      case 'DCBA': out[0]=raw[3]; out[1]=raw[2]; out[2]=raw[1]; out[3]=raw[0]; break;
      case 'CDAB': out[0]=raw[2]; out[1]=raw[3]; out[2]=raw[0]; out[3]=raw[1]; break;
      case 'BADC': out[0]=raw[1]; out[1]=raw[0]; out[2]=raw[3]; out[3]=raw[2]; break;
    }
  } else if (count === 8) {
    switch (order) {
      case 'ABCD': out.set(raw.slice(0, 8)); break;
      case 'DCBA': for (let k = 0; k < 8; k++) out[k] = raw[7 - k]; break;
      case 'CDAB':
        out[0]=raw[2]; out[1]=raw[3]; out[2]=raw[0]; out[3]=raw[1];
        out[4]=raw[6]; out[5]=raw[7]; out[6]=raw[4]; out[7]=raw[5]; break;
      case 'BADC':
        out[0]=raw[1]; out[1]=raw[0]; out[2]=raw[3]; out[3]=raw[2];
        out[4]=raw[5]; out[5]=raw[4]; out[6]=raw[7]; out[7]=raw[6]; break;
    }
  }
  return out;
}

function parseDataBytes(bytes, type, size, order) {
  const byteCount = size / 8;
  if (bytes.length < byteCount) return { error: `Need ${byteCount}B got ${bytes.length}` };
  const ordered = reorderBytes(bytes.slice(0, byteCount), order, byteCount);
  const view = new DataView(ordered.buffer);
  try {
    if (type === 'float') {
      if (size === 32) return { value: String(parseFloat(view.getFloat32(0, false).toPrecision(7))) };
      return { error: 'Float: 32 bit only' };
    }
    if (type === 'double') {
      if (size === 64) return { value: String(view.getFloat64(0, false)) };
      return { error: 'Double: 64 bit only' };
    }
    if (type === 'signed') {
      if (size === 8)  return { value: view.getInt8(0) };
      if (size === 16) return { value: view.getInt16(0, false) };
      if (size === 32) return { value: view.getInt32(0, false) };
      if (size === 64) return { value: String(view.getBigInt64(0, false)) };
    }
    // unsigned
    if (size === 8)  return { value: view.getUint8(0) };
    if (size === 16) return { value: view.getUint16(0, false) };
    if (size === 32) return { value: view.getUint32(0, false) };
    if (size === 64) return { value: String(view.getBigUint64(0, false)) };
  } catch { return { error: 'Parse err' }; }
  return { error: 'Unknown size' };
}

function showMbResult(el, text, state) {
  if (!el) return;
  el.value = text;
  el.dataset.state = state;
}

function processModbusResponse() {
  if (!pendingModbus) return;
  if (pendingModbus.buf.length === 0) return; // no data yet — wait for hard timeout
  clearTimeout(pendingModbus.hardTimeout);
  const { buf, resultEl, mbType, mbSize, mbOrder, isAscii, onResult } = pendingModbus;
  pendingModbus = null;

  if (isAscii) {
    // ── Modbus ASCII response: :HHHHH...LRC\r\n ──────────
    const str = new TextDecoder().decode(new Uint8Array(buf)).trim();
    if (!str.startsWith(':')) { showMbResult(resultEl, 'No start ":"', 'error'); return; }

    const content = str.slice(1).replace(/[\r\n]+$/, '');
    if (content.length < 6 || content.length % 2 !== 0) {
      showMbResult(resultEl, 'Bad frame', 'error'); return;
    }

    const allBytes = [];
    for (let i = 0; i < content.length; i += 2) {
      const b = parseInt(content.slice(i, i + 2), 16);
      if (isNaN(b)) { showMbResult(resultEl, 'Bad hex', 'error'); return; }
      allBytes.push(b);
    }

    // LRC verify: sum of all bytes (including LRC byte) must be 0x00 mod 256
    if (allBytes.reduce((a, b) => a + b, 0) & 0xFF) {
      showMbResult(resultEl, 'LRC err', 'error'); return;
    }

    const frameBytes = allBytes.slice(0, -1); // strip LRC
    if (frameBytes[1] & 0x80) {
      showMbResult(resultEl, `Ex ${frameBytes[2]}`, 'error'); return;
    }
    const dataBytes = new Uint8Array(frameBytes.slice(3));
    if (dataBytes.length === 0) { showMbResult(resultEl, 'No data', 'error'); return; }
    const result = parseDataBytes(dataBytes, mbType, mbSize, mbOrder);
    if (result.error) { showMbResult(resultEl, result.error, 'error'); return; }
    showMbResult(resultEl, String(result.value), 'ok');
    if (onResult) onResult(result.value);
    return;
  }

  // ── Modbus RTU response ───────────────────────────────
  const raw = new Uint8Array(buf);
  if (raw.length < 5) { showMbResult(resultEl, 'Short resp', 'error'); return; }

  const rcvCrc = raw[raw.length - 2] | (raw[raw.length - 1] << 8);
  if (rcvCrc !== calcModbusCRC16(raw.slice(0, raw.length - 2))) {
    showMbResult(resultEl, 'CRC err', 'error'); return;
  }

  if (raw[1] & 0x80) {
    const EX = { 1: 'Func', 2: 'Addr', 3: 'Value', 4: 'Fail', 6: 'Busy' };
    showMbResult(resultEl, `Ex ${raw[2]}: ${EX[raw[2]] || '?'}`, 'error'); return;
  }

  const dataBytes = raw.slice(3, raw.length - 2);
  if (dataBytes.length === 0) { showMbResult(resultEl, 'No data', 'error'); return; }

  const result = parseDataBytes(dataBytes, mbType, mbSize, mbOrder);
  if (result.error) { showMbResult(resultEl, result.error, 'error'); return; }
  showMbResult(resultEl, String(result.value), 'ok');
  if (onResult) onResult(result.value);
}

// ── Modbus Slave ──────────────────────────────────────

function encodeDataBytes(valueStr, type, size, order) {
  const n = Number(valueStr);
  const byteCount = size / 8;
  const buf = new ArrayBuffer(byteCount);
  const view = new DataView(buf);
  if (type === 'float') {
    view.setFloat32(0, n, false);
  } else if (type === 'double') {
    view.setFloat64(0, n, false);
  } else if (type === 'signed') {
    if (size === 8)       view.setInt8(0, n);
    else if (size === 16) view.setInt16(0, n, false);
    else if (size === 32) view.setInt32(0, n, false);
    else                  view.setBigInt64(0, BigInt(Math.trunc(n)), false);
  } else {
    if (size === 8)       view.setUint8(0, n);
    else if (size === 16) view.setUint16(0, n, false);
    else if (size === 32) view.setUint32(0, n, false);
    else                  view.setBigUint64(0, BigInt(Math.trunc(n)), false);
  }
  // reorderBytes is self-inverse: converts big-endian DataView output → wire byte order
  return reorderBytes(new Uint8Array(buf), order, byteCount);
}

function buildRtuSlaveResponse(addr, fc, dataBytes) {
  const frame = [addr, fc, dataBytes.length, ...dataBytes];
  const crc = calcModbusCRC16(new Uint8Array(frame));
  return new Uint8Array([...frame, crc & 0xFF, (crc >>> 8) & 0xFF]);
}

function buildAsciiSlaveResponse(addr, fc, dataBytes) {
  const payload = [addr, fc, dataBytes.length, ...dataBytes];
  const lrc = calcModbusLRC(new Uint8Array(payload));
  const hexStr = [...payload, lrc].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return new TextEncoder().encode(`:${hexStr}\r\n`);
}

function parseSlavePattern(cmd) {
  const s = (cmd.slavePattern || '').replace(/\s+/g, '');
  if (s.length < 4) return null;
  const addr = parseInt(s.slice(0, 2), 16);
  const fc   = parseInt(s.slice(2, 4), 16);
  const reg  = s.length >= 8 ? parseInt(s.slice(4, 8), 16)
             : s.length >= 6 ? parseInt(s.slice(4, 6), 16) : 0;
  if (isNaN(addr) || isNaN(fc) || isNaN(reg)) return null;
  return { addr, fc, reg };
}

function processSlaveRequest() {
  const buf = slaveBuf.slice();
  slaveBuf = [];
  if (buf.length === 0) return;

  const isAsciiReq = buf[0] === 0x3A; // ':'

  // ── Parse the incoming request ────────────────────────
  let reqAddr, reqFc, reqReg, qty;

  if (isAsciiReq) {
    const str = new TextDecoder().decode(new Uint8Array(buf));
    const m = str.match(/^:([0-9A-Fa-f]+)\r?\n?/);
    if (!m) return;
    const hex = m[1];
    if (hex.length < 12 || hex.length % 2 !== 0) return;
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    if (bytes.reduce((a, b) => a + b, 0) & 0xFF) return; // bad LRC
    const frame = bytes.slice(0, -1);
    [reqAddr, reqFc] = [frame[0], frame[1]];
    reqReg = (frame[2] << 8) | frame[3];
    qty    = (frame[4] << 8) | frame[5];
  } else {
    const raw = new Uint8Array(buf);
    if (raw.length < 8) return;
    const rcvCrc = raw[raw.length - 2] | (raw[raw.length - 1] << 8);
    if (rcvCrc !== calcModbusCRC16(raw.slice(0, raw.length - 2))) return;
    [reqAddr, reqFc] = [raw[0], raw[1]];
    reqReg = (raw[2] << 8) | raw[3];
    qty    = (raw[4] << 8) | raw[5];
  }

  // Ignore if no command handles this addr+FC at all
  if (!commands.some(c => { const p = parseSlavePattern(c); return p && p.addr === reqAddr && p.fc === reqFc; })) return;

  // ── Assemble response data: qty * 2 bytes (zeros for undefined registers) ──
  const respData = new Uint8Array(qty * 2);

  for (const cmd of commands) {
    const p = parseSlavePattern(cmd);
    if (!p || p.addr !== reqAddr || p.fc !== reqFc) continue;

    const size    = parseInt(cmd.mbSize  || 16);
    const numRegs = size / 16; // registers this value spans

    // Skip if this command's range doesn't overlap the requested range
    if (p.reg >= reqReg + qty || p.reg + numRegs <= reqReg) continue;

    try {
      const dataBytes  = encodeDataBytes(cmd.value || '0', cmd.mbType || 'unsigned', size, cmd.mbOrder || 'ABCD');
      const byteOffset = (p.reg - reqReg) * 2;
      const srcStart   = Math.max(0, -byteOffset);
      const dstStart   = Math.max(0, byteOffset);
      const copyLen    = Math.min(dataBytes.length - srcStart, respData.length - dstStart);
      for (let j = 0; j < copyLen; j++) respData[dstStart + j] = dataBytes[srcStart + j];
    } catch (e) { console.warn('Slave encode err:', e); }
  }

  // ── Send response ─────────────────────────────────────
  try {
    if (isAsciiReq) {
      const r = buildAsciiSlaveResponse(reqAddr, reqFc, respData);
      if (mqttMode) mqttMgr.sendRaw(r); else serial.send(r);
      appendTxEcho(r, '←');
    } else {
      const r = buildRtuSlaveResponse(reqAddr, reqFc, respData);
      if (mqttMode) mqttMgr.send(r); else serial.send(r);
      appendTxEcho(r, '←');
    }
  } catch (e) { console.warn('Slave respond err:', e); }
}

// ── Send ──────────────────────────────────────────────
async function doSend(value, isHex, withNL, modbusOpts = null) {
  const connected = mqttMode ? mqttMgr.connected : serial.connected;
  if (!connected) { alert('Not connected.'); return; }

  let bytes;
  try {
    // In Modbus mode the value is always a hex PDU regardless of the Hex checkbox
    bytes = (isHex || modbusOpts) ? parseHex(value) : new TextEncoder().encode(value);
  } catch (err) { alert(err.message); return; }

  if (modbusOpts) {
    if (modbusOpts.isAscii) {
      // Modbus ASCII: :HHHHH...LRC\r\n
      const lrc = calcModbusLRC(bytes);
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
      bytes = new TextEncoder().encode(':' + hex + lrc.toString(16).padStart(2, '0').toUpperCase() + '\r\n');
    } else {
      // Modbus RTU: payload + CRC-16 LE
      const crc = calcModbusCRC16(bytes);
      const out = new Uint8Array(bytes.length + 2);
      out.set(bytes);
      out[bytes.length]     = crc & 0xFF;
      out[bytes.length + 1] = (crc >>> 8) & 0xFF;
      bytes = out;
    }
  } else if (withNL) {
    const out = new Uint8Array(bytes.length + 2);
    out.set(bytes);
    out[bytes.length]     = 0x0D;
    out[bytes.length + 1] = 0x0A;
    bytes = out;
  }

  try {
    if (mqttMode) {
      if (modbusOpts) await mqttMgr.send(bytes);    // Modbus: hex-encoded ASCII
      else {
        await mqttMgr.sendRaw(bytes);               // General: raw bytes
        if (!mqttMgr.subMatchesPub()) appendRx(`[↑ ${mqttMgr._sendTopic}] ${value}\n`);
      }
    } else {
      await serial.send(bytes);
    }
    txCount += bytes.length;
    updateStats();
    appendTxEcho(bytes, '→');
  } catch (err) { alert('Send failed: ' + err.message); return; }

  if (modbusOpts) {
    if (pendingModbus) {
      clearTimeout(pendingModbus.timer);
      clearTimeout(pendingModbus.hardTimeout);
    }
    const { resultEl, mbType, mbSize, mbOrder, isAscii, cmdName, graph, graphColor } = modbusOpts;
    showMbResult(resultEl, '…', 'waiting');
    const onResult = (graph && cmdName) ? (v => broadcastGraphPoint(cmdName, graphColor, v)) : null;
    pendingModbus = { buf: [], resultEl, mbType, mbSize, mbOrder, isAscii, onResult, timer: null, hardTimeout: null };
    // Hard timeout: 4 s — fires if no response arrives at all
    pendingModbus.hardTimeout = setTimeout(() => {
      const el = pendingModbus?.resultEl;
      pendingModbus = null;
      showMbResult(el, 'No response', 'error');
    }, 4000);
    // Silence timer: 200 ms after last byte — detects end of response
    pendingModbus.timer = setTimeout(processModbusResponse, 200);
  }
}

function parseHex(str) {
  const clean = str.replace(/\s+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0)
    throw new Error('Invalid hex input: odd number of characters');
  if (!/^[0-9A-Fa-f]+$/.test(clean))
    throw new Error('Invalid hex input: contains non-hex characters');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function formatHexInput(el) {
  const start = el.selectionStart;
  const hexBefore = el.value.slice(0, start).replace(/[^0-9A-Fa-f]/g, '').length;
  const hex = el.value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  el.value = hex.match(/.{1,2}/g)?.join(' ') ?? '';
  const pos = hexBefore === 0 ? 0
    : Math.floor((hexBefore - 1) / 2) * 3 + (hexBefore - 1) % 2 + 1;
  el.setSelectionRange(pos, pos);
}

elBtnSend.addEventListener('click', () => {
  doSend(elTxInput.value, elTxHex.checked, elAppendNL.checked);
});

elTxInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doSend(elTxInput.value, elTxHex.checked, elAppendNL.checked);
});

elTxHex.addEventListener('change', () => { elTxInput.value = ''; });
elTxInput.addEventListener('input', () => { if (elTxHex.checked) formatHexInput(elTxInput); });

// ── Stats ─────────────────────────────────────────────
function updateStats() {
  elRxStat.textContent = 'RX: ' + fmtBytes(rxCount);
  elTxStat.textContent = 'TX: ' + fmtBytes(txCount);
}

function fmtBytes(n) {
  if (n < 1024)         return n + ' B';
  if (n < 1024 * 1024)  return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

// ── Timestamp ─────────────────────────────────────────
function getTimestamp() {
  const d = new Date();
  return d.toLocaleTimeString('en-US', { hour12: false })
       + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// ── Log to File ───────────────────────────────────────
elBtnLog.addEventListener('click', () => {
  if (logEnabled) stopLog();
  else startLog();
});

async function startLog() {
  try {
    logFileHandle = await window.showSaveFilePicker({
      suggestedName: 'serial_log.txt',
      types: [{ description: 'Log files', accept: { 'text/plain': ['.txt', '.log'] } }],
    });
    const append = elChkLogAppend.checked;
    if (append) {
      const file = await logFileHandle.getFile();
      logWritable = await logFileHandle.createWritable({ keepExistingData: true });
      await logWritable.seek(file.size);
    } else {
      logWritable = await logFileHandle.createWritable();
    }
    logEnabled = true;
    elLogFileName.textContent = logFileHandle.name;
    elBtnLog.textContent = 'Stop Log';
    elBtnLog.classList.add('active');
    await writeLog(`\n=== Session started ${getTimestamp()} ===\n`);
  } catch (err) {
    if (err.name !== 'AbortError') alert('Failed to open log file:\n' + err.message);
    logFileHandle = null;
    logWritable   = null;
  }
}

async function stopLog() {
  if (logWritable) {
    try {
      await writeLog(`=== Session ended ${getTimestamp()} ===\n`);
      await logWritable.close();
    } catch {}
  }
  logFileHandle = null;
  logWritable   = null;
  logEnabled    = false;
  elLogFileName.textContent = '';
  elBtnLog.textContent = 'Log';
  elBtnLog.classList.remove('active');
}

async function writeLog(text) {
  if (!logWritable) return;
  try {
    await logWritable.write(text);
  } catch (err) {
    console.warn('Log write error:', err);
    stopLog();
  }
}

// ── Extension Commands ────────────────────────────────
function buildSendPreview(cmd) {
  if (cmd.modbus) {
    let pdu;
    try { pdu = parseHex(cmd.value || ''); } catch { return '(invalid hex)'; }
    if (pdu.length === 0) return '(empty)';
    if (!cmd.isHex) {
      // Modbus ASCII: :HHHHH...LRC\r\n
      const lrc = calcModbusLRC(pdu);
      const hex = Array.from(pdu).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
      return ':' + hex + lrc.toString(16).padStart(2, '0').toUpperCase() + '\\r\\n';
    }
    // Modbus RTU: raw bytes + CRC
    const crc = calcModbusCRC16(pdu);
    const out = new Uint8Array(pdu.length + 2);
    out.set(pdu);
    out[pdu.length]     = crc & 0xFF;
    out[pdu.length + 1] = (crc >>> 8) & 0xFF;
    return Array.from(out).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  let bytes;
  try {
    bytes = cmd.isHex ? parseHex(cmd.value || '') : new TextEncoder().encode(cmd.value || '');
  } catch { return '(invalid hex)'; }
  if (cmd.appendNL === true) {
    const out = new Uint8Array(bytes.length + 2);
    out.set(bytes);
    out[bytes.length]     = 0x0D;
    out[bytes.length + 1] = 0x0A;
    bytes = out;
  }
  if (bytes.length === 0) return '(empty)';
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function loadCommands() {
  commands = Storage.getCommands();
  renderCommands();
}

function renderCommands() {
  cmdResultEls = [];
  elCmdList.innerHTML = '';
  commands.forEach((cmd, i) => elCmdList.appendChild(buildCmdRow(cmd, i)));
}

function buildCmdRow(cmd, i) {
  const entry = document.createElement('div');
  entry.className = 'cmd-entry';
  if (expandedCmds.has(cmd)) entry.classList.add('expanded');

  const row = document.createElement('div');
  row.className = 'cmd-row';

  const previewEl = document.createElement('div');
  previewEl.className = 'cmd-preview cmd-cfg';
  previewEl.style.display = 'none';

  let showActive = false;
  function updatePreview() { previewEl.textContent = '→ ' + buildSendPreview(commands[i]); }

  // Mobile: read-only title shown in the collapsed row
  const nameLabel = document.createElement('span');
  nameLabel.className = 'cmd-name-label';
  function updateNameLabel() {
    const c = commands[i];
    const byValue = !c.name && !!c.value;
    nameLabel.textContent = c.name || c.value || `CMD ${i + 1}`;
    nameLabel.classList.toggle('is-value', byValue);
  }
  updateNameLabel();

  // Mobile: toggles the config section of this command
  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-cmd-edit';
  editBtn.title     = 'Configure';
  editBtn.setAttribute('aria-label', 'Configure command');
  editBtn.setAttribute('aria-expanded', String(expandedCmds.has(cmd)));
  editBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-sliders"/></svg>';
  editBtn.addEventListener('click', () => {
    const open = entry.classList.toggle('expanded');
    if (open) expandedCmds.add(commands[i]); else expandedCmds.delete(commands[i]);
    editBtn.setAttribute('aria-expanded', String(open));
  });

  const nameEl = makeInput('text', 'cmd-name-input cmd-cfg', cmd.name || '', 'Name');
  nameEl.addEventListener('input', () => { commands[i].name = nameEl.value; Storage.saveCommands(commands); updateNameLabel(); });

  // In slave mode the value is what you edit most, so it stays visible on mobile
  const valEl = makeInput('text', slaveMode ? 'cmd-val-input' : 'cmd-val-input cmd-cfg', cmd.value || '', 'Command data');
  valEl.addEventListener('input', () => {
    if (commands[i].isHex && !slaveMode) formatHexInput(valEl);
    commands[i].value = valEl.value;
    Storage.saveCommands(commands);
    updateNameLabel();
    if (showActive) updatePreview();
  });

  // Result input created early so closures and the poller can reference it
  const mbResultEl = document.createElement('input');
  mbResultEl.type = 'text';
  mbResultEl.className = slaveMode ? 'cmd-mb-result cmd-cfg' : 'cmd-mb-result';
  mbResultEl.readOnly = true;
  mbResultEl.placeholder = '—';
  cmdResultEls[i] = mbResultEl;

  function getMbOpts() {
    const c = commands[i];
    if (!c.modbus) return null;
    return {
      resultEl:   mbResultEl,
      mbType:     c.mbType  || 'unsigned',
      mbSize:     parseInt(c.mbSize  || 16),
      mbOrder:    c.mbOrder || 'ABCD',
      isAscii:    !c.isHex,
      cmdName:    c.name || `CMD${i+1}`,
      graph:      !!c.graph,
      graphColor: c.graphColor || '#fff',
    };
  }

  valEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const c = commands[i];
      doSend(c.value, c.isHex, c.appendNL === true, getMbOpts());
    }
  });

  const graphLabel = makeCheckLabel('Graph', !!cmd.graph, v => {
    commands[i].graph = v;
    if (v) {
      if (!commands[i].graphColor) commands[i].graphColor = randomGraphColor();
      ensureGraphOpen();
      // If the result field already has a valid value, send it now
      if (mbResultEl.dataset.state === 'ok') {
        const val = parseFloat(mbResultEl.value);
        if (!isNaN(val))
          broadcastGraphPoint(commands[i].name || `CMD${i+1}`, commands[i].graphColor, val);
      }
    } else {
      graphCh.postMessage({ type: 'series_remove', name: commands[i].name || `CMD${i+1}` });
    }
    Storage.saveCommands(commands);
  });
  const slavePatternEl = makeInput('text', 'cmd-slave-input', cmd.slavePattern || '', '01030000');
  slavePatternEl.title = 'Request to match: addr+FC+reg as hex (e.g. 01030001 or 01 03 0001)';
  slavePatternEl.addEventListener('input', () => {
    commands[i].slavePattern = slavePatternEl.value;
    Storage.saveCommands(commands);
  });

  // modbusLabel only used in master mode; hidden in slave mode
  const modbusLabel = makeCheckLabel('Modbus', !!cmd.modbus, v => {
    commands[i].modbus = v;
    [mbTypeEl, mbSizeEl, mbOrderEl, mbResultEl, showBtn, graphLabel].forEach(el => { el.style.display = v ? '' : 'none'; });
    nlLabel.style.display = v ? 'none' : '';
    if (!v) {
      if (showActive) { showActive = false; previewEl.style.display = 'none'; }
      if (commands[i].graph) {
        commands[i].graph = false;
        graphCh.postMessage({ type: 'series_remove', name: commands[i].name || `CMD${i+1}` });
      }
    }
    Storage.saveCommands(commands);
    if (showActive) updatePreview();
  });

  const hexLabel = makeCheckLabel('Hex', !!cmd.isHex, v => {
    commands[i].isHex = v;
    if (!slaveMode) { valEl.value = ''; commands[i].value = ''; updateNameLabel(); }
    Storage.saveCommands(commands);
    if (showActive) updatePreview();
  });

  const nlLabel = makeCheckLabel('+\\r\\n', cmd.appendNL === true, v => {
    commands[i].appendNL = v;
    Storage.saveCommands(commands);
    if (showActive) updatePreview();
  });
  nlLabel.style.display = cmd.modbus ? 'none' : '';

  const showBtn = document.createElement('button');
  showBtn.className   = 'btn btn-cmd-show';
  showBtn.textContent = '⋯';
  showBtn.title       = 'Preview send bytes';
  showBtn.addEventListener('click', () => {
    showActive = !showActive;
    previewEl.style.display = showActive ? '' : 'none';
    showBtn.classList.toggle('active', showActive);
    if (showActive) updatePreview();
  });

  const sendBtn = document.createElement('button');
  sendBtn.className   = 'btn btn-cmd-send';
  sendBtn.textContent = 'Send';
  sendBtn.addEventListener('click', () => {
    const c = commands[i];
    doSend(c.value, c.isHex, c.appendNL === true, getMbOpts());
  });

  const delBtn = document.createElement('button');
  delBtn.className   = 'btn btn-cmd-del';
  delBtn.textContent = '×';
  delBtn.title       = 'Remove';
  delBtn.addEventListener('click', () => {
    commands.splice(i, 1);
    Storage.saveCommands(commands);
    renderCommands();
  });

  // ── Modbus inline controls ────────────────────────────
  const mbTypeEl = document.createElement('select');
  mbTypeEl.className = 'cmd-mb-select';
  [['unsigned', 'Unsigned'], ['signed', 'Signed'], ['float', 'Float'], ['double', 'Double']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    if ((cmd.mbType || 'unsigned') === v) o.selected = true;
    mbTypeEl.appendChild(o);
  });
  mbTypeEl.addEventListener('change', () => {
    commands[i].mbType = mbTypeEl.value;
    if (mbTypeEl.value === 'double') {
      mbSizeEl.value = '64';
      commands[i].mbSize = 64;
    }
    Storage.saveCommands(commands);
    updateSizeOptions();
    updateOrderOptions();
  });

  const mbSizeEl = document.createElement('select');
  mbSizeEl.className = 'cmd-mb-select cmd-mb-size';
  ['8', '16', '32', '64'].forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v + ' bit';
    if (String(cmd.mbSize || 16) === v) o.selected = true;
    mbSizeEl.appendChild(o);
  });
  mbSizeEl.addEventListener('change', () => {
    commands[i].mbSize = parseInt(mbSizeEl.value);
    Storage.saveCommands(commands);
    updateOrderOptions();
  });

  function updateSizeOptions() {
    const type = mbTypeEl.value;
    Array.from(mbSizeEl.options).forEach(o => {
      const hide = (type === 'double' && o.value !== '64')
                || (type === 'float'  && o.value !== '32');
      o.hidden   = hide;
      o.disabled = hide;
    });
    if (type === 'float' && mbSizeEl.value !== '32') {
      mbSizeEl.value = '32';
      commands[i].mbSize = 32;
      Storage.saveCommands(commands);
    }
  }

  const mbOrderEl = document.createElement('select');
  mbOrderEl.className = 'cmd-mb-order-select';
  [
    ['ABCD', 'ABCD – Big Endian'],
    ['DCBA', 'DCBA – Little Endian'],
    ['CDAB', 'CDAB – Little Endian Byte Swap'],
    ['BADC', 'BADC – Big Endian Byte Swap'],
  ].forEach(([v, long]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    o.dataset.long = long;
    if ((cmd.mbOrder || 'ABCD') === v) o.selected = true;
    mbOrderEl.appendChild(o);
  });
  mbOrderEl.addEventListener('focus', () => {
    Array.from(mbOrderEl.options).forEach(o => { o.textContent = o.dataset.long; });
  });
  mbOrderEl.addEventListener('blur', () => {
    Array.from(mbOrderEl.options).forEach(o => { o.textContent = o.value; });
  });
  mbOrderEl.addEventListener('change', () => { commands[i].mbOrder = mbOrderEl.value; Storage.saveCommands(commands); });

  function updateOrderOptions() {
    const is64 = parseInt(mbSizeEl.value) === 64;
    Array.from(mbOrderEl.options).forEach(o => {
      o.hidden    = is64 && (o.value === 'CDAB' || o.value === 'BADC');
      o.disabled  = is64 && (o.value === 'CDAB' || o.value === 'BADC');
    });
    if (is64 && (mbOrderEl.value === 'CDAB' || mbOrderEl.value === 'BADC')) {
      mbOrderEl.value = 'ABCD';
      commands[i].mbOrder = 'ABCD';
      Storage.saveCommands(commands);
    }
  }
  updateSizeOptions();  // apply on initial render
  updateOrderOptions();

  if (slaveMode) {
    // Slave mode: show hex(RTU/ASCII), type/size/order, pattern; hide everything else
    [mbTypeEl, mbSizeEl, mbOrderEl, mbResultEl, hexLabel, slavePatternEl].forEach(el => { el.style.display = ''; });
    [modbusLabel, nlLabel, showBtn, graphLabel, sendBtn].forEach(el => { el.style.display = 'none'; });
    valEl.placeholder = 'Slave value';
  } else {
    // Master mode: normal behaviour driven by Modbus checkbox
    [mbTypeEl, mbSizeEl, mbOrderEl, mbResultEl, showBtn, graphLabel].forEach(el => { el.style.display = cmd.modbus ? '' : 'none'; });
    nlLabel.style.display        = cmd.modbus ? 'none' : '';
    slavePatternEl.style.display = 'none';
  }
  // Config controls: always visible on desktop, behind editBtn on mobile
  [modbusLabel, hexLabel, nlLabel, mbTypeEl, mbSizeEl, mbOrderEl, showBtn, graphLabel, slavePatternEl, delBtn]
    .forEach(el => el.classList.add('cmd-cfg'));

  row.append(nameLabel, nameEl, mbResultEl, valEl, modbusLabel, hexLabel, nlLabel, mbTypeEl, mbSizeEl, mbOrderEl, showBtn, graphLabel, slavePatternEl, sendBtn, delBtn, editBtn);
  entry.append(row, previewEl);
  return entry;
}

function makeInput(type, cls, value, placeholder) {
  const el = document.createElement('input');
  el.type        = type;
  el.className   = cls;
  el.value       = value;
  el.placeholder = placeholder;
  el.spellcheck  = false;
  return el;
}

function makeCheckLabel(labelText, checked, onChange) {
  const label = document.createElement('label');
  label.className = 'cmd-chk';
  const cb = document.createElement('input');
  cb.type    = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  label.appendChild(cb);
  label.appendChild(document.createTextNode(' ' + labelText));
  return label;
}

$('btnAddCmd').addEventListener('click', () => {
  const cmd = { name: '', value: '', isHex: false, appendNL: false, modbus: false, mbType: 'unsigned', mbSize: 16, mbOrder: 'ABCD', graph: false, graphColor: '', slavePattern: '' };
  commands.push(cmd);
  expandedCmds.add(cmd); // a new command needs configuring — open it on mobile
  Storage.saveCommands(commands);
  renderCommands();
  const rows = elCmdList.querySelectorAll('.cmd-entry');
  const last = rows[rows.length - 1];
  last?.scrollIntoView({ block: 'nearest' });
  last?.querySelector('.cmd-name-input')?.focus();
});

// ── Import / Export Commands ──────────────────────────
$('btnExportCmds').addEventListener('click', () => {
  const json = JSON.stringify(commands, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'serial_commands.json';
  a.click();
  URL.revokeObjectURL(url);
});

$('btnImportCmds').addEventListener('click', () => {
  $('importFileInput').click();
});

$('importFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data)) throw new Error('Expected a JSON array');
      commands = data.map(c => ({
        name:     String(c.name  ?? ''),
        value:    String(c.value ?? ''),
        isHex:    !!c.isHex,
        appendNL: c.appendNL === true,
        modbus:   !!c.modbus,
        mbType:   ['unsigned', 'signed', 'float', 'double'].includes(c.mbType) ? c.mbType : 'unsigned',
        mbSize:   [8, 16, 32, 64].includes(+c.mbSize) ? +c.mbSize : 16,
        mbOrder:     ['ABCD', 'DCBA', 'CDAB', 'BADC'].includes(c.mbOrder) ? c.mbOrder : 'ABCD',
        graph:        !!c.graph,
        graphColor:   typeof c.graphColor === 'string' ? c.graphColor : '',
        slavePattern: typeof c.slavePattern === 'string' ? c.slavePattern : '',
      }));
      Storage.saveCommands(commands);
      renderCommands();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
});

// ── Poll ──────────────────────────────────────────────
function stopPoll() {
  pollActive = false;
  clearTimeout(pollTimerId);
  pollTimerId = null;
  const btn = $('btnPoll');
  if (btn) { btn.textContent = 'Poll'; btn.classList.remove('active'); }
}

async function pollStep() {
  if (!pollActive || commands.length === 0) { stopPoll(); return; }
  const connected = mqttMode ? mqttMgr.connected : serial.connected;
  if (!connected) { stopPoll(); return; }

  const i = pollIndex;
  const c = commands[i];
  const mbOpts = c.modbus ? {
    resultEl:   cmdResultEls[i] || null,
    mbType:     c.mbType  || 'unsigned',
    mbSize:     parseInt(c.mbSize  || 16),
    mbOrder:    c.mbOrder || 'ABCD',
    isAscii:    !c.isHex,
    cmdName:    c.name || `CMD${i+1}`,
    graph:      !!c.graph,
    graphColor: c.graphColor || '#fff',
  } : null;

  await doSend(c.value, c.isHex, c.appendNL === true, mbOpts);

  pollIndex = (pollIndex + 1) % commands.length;

  if (pollIndex === 0 && !$('pollLoop').checked) {
    stopPoll();
    return;
  }

  const delay = parseInt($('pollDelay').value, 10) || 0;
  pollTimerId = setTimeout(pollStep, delay);
}

$('btnPoll').addEventListener('click', () => {
  if (pollActive) { stopPoll(); return; }
  if (commands.length === 0) { alert('No commands to poll.'); return; }
  const connected = mqttMode ? mqttMgr.connected : serial.connected;
  if (!connected) { alert('Not connected.'); return; }
  pollActive = true;
  pollIndex = 0;
  $('btnPoll').textContent = 'Stop Poll';
  $('btnPoll').classList.add('active');
  pollStep();
});

// ── MQTT UI ───────────────────────────────────────────
$('chkSlave').addEventListener('change', e => {
  slaveMode = e.target.checked;
  commands = [];
  Storage.saveCommands(commands);
  $('txInput').disabled = slaveMode;
  $('btnSend').disabled = slaveMode;
  $('btnPoll').disabled = slaveMode;
  if (!slaveMode) stopPoll();
  renderCommands();
});

$('chkMqtt').addEventListener('change', () => {
  $('mqttBar').style.display = $('chkMqtt').checked ? '' : 'none';
  // mobile: open the MQTT fields straight away if nothing is configured yet
  if ($('chkMqtt').checked && !$('mqttHost').value.trim()) toggleOpts('mqttBar', true);
  if (!$('chkMqtt').checked && mqttMgr.connected) {
    mqttMgr.disconnect();
    mqttMode = false;
    setConnected(false, '');
    setMqttDevStatus(null);
    $('btnMqttConnect').textContent = 'Connect';
    $('btnMqttConnect').classList.remove('is-open');
  }
});

$('btnMqttConnect').addEventListener('click', async () => {
  if (mqttMgr.connected) {
    mqttMgr.disconnect();
    mqttMode = false;
    setConnected(false, '');
    setMqttDevStatus(null);
    $('btnMqttConnect').textContent = 'Connect';
    $('btnMqttConnect').classList.remove('is-open');
    return;
  }

  const proto       = $('mqttProto').value;
  const host        = $('mqttHost').value.trim();
  const port        = $('mqttPort').value.trim();
  const path        = $('mqttPath').value.trim();
  const user        = $('mqttUser').value.trim();
  const pass        = $('mqttPass').value;
  const sendTopic   = $('mqttSendTopic').value.trim();
  const recvTopic   = $('mqttRecvTopic').value.trim();
  const statusTopic = $('mqttStatusTopic').value.trim();
  const qos         = parseInt($('mqttQos').value) || 0;
  const retain      = $('mqttRetain').checked;

  if (!host)      { alert('Broker host is required'); return; }
  if (!port)      { alert('Broker port is required'); return; }
  if (!sendTopic) { alert('Publish topic is required'); return; }
  if (sendTopic.includes('+') || sendTopic.includes('#')) {
    alert('Publish topic cannot contain wildcards (+ or #).\nWildcards are only valid for subscribing.');
    return;
  }
  if (!recvTopic) { alert('Subscribe topic is required'); return; }

  const url = `${proto}${host}:${port}${path}`;

  const btn = $('btnMqttConnect');
  btn.textContent = 'Connecting…';
  btn.disabled = true;

  try {
    await mqttMgr.connect({ url, sendTopic, recvTopic, statusTopic, username: user, password: pass, qos, retain });
    mqttMode = true;
    setConnected(true, `MQTT · ${host}`);
    setMqttDevStatus('waiting');
    btn.textContent = 'Disconnect';
    btn.classList.add('is-open');
    toggleOpts('mqttBar', false); // mobile: tuck the fields away once connected
  } catch (err) {
    alert('MQTT connection failed:\n' + err.message);
    btn.textContent = 'Connect';
  } finally {
    btn.disabled = false;
  }
});

// ── Settings persistence ──────────────────────────────
const SETTING_IDS = ['baud', 'dataBits', 'parity', 'stopBits', 'breakMs', 'txHex', 'appendNL', 'showTx', 'pollDelay', 'pollLoop', 'chkSlave', 'mqttProto', 'mqttHost', 'mqttPort', 'mqttPath', 'mqttUser', 'mqttPass', 'mqttSendTopic', 'mqttRecvTopic', 'mqttStatusTopic', 'mqttQos', 'mqttRetain'];

function saveSettings() {
  const s = {};
  SETTING_IDS.forEach(id => {
    const el = $(id);
    s[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  Storage.saveSettings(s);
}

function loadSettings() {
  const s = Storage.getSettings();
  SETTING_IDS.forEach(id => {
    if (s[id] === undefined) return;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = s[id];
    else el.value = s[id];
  });
}

SETTING_IDS.forEach(id => $(id).addEventListener('change', saveSettings));

// ── Help ──────────────────────────────────────────────
$('btnHelp').addEventListener('click', () => window.open('help.html', 'sda_help'));

// ── Collapsible option groups (mobile) ────────────────
// [data-toggle="id"] buttons toggle .opts-open on #id; CSS shows/hides its .bar-opts.
function toggleOpts(id, force) {
  const target = $(id);
  if (!target) return;
  const open = target.classList.toggle('opts-open', force);
  document.querySelectorAll(`[data-toggle="${id}"]`).forEach(b => {
    b.classList.toggle('active', open);
    if (b.tagName === 'BUTTON') b.setAttribute('aria-expanded', String(open));
  });
}

document.querySelectorAll('[data-toggle]').forEach(b => {
  b.addEventListener('click', () => toggleOpts(b.dataset.toggle));
});

// ── Boot ──────────────────────────────────────────────
// File logging needs showSaveFilePicker (desktop Chrome/Edge only)
if (!('showSaveFilePicker' in window)) {
  document.querySelectorAll('.log-ctrl').forEach(el => { el.style.display = 'none'; });
}
loadSettings();
setConnected(false, '');
$('mqttBar').style.display = $('chkMqtt').checked ? '' : 'none';
slaveMode = $('chkSlave').checked;
if (slaveMode) {
  $('txInput').disabled = true;
  $('btnSend').disabled = true;
  $('btnPoll').disabled = true;
}
loadCommands();
