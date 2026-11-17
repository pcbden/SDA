'use strict';

// ════════════════════════════════════════════════════════════════
//  USB serial adapters over WebUSB
//
//  Chrome on Android doesn't list USB serial adapters through Web Serial,
//  but it does give pages raw USB access through WebUSB. The drivers below
//  speak each adapter's USB protocol directly (the same thing apps like
//  Serial USB Terminal do), and UsbSerialPort wraps them in an object that
//  behaves like a Web Serial SerialPort, so SerialManager uses it unchanged.
//
//  Supported:
//    CDC-ACM  — boards with native USB (STM32, RP2040, ESP32-S2/S3, nRF,
//               Arduino Leonardo/Micro/Zero…), CH9102/CH343
//    FTDI     — FT232R, FT-X, FT232H, FT2232C/D/H, FT4232H
//    CH34x    — WCH CH340, CH341
//    CP210x   — Silicon Labs CP2102/CP2104/CP2105/CP2108…
//    PL2303   — Prolific PL2303 (H, HX, TA/TB, HXN/G-series)
//
//  Protocol details follow the Linux kernel drivers
//  (cdc-acm, ftdi_sio, ch341, cp210x, pl2303).
// ════════════════════════════════════════════════════════════════

const USB_SERIAL_FILTERS = [
  { classCode: 0x02 },   // any device with a CDC (communications) interface
  { vendorId: 0x0403 },  // FTDI
  { vendorId: 0x1A86 },  // WCH
  { vendorId: 0x10C4 },  // Silicon Labs
  { vendorId: 0x067B },  // Prolific
];

const USB_PARITY = { none: 0, odd: 1, even: 2, mark: 3, space: 4 };

// ── helpers ─────────────────────────────────────────────────────

function usbHex4(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function usbBcd(major, minor, sub) {
  return (major << 8) | (minor << 4) | sub;
}

function usbConcat(parts) {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function usbIfaces(device) {
  const cfg = device.configuration || device.configurations?.[0];
  return cfg ? cfg.interfaces : [];
}

function usbIfaceClass(iface) {
  return (iface.alternate || iface.alternates[0])?.interfaceClass;
}

function usbBulkEps(iface) {
  const eps = (iface.alternate || iface.alternates[0])?.endpoints || [];
  const inEp  = eps.find(e => e.type === 'bulk' && e.direction === 'in');
  const outEp = eps.find(e => e.type === 'bulk' && e.direction === 'out');
  return inEp && outEp ? { inEp, outEp } : null;
}

async function usbOut(dev, requestType, recipient, request, value, index, data) {
  const r = await dev.controlTransferOut({ requestType, recipient, request, value, index }, data);
  if (r.status !== 'ok') throw new Error(`USB request 0x${request.toString(16)} failed (${r.status})`);
}

async function usbIn(dev, requestType, recipient, request, value, index, length) {
  const r = await dev.controlTransferIn({ requestType, recipient, request, value, index }, length);
  if (r.status !== 'ok' || !r.data) throw new Error(`USB request 0x${request.toString(16)} failed (${r.status})`);
  return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
}

function usbLine(o) {
  return {
    baudRate: o.baudRate || 9600,
    dataBits: o.dataBits || 8,
    parity:   o.parity   || 'none',
    stopBits: o.stopBits || 1,
  };
}

// CDC SET_LINE_CODING payload (also used by PL2303)
function usbLineCoding({ baudRate, dataBits, parity, stopBits }) {
  const b = new Uint8Array(7);
  new DataView(b.buffer).setUint32(0, baudRate, true);
  b[4] = stopBits === 2 ? 2 : 0;
  b[5] = USB_PARITY[parity] ?? 0;
  b[6] = dataBits;
  return b;
}

// FTDI: 3 MHz base clock with 1/8 fractional steps. Works on every FTDI
// chip (the H-series run in 3 MHz compatibility mode), up to 3 Mbaud.
function ftdiBaudDivisor(baud) {
  const div8 = Math.round(24000000 / baud);
  if (div8 < 8)            throw new Error(`Baud rate ${baud} is too high for FTDI (max 3000000)`);
  if ((div8 >> 3) > 0x3FFF) throw new Error(`Baud rate ${baud} is too low for FTDI`);
  let d = (div8 >> 3) | ([0, 3, 2, 4, 1, 5, 6, 7][div8 & 7] << 14);
  if (d === 1) d = 0;            // 3 Mbaud
  else if (d === 0x4001) d = 1;  // 2 Mbaud
  return d;                      // 17 bits: low 16 → wValue, bit 16 → wIndex
}

// CH34x: prescaler/divisor pair (Linux ch341_get_divisor)
function ch34xBaudDivisor(baud) {
  const CLK = 48000000;
  const clkDiv  = (ps, fact) => 1 << (12 - 3 * ps - fact);
  const minRate = ps => Math.floor(CLK / (clkDiv(ps, 1) * 512));
  const speed = Math.min(Math.max(baud, 46), 3000000);

  let fact = 1, ps;
  for (ps = 3; ps >= 0; ps--) if (speed > minRate(ps)) break;
  if (ps < 0) throw new Error(`Baud rate ${baud} is not supported by CH34x`);

  let cd  = clkDiv(ps, fact);
  let div = Math.floor(CLK / (cd * speed));
  if (div < 9 || div > 255) { div = Math.floor(div / 2); cd *= 2; fact = 0; }
  if (div < 2) throw new Error(`Baud rate ${baud} is not supported by CH34x`);

  // round to the nearest achievable rate
  if (Math.floor(16 * CLK / (cd * div)) - 16 * speed >=
      16 * speed - Math.floor(16 * CLK / (cd * (div + 1)))) div++;
  // prefer the lower base clock when the divisor is even
  if (fact === 1 && div % 2 === 0) { div /= 2; fact = 0; }

  return ((0x100 - div) << 8) | (fact << 2) | ps;
}

// ── drivers ─────────────────────────────────────────────────────

class UsbSerialDriver {
  constructor(device, kind) {
    this.device  = device;
    this.kind    = kind;
    this.channel = 0;
    this.inEp    = null;
    this.outEp   = null;
  }
  get channelCount() { return 1; }
  async claim(iface) { await this.device.claimInterface(iface.interfaceNumber); }
  async open(channel) {}
  async setLine(line) {}
  async setSignals(dtr, rts) {}
  decode(bytes) { return { data: bytes, error: null }; }
  async close() { await this.setSignals(false, false); }
}

// ── CDC-ACM ──
class CdcAcmDriver extends UsbSerialDriver {
  constructor(device) { super(device, 'CDC'); }

  // Each CDC function = data interface (0x0A, bulk in/out) + the control
  // interface (0x02) in front of it. Composite devices can have several.
  static functions(device) {
    const ifs = usbIfaces(device);
    const out = [];
    for (const it of ifs) {
      if (usbIfaceClass(it) !== 0x0A) continue;
      const eps = usbBulkEps(it);
      if (!eps) continue;
      const ctrl = ifs
        .filter(c => usbIfaceClass(c) === 0x02 && c.interfaceNumber < it.interfaceNumber)
        .sort((a, b) => b.interfaceNumber - a.interfaceNumber)[0] || null;
      out.push({ data: it, ctrl, ...eps });
    }
    if (!out.length) {
      // Some devices put the bulk endpoints on the control interface itself
      for (const it of ifs) {
        const eps = usbIfaceClass(it) === 0x02 && usbBulkEps(it);
        if (eps) out.push({ data: it, ctrl: it, ...eps });
      }
    }
    return out;
  }

  get channelCount() { return Math.max(1, CdcAcmDriver.functions(this.device).length); }

  async open(channel) {
    const fn = CdcAcmDriver.functions(this.device)[channel];
    if (!fn) throw new Error('No CDC data interface found on this device');
    this.channel = channel;
    this.ctrlIndex = null;
    if (fn.ctrl && fn.ctrl.interfaceNumber !== fn.data.interfaceNumber) {
      try { await this.claim(fn.ctrl); this.ctrlIndex = fn.ctrl.interfaceNumber; }
      catch (e) { console.warn('CDC: could not claim control interface, line settings disabled:', e.message); }
    }
    await this.claim(fn.data);
    if (fn.ctrl && fn.ctrl.interfaceNumber === fn.data.interfaceNumber) this.ctrlIndex = fn.data.interfaceNumber;
    this.inEp  = fn.inEp;
    this.outEp = fn.outEp;
  }

  // Native-USB devices often ignore line settings; a refusal is not an error.
  async setLine(line) {
    if (this.ctrlIndex === null) return;
    try { await usbOut(this.device, 'class', 'interface', 0x20, 0, this.ctrlIndex, usbLineCoding(line)); }
    catch (e) { console.warn('CDC: SET_LINE_CODING refused:', e.message); }
  }

  // Many devices (Arduino, TinyUSB, STM32 VCP) only send while DTR is set.
  async setSignals(dtr, rts) {
    if (this.ctrlIndex === null) return;
    try { await usbOut(this.device, 'class', 'interface', 0x22, (dtr ? 1 : 0) | (rts ? 2 : 0), this.ctrlIndex); }
    catch (e) { console.warn('CDC: SET_CONTROL_LINE_STATE refused:', e.message); }
  }
}

// ── FTDI ──
class FtdiDriver extends UsbSerialDriver {
  constructor(device) { super(device, 'FTDI'); }

  chans() { return usbIfaces(this.device).filter(i => usbBulkEps(i)); }
  get channelCount() { return Math.max(1, this.chans().length); }
  ctl(request, value, index) { return usbOut(this.device, 'vendor', 'device', request, value, index); }

  async open(channel) {
    const chans = this.chans();
    const iface = chans[channel];
    if (!iface) throw new Error('FTDI channel not found');
    this.channel = channel;
    await this.claim(iface);
    ({ inEp: this.inEp, outEp: this.outEp } = usbBulkEps(iface));
    this.index = iface.interfaceNumber + 1;              // A=1, B=2, …
    const ver = this.device.deviceVersionMajor;          // bcdDevice: 7=FT2232H 8=FT4232H 9=FT232H
    this.baudWithPort = ver === 7 || ver === 8 || ver === 9 || chans.length > 1;
    await this.ctl(0x00, 0x0000, this.index);            // SIO_RESET (purge RX+TX)
    await this.ctl(0x02, 0x0000, this.index);            // SIO_SET_FLOW_CTRL: none
  }

  async setLine({ baudRate, dataBits, parity, stopBits }) {
    const div = ftdiBaudDivisor(baudRate);
    let index = div >>> 16;
    if (this.baudWithPort) index = (index << 8) | this.index;
    await this.ctl(0x03, div & 0xFFFF, index);           // SIO_SET_BAUD_RATE
    await this.ctl(0x04, dataBits | (USB_PARITY[parity] << 8) | ((stopBits === 2 ? 2 : 0) << 11), this.index);
  }

  async setSignals(dtr, rts) {
    await this.ctl(0x01, 0x0300 | (dtr ? 1 : 0) | (rts ? 2 : 0), this.index);  // SIO_MODEM_CTRL
  }

  // Every USB packet starts with 2 status bytes: [modem status, line status].
  // Line status bits: 0x02 overrun, 0x04 parity, 0x08 framing, 0x10 break.
  decode(bytes) {
    const ps = this.inEp.packetSize;
    const parts = [];
    let error = null;
    for (let o = 0; o < bytes.length; o += ps) {
      const pkt = bytes.subarray(o, Math.min(o + ps, bytes.length));
      if (pkt.length <= 2) continue;
      parts.push(pkt.subarray(2));
      const st = pkt[1];
      if (!error && (st & 0x1E)) {
        error = st & 0x10 ? 'BreakError'
              : st & 0x08 ? 'FramingError'
              : st & 0x04 ? 'ParityError'
              :             'BufferOverrunError';
      }
    }
    return { data: parts.length ? usbConcat(parts) : new Uint8Array(0), error };
  }
}

// ── WCH CH340 / CH341 ──
class Ch34xDriver extends UsbSerialDriver {
  constructor(device) { super(device, 'CH34x'); }

  ctl(request, value, index) { return usbOut(this.device, 'vendor', 'device', request, value, index); }

  async open() {
    const iface = usbIfaces(this.device).find(i => usbBulkEps(i));
    if (!iface) throw new Error('CH34x: no bulk endpoints found');
    await this.claim(iface);
    ({ inEp: this.inEp, outEp: this.outEp } = usbBulkEps(iface));
    try { this.version = (await usbIn(this.device, 'vendor', 'device', 0x5F, 0, 0, 2))[0]; }
    catch { this.version = 0x30; }
    await this.ctl(0xA1, 0, 0);                          // serial init
  }

  async setLine({ baudRate, dataBits, parity, stopBits }) {
    let div = ch34xBaudDivisor(baudRate);
    if (this.version > 0x27) div |= 0x80;               // don't wait for a full packet before sending
    await this.ctl(0x9A, 0x1312, div);                  // prescaler + divisor registers
    let lcr = 0xC0 | (dataBits - 5);                    // RX+TX enable, CS5…CS8
    if (parity !== 'none') lcr |= 0x08;
    if (parity === 'even' || parity === 'space') lcr |= 0x10;
    if (parity === 'mark' || parity === 'space') lcr |= 0x20;
    if (stopBits === 2) lcr |= 0x04;
    await this.ctl(0x9A, 0x2518, lcr);                  // line control registers
  }

  async setSignals(dtr, rts) {
    await this.ctl(0xA4, ~((dtr ? 0x20 : 0) | (rts ? 0x40 : 0)) & 0xFFFF, 0);  // active low
  }
}

// ── Silicon Labs CP210x ──
class Cp210xDriver extends UsbSerialDriver {
  constructor(device) { super(device, 'CP210x'); }

  chans() { return usbIfaces(this.device).filter(i => usbBulkEps(i)); }
  get channelCount() { return Math.max(1, this.chans().length); }
  ctl(request, value, data) { return usbOut(this.device, 'vendor', 'interface', request, value, this.ifnum, data); }

  async open(channel) {
    const iface = this.chans()[channel];
    if (!iface) throw new Error('CP210x channel not found');
    this.channel = channel;
    await this.claim(iface);
    ({ inEp: this.inEp, outEp: this.outEp } = usbBulkEps(iface));
    this.ifnum = iface.interfaceNumber;
    await this.ctl(0x00, 0x0001);                       // IFC_ENABLE
    try { await this.ctl(0x12, 0x000F); } catch {}      // PURGE RX+TX
  }

  async setLine({ baudRate, dataBits, parity, stopBits }) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, baudRate, true);
    await this.ctl(0x1E, 0, b);                         // SET_BAUDRATE
    await this.ctl(0x03, (stopBits === 2 ? 2 : 0) | (USB_PARITY[parity] << 4) | (dataBits << 8));  // SET_LINE_CTL
  }

  async setSignals(dtr, rts) {
    await this.ctl(0x07, 0x0300 | (dtr ? 1 : 0) | (rts ? 2 : 0));  // SET_MHS
  }

  async close() {
    try { await super.close(); } catch {}
    await this.ctl(0x00, 0x0000);                       // IFC_ENABLE off
  }
}

// ── Prolific PL2303 ──
class Pl2303Driver extends UsbSerialDriver {
  constructor(device) { super(device, 'PL2303'); }

  vRead(value) {
    return usbIn(this.device, 'vendor', 'device', this.type === 'HXN' ? 0x81 : 0x01, value, 0, 1).then(b => b[0]);
  }
  vWrite(value, index) {
    return usbOut(this.device, 'vendor', 'device', this.type === 'HXN' ? 0x80 : 0x01, value, index);
  }

  async detectType() {
    const d = this.device;
    if (d.deviceClass === 0x02) return 'H';
    let mps0 = 0x40;
    try { mps0 = (await usbIn(d, 'standard', 'device', 0x06, 0x0100, 0, 18))[7]; } catch {}
    if (mps0 !== 0x40) return 'H';
    const bcdUSB = usbBcd(d.usbVersionMajor, d.usbVersionMinor, d.usbVersionSubminor);
    const bcdDev = usbBcd(d.deviceVersionMajor, d.deviceVersionMinor, d.deviceVersionSubminor);
    if (bcdUSB !== 0x0200) return 'HX';
    if (bcdDev === 0x0300 || bcdDev === 0x0500) {
      // TA/TB answer the HX status read; G-series parts with the same bcdDevice don't
      try {
        const r = await d.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x8080, index: 0 }, 1);
        if (r.status === 'ok') return 'TA';
      } catch {}
    }
    return 'HXN';
  }

  async open() {
    const iface = usbIfaces(this.device).find(i => usbBulkEps(i));
    if (!iface) throw new Error('PL2303: no bulk endpoints found');
    await this.claim(iface);
    ({ inEp: this.inEp, outEp: this.outEp } = usbBulkEps(iface));
    this.type = await this.detectType();

    if (this.type !== 'HXN') {
      const legacy = this.type === 'H';
      const seq = [
        ['r', 0x8484], ['w', 0x0404, 0], ['r', 0x8484], ['r', 0x8383],
        ['r', 0x8484], ['w', 0x0404, 1], ['r', 0x8484], ['r', 0x8383],
        ['w', 0x0000, 1], ['w', 0x0001, 0], ['w', 0x0002, legacy ? 0x24 : 0x44],
      ];
      for (const [op, value, index] of seq) {
        try { if (op === 'r') await this.vRead(value); else await this.vWrite(value, index); } catch {}
      }
    }

    // reset the data pipes
    if (this.type === 'H') {
      try { await this.device.clearHalt('in',  this.inEp.endpointNumber); } catch {}
      try { await this.device.clearHalt('out', this.outEp.endpointNumber); } catch {}
    } else if (this.type === 'HXN') {
      await this.vWrite(0x07, 0x03);
    } else {
      await this.vWrite(0x08, 0);
      await this.vWrite(0x09, 0);
    }
  }

  async setLine(line) {
    await usbOut(this.device, 'class', 'interface', 0x20, 0, 0, usbLineCoding(line));
    try {  // flow control off
      if (this.type === 'HXN') {
        const r = await this.vRead(0x0A);
        await this.vWrite(0x0A, (r & ~0x1C) | 0x1C);
      } else {
        const r = await this.vRead(0x80);
        await this.vWrite(0x00, r & ~0xF0);
      }
    } catch {}
  }

  async setSignals(dtr, rts) {
    await usbOut(this.device, 'class', 'interface', 0x22, (dtr ? 1 : 0) | (rts ? 2 : 0), 0);
  }
}

function createUsbSerialDriver(device) {
  const vid = device.vendorId;
  if (vid === 0x0403) return new FtdiDriver(device);
  if (vid === 0x10C4) return new Cp210xDriver(device);
  if (vid === 0x067B) return new Pl2303Driver(device);
  if (CdcAcmDriver.functions(device).length) return new CdcAcmDriver(device);  // before WCH: CH9102/CH343 are CDC
  if (vid === 0x1A86) return new Ch34xDriver(device);
  throw new Error(`Unsupported USB device ${usbHex4(vid)}:${usbHex4(device.productId)}. `
                + 'Supported: CDC-ACM, FTDI, CH340/CH341, CP210x, PL2303.');
}

function usbExplain(err) {
  const msg = String(err?.message || err);
  if (/claim/i.test(msg)) {
    return new Error('Could not take over the USB adapter: another app or driver is using it.\n\n'
      + 'On Android: close apps like Serial USB Terminal (and clear "Open by default" for this device), '
      + 'then unplug and replug the adapter.\n'
      + 'On a computer the operating system driver owns the adapter; use Chrome or Edge (Web Serial) there.');
  }
  return err instanceof Error ? err : new Error(msg);
}

// ── SerialPort-compatible wrapper ───────────────────────────────

class UsbSerialPort {
  static isSupported() {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }

  static async request() {
    const device = await navigator.usb.requestDevice({ filters: USB_SERIAL_FILTERS });
    return new UsbSerialPort(device);
  }

  constructor(device) {
    this.device    = device;
    this.driver    = createUsbSerialDriver(device);
    this._isOpen   = false;
    this._fatal    = false;
    this._gen      = 0;      // bumps on every open/close; stale loops exit
    this._readable = null;
    this._writable = null;
    this._ctl      = null;   // controller of the current readable stream
    this._q        = [];     // received chunks not read yet
    this._qBytes   = 0;
    this._qErr     = null;   // error to deliver after the queued data
    this._wake     = null;
  }

  get channelCount() { return this.driver.channelCount; }
  get channel()      { return this.driver.channel; }

  get label() {
    const d  = this.device;
    const ch = this.channelCount > 1 ? '-' + 'ABCDEFGH'[this.driver.channel] : '';
    return `${this.driver.kind}${ch} ${usbHex4(d.vendorId)}:${usbHex4(d.productId)}`;
  }

  getInfo() {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
  }

  async open(options = {}) {
    if (this._isOpen) throw new DOMException('The port is already open.', 'InvalidStateError');
    const dev = this.device;
    try {
      if (!dev.opened) await dev.open();
      if (!dev.configuration) await dev.selectConfiguration(dev.configurations[0].configurationValue);
      const ch = Math.min(Math.max(options.channel | 0, 0), this.channelCount - 1);
      await this.driver.open(ch);
      await this.driver.setLine(usbLine(options));
      await this.driver.setSignals(true, true);
    } catch (err) {
      try { await dev.close(); } catch {}
      throw usbExplain(err);
    }
    this._isOpen   = true;
    this._fatal    = false;
    this._readable = null;
    this._writable = null;
    this._ctl      = null;
    this._q = []; this._qBytes = 0; this._qErr = null;
    this._pump(++this._gen);
  }

  // Change line settings without closing (no DTR/RTS glitch)
  async setOptions(options) {
    if (!this._isOpen) throw new DOMException('The port is not open.', 'InvalidStateError');
    await this.driver.setLine(usbLine(options));
  }

  async close() {
    if (!this._isOpen) throw new DOMException('The port is not open.', 'InvalidStateError');
    if (this._readable?.locked || this._writable?.locked)
      throw new DOMException('Cannot close a port while its streams are locked.', 'InvalidStateError');
    this._gen++;
    this._isOpen = false;
    const ctl = this._ctl;
    this._ctl = null; this._readable = null; this._writable = null;
    this._q = []; this._qBytes = 0; this._qErr = null;
    this._signal();
    try { ctl?.close(); } catch {}
    if (!this._fatal) { try { await this.driver.close(); } catch {} }
    try { await this.device.close(); } catch {}
  }

  // Like Web Serial: after a line error the stream errors and a new one is
  // handed out; after a fatal error (unplug) this becomes null.
  get readable() {
    if (!this._isOpen) return null;
    if (this._readable) return this._readable;
    if (this._fatal) return null;
    let ctl;
    this._readable = new ReadableStream({
      start:  c => { ctl = c; this._ctl = c; },
      pull:   () => this._feed(ctl),
      cancel: () => {
        if (this._ctl === ctl) { this._ctl = null; this._readable = null; }
        this._signal();
      },
    }, { highWaterMark: 0 });
    return this._readable;
  }

  get writable() {
    if (!this._isOpen || this._fatal) return null;
    if (!this._writable) {
      const gen = this._gen;
      this._writable = new WritableStream({
        write: async chunk => {
          if (gen !== this._gen) throw new DOMException('The port is closed.', 'InvalidStateError');
          const ep   = this.driver.outEp.endpointNumber;
          const data = ArrayBuffer.isView(chunk) ? chunk : new Uint8Array(chunk);
          let r = await this.device.transferOut(ep, data);
          if (r.status === 'stall') {
            await this.device.clearHalt('out', ep);
            r = await this.device.transferOut(ep, data);
          }
          if (r.status !== 'ok') throw new DOMException(`USB write failed (${r.status})`, 'NetworkError');
        },
      });
    }
    return this._writable;
  }

  // ── internals ──

  // Hands queued data to the reader; errors the stream only once the queue
  // is empty, so nothing received before an error is lost.
  async _feed(ctl) {
    while (this._ctl === ctl && !this._q.length && !this._qErr) {
      await new Promise(r => { this._wake = r; });
    }
    if (this._ctl !== ctl) return;
    if (this._q.length) {
      const chunk = usbConcat(this._q);
      this._q = []; this._qBytes = 0;
      ctl.enqueue(chunk);
      return;
    }
    const err = this._qErr;
    this._qErr = null;
    this._ctl = null;
    this._readable = null;
    ctl.error(err);
  }

  _signal() {
    const w = this._wake;
    this._wake = null;
    w?.();
  }

  _push(bytes) {
    this._q.push(bytes);
    this._qBytes += bytes.length;
    while (this._qBytes > (1 << 20) && this._q.length > 1) this._qBytes -= this._q.shift().length;
    this._signal();
  }

  _raise(err, fatal) {
    if (fatal) { this._fatal = true; this._qErr = err; }
    else if (!this._qErr) this._qErr = err;
    this._signal();
  }

  // Keeps two bulk IN transfers queued so no data is missed between them.
  async _pump(gen) {
    const dev  = this.device;
    const ep   = this.driver.inEp;
    const size = Math.min(16384, ep.packetSize * 32);
    const submit = () => {
      const p = dev.transferIn(ep.endpointNumber, size);
      p.catch(() => {});
      return p;
    };
    const inflight = [submit(), submit()];

    while (gen === this._gen) {
      let r;
      try {
        r = await inflight.shift();
      } catch (err) {
        if (gen !== this._gen) return;  // closed by us
        this._raise(err?.name === 'NetworkError' ? err
          : new DOMException(err?.message || 'USB read failed', 'NetworkError'), true);
        return;
      }
      if (gen !== this._gen) return;

      if (r.status === 'stall') {
        try { await dev.clearHalt('in', ep.endpointNumber); } catch {}
        inflight.push(submit());
        continue;
      }
      inflight.push(submit());

      if (r.status === 'babble') {
        this._raise(new DOMException('USB babble', 'BufferOverrunError'), false);
        continue;
      }
      if (!r.data || !r.data.byteLength) continue;

      const { data, error } = this.driver.decode(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      if (data.length) this._push(data);
      if (error) this._raise(new DOMException(`${error} reported by the adapter`, error), false);
    }
  }
}
