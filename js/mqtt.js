'use strict';

class MqttManager {
  constructor() {
    this.client       = null;
    this.connected    = false;
    this._sendTopic   = ''; // we publish commands here
    this._recvTopic   = ''; // we receive responses from here
    this._statusTopic = '';
    this.onData       = null; // (Uint8Array) => void — parsed bytes for Modbus
    this.onDisplay    = null; // (string) => void   — raw ASCII text for terminal
    this.onStatus     = null; // (string) => void   — raw CSV string
    this.onConnect    = null; // () => void
    this.onDisconnect = null; // (Error|null) => void
    this.pubQos       = 0;
    this.pubRetain    = false;
  }

  connect({ url, sendTopic, recvTopic, statusTopic, username, password, qos = 0, retain = false }) {
    this.pubQos    = qos;
    this.pubRetain = retain;
    return new Promise((resolve, reject) => {
      this._sendTopic   = sendTopic;
      this._recvTopic   = recvTopic;
      this._statusTopic = statusTopic || '';

      const opts = {
        clientId:        'sda_' + Math.random().toString(36).slice(2, 9),
        reconnectPeriod: 0,
        connectTimeout:  10000,
      };
      if (username) opts.username = username;
      if (password) opts.password = password;

      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          try { client.end(true); } catch {}
          this.client = null;
          reject(err);
        } else {
          resolve();
        }
      };

      const client = mqtt.connect(url, opts);
      this.client = client;

      const connTimeout = setTimeout(() => settle(new Error('Connection timed out')), 10000);

      client.once('connect', () => {
        clearTimeout(connTimeout);
        const topics = this._statusTopic ? [this._recvTopic, this._statusTopic] : [this._recvTopic];
        client.subscribe(topics, {}, (err) => {
          if (err) { settle(new Error('Subscribe failed: ' + err.message)); return; }
          this.connected = true;
          settle(null);
          if (this.onConnect) this.onConnect();
        });
      });

      client.on('message', (topic, payload) => {
        if (_mqttTopicMatches(this._recvTopic, topic)) {
          const rawStr = payload.toString().trim();
          if (this.onDisplay) this.onDisplay(rawStr, topic);
          if (this.onData) {
            try {
              const bytes = _hexStrToBytes(rawStr);
              if (bytes.length > 0) this.onData(bytes);
            } catch { /* ignore malformed frames */ }
          }
        } else if (this._statusTopic && _mqttTopicMatches(this._statusTopic, topic)) {
          if (this.onStatus) this.onStatus(payload.toString().trim());
        }
      });

      client.on('error', (err) => {
        clearTimeout(connTimeout);
        if (!settled) { settle(err); return; }
        if (this.connected) {
          this.connected = false;
          if (this.onDisconnect) this.onDisconnect(err);
        }
      });

      client.on('close', () => {
        clearTimeout(connTimeout);
        if (!settled) { settle(new Error('Connection closed')); return; }
        if (this.connected) {
          this.connected = false;
          if (this.onDisconnect) this.onDisconnect(null);
        }
      });
    });
  }

  disconnect() {
    this.connected = false;
    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
    }
  }

  // For Modbus: converts bytes to uppercase ASCII hex string before publishing
  send(data /* Uint8Array */) {
    if (!this.client || !this.connected) throw new Error('Not connected to MQTT broker');
    const hexStr = Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    const opts = { qos: this.pubQos, retain: this.pubRetain };
    return new Promise((resolve, reject) => {
      this.client.publish(this._sendTopic, hexStr, opts, (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  // For general send: publishes raw bytes/string as-is
  sendRaw(data /* Uint8Array */) {
    if (!this.client || !this.connected) throw new Error('Not connected to MQTT broker');
    const opts = { qos: this.pubQos, retain: this.pubRetain };
    return new Promise((resolve, reject) => {
      this.client.publish(this._sendTopic, data, opts, (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  // True if the subscribe topic pattern would catch messages published to the send topic
  // (meaning the broker will echo back what we publish — no need for a manual echo)
  subMatchesPub() {
    return _mqttTopicMatches(this._recvTopic, this._sendTopic);
  }
}

function _mqttTopicMatches(pattern, topic) {
  const pp = pattern.split('/');
  const tp = topic.split('/');
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === '#') return true;
    if (i >= tp.length) return false;
    if (pp[i] !== '+' && pp[i] !== tp[i]) return false;
  }
  return pp.length === tp.length;
}

function _hexStrToBytes(str) {
  const clean = str.replace(/\s+/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0) throw new Error('Odd hex length');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (isNaN(b)) throw new Error('Invalid hex char');
    bytes[i] = b;
  }
  return bytes;
}
