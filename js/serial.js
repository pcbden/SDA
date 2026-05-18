'use strict';

class SerialManager {
  constructor() {
    this.port     = null;
    this.reader   = null;
    this.writer   = null;
    this.connected = false;
    this._reading  = false;

    this.onData       = null; // (Uint8Array) => void
    this.onDisconnect = null; // (Error|null) => void
  }

  static isSupported() {
    return 'serial' in navigator;
  }

  async connect(options, port = null) {
    this.port = port ?? await navigator.serial.requestPort();
    await this.port.open({
      baudRate:   options.baudRate,
      dataBits:   options.dataBits,
      parity:     options.parity,
      stopBits:   options.stopBits,
      bufferSize: 65536,
    });
    this.writer    = this.port.writable.getWriter();
    this.connected = true;
    this._readLoop();
    return this._portLabel();
  }

  async disconnect() {
    this._reading = false;
    try { await this.reader?.cancel(); }   catch {}
    try { this.reader?.releaseLock(); }    catch {}
    try { this.writer?.releaseLock(); }    catch {}
    try { await this.port?.close(); }      catch {}
    this.reader    = null;
    this.writer    = null;
    this.port      = null;
    this.connected = false;
  }

  async send(data /* Uint8Array */) {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(data);
  }

  _portLabel() {
    try {
      const info = this.port.getInfo();
      if (info.usbVendorId !== undefined) {
        const vid = info.usbVendorId.toString(16).toUpperCase().padStart(4, '0');
        const pid = info.usbProductId.toString(16).toUpperCase().padStart(4, '0');
        return `USB VID:${vid} PID:${pid}`;
      }
    } catch {}
    return 'Serial Port';
  }

  async _readLoop() {
    this._reading = true;
    while (this.connected && this._reading && this.port?.readable) {
      try {
        this.reader = this.port.readable.getReader();
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length && this.onData) this.onData(value);
        }
      } catch (err) {
        if (this._reading) {
          // Unexpected disconnect
          this.connected = false;
          try { this.reader?.releaseLock(); } catch {}
          this.reader = null;
          if (this.onDisconnect) this.onDisconnect(err);
          return;
        }
      } finally {
        try { this.reader?.releaseLock(); } catch {}
        this.reader = null;
      }
    }
  }
}
