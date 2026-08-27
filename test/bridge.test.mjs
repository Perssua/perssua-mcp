import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  bridgeSupports,
  getAppStatus,
  getDefaultUserDataCandidates,
  readAssistantsRoster,
  resolveBridge,
} from '../src/bridge.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perssua-bridge-test-'));

test('env override wins and is treated as found', () => {
  const dir = makeTempDir();
  const resolved = resolveBridge({ env: { PERSSUA_USER_DATA_DIR: dir }, homeDir: makeTempDir() });

  assert.equal(resolved.source, 'env-override');
  assert.equal(resolved.userDataDir, dir);
  assert.equal(resolved.handoffDir, path.join(dir, 'external-handoffs'));
  assert.equal(resolved.rosterPath, path.join(dir, 'integrations', 'assistants.json'));
});

test('bridge pointer file directs all paths', () => {
  const homeDir = makeTempDir();
  const userDataDir = makeTempDir();
  const bridgeDir = path.join(homeDir, '.perssua');
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(bridgeDir, 'bridge.json'),
    JSON.stringify({
      version: 1,
      userDataDir,
      handoffDir: path.join(userDataDir, 'external-handoffs'),
      rosterPath: path.join(userDataDir, 'integrations', 'assistants.json'),
      appVersion: '0.26.0',
      protocol: 'perssua',
      pid: process.pid,
      updatedAt: '2026-08-25T00:00:00.000Z',
    }),
  );

  const resolved = resolveBridge({ homeDir, env: {} });
  assert.equal(resolved.source, 'bridge-file');
  assert.equal(resolved.userDataDir, userDataDir);

  const status = getAppStatus({ homeDir, env: {} });
  assert.equal(status.installed, true);
  assert.equal(status.appVersion, '0.26.0');
  assert.equal(status.running, true); // our own pid is alive
});

test('capabilities are surfaced from the bridge and gate feature support', () => {
  const homeDir = makeTempDir();
  const userDataDir = makeTempDir();
  const bridgeDir = path.join(homeDir, '.perssua');
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(bridgeDir, 'bridge.json'),
    JSON.stringify({
      version: 1,
      userDataDir,
      appVersion: '0.27.0',
      pid: process.pid,
      capabilities: ['session-start', 'session-files', 'create-assistant', 42],
    }),
  );

  const status = getAppStatus({ homeDir, env: {} });
  assert.deepEqual(status.capabilities, ['session-start', 'session-files', 'create-assistant']);

  const resolved = resolveBridge({ homeDir, env: {} });
  assert.equal(bridgeSupports(resolved, 'create-assistant'), true);
  assert.equal(bridgeSupports(resolved, 'time-travel'), false);
});

test('bridges without a capabilities field advertise none', () => {
  const homeDir = makeTempDir();
  const userDataDir = makeTempDir();
  const bridgeDir = path.join(homeDir, '.perssua');
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(bridgeDir, 'bridge.json'),
    JSON.stringify({ version: 1, userDataDir, appVersion: '0.26.0', pid: process.pid }),
  );

  const status = getAppStatus({ homeDir, env: {} });
  assert.deepEqual(status.capabilities, []);
  assert.equal(bridgeSupports(resolveBridge({ homeDir, env: {} }), 'create-assistant'), false);
  assert.equal(bridgeSupports(null, 'create-assistant'), false);
});

test('falls back to platform defaults and reports not-found', () => {
  const homeDir = makeTempDir();
  const resolved = resolveBridge({ homeDir, env: {}, platform: 'darwin' });

  assert.equal(resolved.source, 'not-found');
  assert.equal(resolved.found, false);
  assert.equal(
    resolved.userDataDir,
    path.join(homeDir, 'Library', 'Application Support', 'Perssua'),
  );
});

test('default candidates cover packaged and source identities per platform', () => {
  const homeDir = '/home/u';
  assert.deepEqual(
    getDefaultUserDataCandidates({ platform: 'linux', homeDir, env: {} }),
    ['/home/u/.config/Perssua', '/home/u/.config/perssua'],
  );
  const winCandidates = getDefaultUserDataCandidates({
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
  });
  assert.equal(winCandidates.length, 2);
});

test('readAssistantsRoster parses the app snapshot and tolerates absence', () => {
  const homeDir = makeTempDir();
  const missing = readAssistantsRoster({ homeDir, env: {}, platform: 'darwin' });
  assert.equal(missing.available, false);
  assert.deepEqual(missing.assistants, []);

  const userDataDir = makeTempDir();
  fs.mkdirSync(path.join(userDataDir, 'integrations'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'integrations', 'assistants.json'),
    JSON.stringify({
      version: 1,
      assistants: [
        { id: 'user_0', name: 'Coach' },
        { id: 'remote_1', name: 'Interview Copilot' },
        null,
      ],
      selectedAssistantId: 'user_0',
      updatedAt: '2026-08-25T00:00:00.000Z',
    }),
  );

  const roster = readAssistantsRoster({ env: { PERSSUA_USER_DATA_DIR: userDataDir } });
  assert.equal(roster.available, true);
  assert.equal(roster.assistants.length, 2);
  assert.equal(roster.selectedAssistantId, 'user_0');
});
