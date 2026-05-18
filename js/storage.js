'use strict';

const Storage = (() => {
  const KEYS = { cmds: 'sda_commands', settings: 'sda_settings' };

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  return {
    getCommands:  ()    => load(KEYS.cmds, []),
    saveCommands: (v)   => save(KEYS.cmds, v),
    getSettings:  ()    => load(KEYS.settings, {}),
    saveSettings: (v)   => save(KEYS.settings, v),
  };
})();
