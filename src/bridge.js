/**
 * Bridge discovery between the Perssua desktop app and external MCP clients.
 *
 * The desktop app (full flavor) writes a pointer file at ~/.perssua/bridge.json
 * on startup describing where its user-data lives, where handoff payloads must
 * be dropped, and where the assistants roster snapshot is kept. This module
 * locates that bridge (or falls back to probing the platform's default
 * Electron user-data directories) so the MCP server works even before the
 * pointer file exists.
 *
 * Keep the file names and shapes in sync with electron/externalSessionHandoff.js
 * in the Perssua repository.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BRIDGE_DIR_NAME = '.perssua';
export const BRIDGE_FILE_NAME = 'bridge.json';
export const HANDOFF_DIR_NAME = 'external-handoffs';
export const INTEGRATIONS_DIR_NAME = 'integrations';
export const ROSTER_FILE_NAME = 'assistants.json';

const readJsonIfExists = (filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const getBridgeFilePath = (homeDir = os.homedir()) =>
  path.join(homeDir, BRIDGE_DIR_NAME, BRIDGE_FILE_NAME);

/**
 * Platform default Electron user-data candidates for the Perssua full flavor.
 * Packaged builds use the product name ("Perssua"); source runs on Windows and
 * Linux can fall back to the package name ("perssua"), so probe both.
 */
export const getDefaultUserDataCandidates = ({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) => {
  if (platform === 'darwin') {
    return [path.join(homeDir, 'Library', 'Application Support', 'Perssua')];
  }

  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return [path.join(appData, 'Perssua'), path.join(appData, 'perssua')];
  }

  const configRoot = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  return [path.join(configRoot, 'Perssua'), path.join(configRoot, 'perssua')];
};

const isPerssuaUserDataDir = (dir) => {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return ['settings.json', 'conversations.db', HANDOFF_DIR_NAME, INTEGRATIONS_DIR_NAME]
    .some((entry) => fs.existsSync(path.join(dir, entry)));
};

/**
 * Resolve where the Perssua app lives on this machine.
 *
 * Order: PERSSUA_USER_DATA_DIR env override → ~/.perssua/bridge.json pointer
 * (written by the app) → platform default user-data directories.
 *
 * Returns { found, source, userDataDir, handoffDir, rosterPath, bridge } where
 * `bridge` is the parsed pointer file when available and `found` reflects
 * whether an existing installation was located.
 */
export const resolveBridge = ({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) => {
  const fromDirs = (userDataDir, source, bridge = null, found = true) => ({
    found,
    source,
    userDataDir,
    handoffDir: path.join(userDataDir, HANDOFF_DIR_NAME),
    rosterPath: path.join(userDataDir, INTEGRATIONS_DIR_NAME, ROSTER_FILE_NAME),
    bridge,
  });

  const override = env.PERSSUA_USER_DATA_DIR;
  if (override && override.trim()) {
    return fromDirs(path.resolve(override.trim()), 'env-override');
  }

  const bridge = readJsonIfExists(getBridgeFilePath(homeDir));
  if (bridge && typeof bridge.userDataDir === 'string' && bridge.userDataDir) {
    const resolved = fromDirs(bridge.userDataDir, 'bridge-file', bridge);
    if (typeof bridge.handoffDir === 'string' && bridge.handoffDir) {
      resolved.handoffDir = bridge.handoffDir;
    }
    if (typeof bridge.rosterPath === 'string' && bridge.rosterPath) {
      resolved.rosterPath = bridge.rosterPath;
    }
    return resolved;
  }

  const candidates = getDefaultUserDataCandidates({ platform, homeDir, env });
  const existing = candidates.find(isPerssuaUserDataDir);
  if (existing) {
    return fromDirs(existing, 'default-probe');
  }

  // Nothing found: still return the primary candidate so callers can report
  // where the app is expected and where handoffs would be written.
  return fromDirs(candidates[0], 'not-found', null, false);
};

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error && error.code === 'EPERM';
  }
};

/**
 * Best-effort app status derived from the bridge pointer file.
 * Never throws; every field is safe to render to an LLM.
 */
export const getAppStatus = (options = {}) => {
  const resolved = resolveBridge(options);
  const bridge = resolved.bridge;

  return {
    installed: resolved.found,
    bridgeSource: resolved.source,
    userDataDir: resolved.userDataDir,
    handoffDir: resolved.handoffDir,
    appVersion: typeof bridge?.appVersion === 'string' ? bridge.appVersion : null,
    protocol: typeof bridge?.protocol === 'string' ? bridge.protocol : 'perssua',
    running: isPidAlive(bridge?.pid),
    bridgeUpdatedAt: typeof bridge?.updatedAt === 'string' ? bridge.updatedAt : null,
    capabilities: Array.isArray(bridge?.capabilities)
      ? bridge.capabilities.filter((entry) => typeof entry === 'string')
      : [],
  };
};

/**
 * Whether the installed app advertises a handoff capability. Bridges written
 * by builds that predate the capabilities field report none — callers should
 * treat missing capabilities as "app too old for this feature" and ask the
 * user to update, rather than sending payloads the intake would drop.
 */
export const bridgeSupports = (resolvedOrStatus, capability) => {
  const bridge = resolvedOrStatus?.bridge ?? resolvedOrStatus;
  const capabilities = Array.isArray(bridge?.capabilities) ? bridge.capabilities : [];
  return capabilities.includes(capability);
};

/**
 * Read the assistants roster snapshot the app keeps for external integrations.
 * Returns { available, assistants, selectedAssistantId, updatedAt }.
 */
export const readAssistantsRoster = (options = {}) => {
  const resolved = resolveBridge(options);
  const roster = readJsonIfExists(resolved.rosterPath);

  if (!roster || !Array.isArray(roster.assistants)) {
    return {
      available: false,
      assistants: [],
      selectedAssistantId: null,
      updatedAt: null,
      rosterPath: resolved.rosterPath,
    };
  }

  const assistants = roster.assistants
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : String(entry.id || ''),
      name: typeof entry.name === 'string' ? entry.name : '',
    }))
    .filter((entry) => entry.id || entry.name);

  return {
    available: true,
    assistants,
    selectedAssistantId:
      typeof roster.selectedAssistantId === 'string' ? roster.selectedAssistantId : null,
    updatedAt: typeof roster.updatedAt === 'string' ? roster.updatedAt : null,
    rosterPath: resolved.rosterPath,
  };
};
