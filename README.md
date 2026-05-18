# Serial Debug Assistant

A browser-based serial port and MQTT debug tool. Send/receive raw data, poll Modbus registers, and simulate a Modbus slave — no installation required.

## Features

- **Serial & MQTT** — connects via Web Serial API or MQTT over WebSocket
- **Modbus master** — RTU and ASCII, automatic CRC/LRC, configurable type/size/byte-order
- **Modbus slave (MS)** — simulates a slave device that responds to polls with user-defined register values
- **Graph** — live plot of Modbus values in a separate tab with pan/zoom and CSV export
- **Extension commands** — save, import/export, and poll a list of commands
- **Logging** — stream received data to a local file in real time

## Requirements

- Google Chrome or Microsoft Edge 89+
- Served from `http://localhost`, `http://127.0.0.1`, or any `https://` origin (`file://` does not work)

## Quick Start

```bash
git clone https://github.com/yourname/serialDebugAsistant
cd serialDebugAsistant
python3 -m http.server 8080
# open http://localhost:8080
```

> **Linux:** make sure your user is in the `dialout` group (`sudo usermod -aG dialout $USER`). Use the official Chrome `.deb` — snap-packaged Chromium sandboxes the Serial API.

## Usage

Click the **?** button in the top bar to open the built-in help page, which explains every control in detail.

## Tech

Vanilla HTML/CSS/JS — no build step, no framework. Uses [MQTT.js](https://github.com/mqttjs/MQTT.js) from CDN for MQTT over WebSocket.
