'use strict';

// Errors the Web Serial spec defines as non-fatal: the current readable stream
// errors out, but the port stays open and `port.readable` hands out a fresh
// stream. These are what you get when the line settings don't match the device
// (e.g. port at 9600, device talking at 115200 → framing/break errors).
const SERIAL_NON_FATAL = new Set(['BreakError', 'FramingError', 'ParityError', 'BufferOverrunError']);

class SerialManager {
  constructor() {
    this.port      = null;
    this.reader    = null;
    this.writer    = null;
    this.connected = false;
    this.options   = null;   // line settings the port is currently open with

    this._closing  = false;  // true while *we* are closing/reconfiguring the port
    this._loopDone = null;   // promise that settles when the read loop exits
    this._reconf   = null;   // pending reconfigure chain (send() waits on it)
    this._errTimes = [];     // timestamps of recent line errors (storm throttling)

    this.onData       = null; // (Uint8Array) => void
    this.onDisconnect = null; // (Error|null) => void
    this.onLineError  = null; // (DOMException) => void — non-fatal, port stays open
  }

  static isSupported() {
    return 'serial' in navigator;
  }

  async connect(options, port = null) {
    port = port ?? await navigator.serial.requestPort();
    if (this.port && this.port !== port) await this.disconnect();
    this.port = port;
    try {
      await this._open(options);
    } catch (err) {
      await this._teardown();
      this.port = null;
      throw err;
    }
    return this._portLabel();
  }

  async disconnect() {
    await this._teardown();
    this.port    = null;
    this.options = null;
  }

  // Change line settings on an open port. Web Serial can't do this in place,
  // so the same port is closed and reopened; the app stays "connected".
  reconfigure(options) {
    const run = async () => {
      if (!this.port || !this.connected) throw new Error('Not connected');
      const prev = this.options;
      await this._close();
      try {
        await this._open(options);
      } catch (err) {
        // New settings rejected (e.g. unsupported baud) — try to restore the old ones.
        try { await this._open(prev); } catch {
          await this._teardown();
          this.port = null;
          this.onDisconnect?.(err);
        }
        throw err;
      }
    };
    const p = (this._reconf ?? Promise.resolve()).catch(() => {}).then(run);
    this._reconf = p;
    p.finally(() => { if (this._reconf === p) this._reconf = null; }).catch(() => {});
    return p;
  }

  async send(data /* Uint8Array */) {
    if (this._reconf) { try { await this._reconf; } catch {} }
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(data);
  }

  // ── internals ───────────────────────────────────────

  async _open(options) {
    const opts = {
      baudRate:    options.baudRate,
      dataBits:    options.dataBits,
      parity:      options.parity,
      stopBits:    options.stopBits,
      flowControl: 'none',
      bufferSize:  65536,
    };
    try {
      await this.port.open(opts);
    } catch (err) {
      // "Port is already open": left over from an earlier session in this tab.
      // Close it and try once more instead of making the user replug the adapter.
      if (err.name !== 'InvalidStateError') throw err;
      try { await this.port.close(); } catch {}
      await this.port.open(opts);
    }
    this.options   = { ...options };
    this.writer    = this.port.writable.getWriter();
    this.connected = true;
    this._closing  = false;
    this._errTimes = [];
    this._loopDone = this._readLoop();
  }

  // Close the port but keep `this.port`, so it can be reopened (reconfigure).
  async _close() {
    this._closing = true;
    try { await this.reader?.cancel(); } catch {}
    try { await this._loopDone; }        catch {}
    this._loopDone = null;
    this.reader    = null;
    try { this.writer?.releaseLock(); }  catch {}
    this.writer = null;
    try { await this.port?.close(); }    catch {}
  }

  // Full teardown. Must always release both stream locks and close the port —
  // otherwise the browser keeps the port open and the next open() fails until
  // the adapter is replugged.
  async _teardown() {
    this.connected = false;
    await this._close();
  }

  _portLabel() {
    try {
      const info = this.port.getInfo();
      if (info.usbVendorId !== undefined) {
        const vid = info.usbVendorId.toString(16).toUpperCase().padStart(4, '0');
        const pid = info.usbProductId.toString(16).toUpperCase().padStart(4, '0');
        return `USB VID:${vid} PID:${pid}`;
      }
      if (info.bluetoothServiceClassId !== undefined) return 'Bluetooth Serial';
    } catch {}
    return 'Serial Port';
  }

  async _readLoop() {
    let fatal = null;

    while (!this._closing && this.port?.readable) {
      let reader;
      try { reader = this.port.readable.getReader(); }
      catch (err) { fatal = err; break; }
      this.reader = reader;

      let ended = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { ended = true; break; }
          if (value?.length && this.onData) this.onData(value);
        }
      } catch (err) {
        if (!this._closing) {
          if (SERIAL_NON_FATAL.has(err.name)) {
            // Garbage on the line (wrong baud/parity) — report it and keep reading.
            this.onLineError?.(err);
            await this._throttleErrors();
          } else {
            fatal = err; // NetworkError (device lost), UnknownError, …
            ended = true;
          }
        }
      } finally {
        try { reader.releaseLock(); } catch {}
        if (this.reader === reader) this.reader = null;
      }
      if (ended) break;
    }

    if (this._closing) return; // we asked for it: disconnect() or reconfigure()

    // The port went away on its own (unplugged, driver error). Release
    // everything so it can be opened again without replugging.
    this._loopDone = null;
    await this._teardown();
    this.port = null;
    this.onDisconnect?.(fatal);
  }

  // A device spewing data at the wrong baud can produce hundreds of line
  // errors per second; each one tears down and recreates the read stream.
  // Back off a little during a storm so the UI stays responsive.
  async _throttleErrors() {
    const now = performance.now();
    this._errTimes.push(now);
    while (this._errTimes.length && now - this._errTimes[0] > 1000) this._errTimes.shift();
    if (this._errTimes.length > 50) await new Promise(r => setTimeout(r, 20));
  }
}
