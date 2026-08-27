/**
 * perssua:// deep-link construction and launching.
 *
 * Two link shapes are supported by the desktop app:
 *  - perssua://session/start?handoff=<id>          (payload in the handoff dir)
 *  - perssua://session/start?assistant=&prompt=&context=&source=  (inline)
 *
 * Inline links are meant for remote surfaces (ChatGPT / Grok connectors, web
 * chats) that cannot write files on the user's machine. The desktop app never
 * auto-submits inline links — the user reviews the prefilled prompt first.
 */

import { spawn } from 'node:child_process';

export const DEFAULT_PROTOCOL = 'perssua';

// Keep inline links comfortably under common URL-length limits.
export const INLINE_LINK_LIMITS = {
  promptChars: 4000,
  contextChars: 8000,
  assistantRefChars: 200,
  sourceChars: 32,
};

const clamp = (value, maxChars) => String(value ?? '').slice(0, maxChars);

export const buildHandoffDeepLink = (handoffId, { protocol = DEFAULT_PROTOCOL } = {}) =>
  `${protocol}://session/start?handoff=${encodeURIComponent(handoffId)}`;

export const buildInlineDeepLink = ({
  assistant = '',
  prompt = '',
  context = '',
  source = 'link',
  protocol = DEFAULT_PROTOCOL,
  limits = INLINE_LINK_LIMITS,
} = {}) => {
  const params = new URLSearchParams();
  if (assistant && String(assistant).trim()) {
    params.set('assistant', clamp(String(assistant).trim(), limits.assistantRefChars));
  }
  if (prompt && String(prompt).trim()) {
    params.set('prompt', clamp(prompt, limits.promptChars));
  }
  if (context && String(context).trim()) {
    params.set('context', clamp(context, limits.contextChars));
  }
  params.set('source', clamp(source, limits.sourceChars) || 'link');
  return `${protocol}://session/start?${params.toString()}`;
};

/**
 * Wrap a deep link in the hosted launcher page when one is configured
 * (chat UIs reliably linkify https:// but often not custom schemes).
 * The payload travels in the URL fragment so it never reaches server logs.
 */
export const buildLauncherUrl = (deepLink, { launchBaseUrl = process.env.PERSSUA_LAUNCH_URL } = {}) => {
  if (!launchBaseUrl || !String(launchBaseUrl).trim()) return null;
  const base = String(launchBaseUrl).trim().replace(/[#?]+$/, '');
  return `${base}#${encodeURIComponent(deepLink)}`;
};

/**
 * Open a deep link with the OS default handler (launches Perssua).
 * Resolves true when the opener process starts; rejects on spawn failure.
 */
export const openDeepLink = (url, { platform = process.platform, spawnFn = spawn } = {}) =>
  new Promise((resolve, reject) => {
    let command;
    let args;

    if (platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (platform === 'win32') {
      // `start` is a cmd builtin; the empty string is the window title slot.
      command = 'cmd';
      args = ['/c', 'start', '', url.replace(/&/g, '^&')];
    } else {
      command = 'xdg-open';
      args = [url];
    }

    try {
      const child = spawnFn(command, args, {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: platform === 'win32',
      });
      child.on('error', reject);
      child.unref();
      // Give spawn a tick to surface ENOENT before resolving.
      setTimeout(() => resolve(true), 150);
    } catch (error) {
      reject(error);
    }
  });
