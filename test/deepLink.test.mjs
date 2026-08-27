import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INLINE_LINK_LIMITS,
  buildHandoffDeepLink,
  buildInlineDeepLink,
  buildLauncherUrl,
  openDeepLink,
} from '../src/deepLink.js';

test('buildHandoffDeepLink references the handoff id', () => {
  assert.equal(
    buildHandoffDeepLink('hs_abc123'),
    'perssua://session/start?handoff=hs_abc123',
  );
});

test('buildInlineDeepLink encodes fields and clamps long values', () => {
  const url = buildInlineDeepLink({
    assistant: 'Coach & Mentor',
    prompt: 'p'.repeat(INLINE_LINK_LIMITS.promptChars + 50),
    context: 'ctx',
    source: 'chatgpt',
  });

  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'perssua:');
  assert.equal(parsed.hostname + parsed.pathname, 'session/start');
  assert.equal(parsed.searchParams.get('assistant'), 'Coach & Mentor');
  assert.equal(parsed.searchParams.get('prompt').length, INLINE_LINK_LIMITS.promptChars);
  assert.equal(parsed.searchParams.get('context'), 'ctx');
  assert.equal(parsed.searchParams.get('source'), 'chatgpt');
});

test('buildInlineDeepLink omits empty fields', () => {
  const parsed = new URL(buildInlineDeepLink({}));
  assert.equal(parsed.searchParams.has('assistant'), false);
  assert.equal(parsed.searchParams.has('prompt'), false);
  assert.equal(parsed.searchParams.has('context'), false);
  assert.equal(parsed.searchParams.get('source'), 'link');
});

test('buildLauncherUrl wraps the deep link in the configured launcher page', () => {
  const deepLink = 'perssua://session/start?source=link';
  assert.equal(buildLauncherUrl(deepLink, { launchBaseUrl: undefined }), null);
  assert.equal(
    buildLauncherUrl(deepLink, { launchBaseUrl: 'https://perssua.com/launch' }),
    `https://perssua.com/launch#${encodeURIComponent(deepLink)}`,
  );
});

test('openDeepLink uses the platform opener', async () => {
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push({ command, args });
    return { on: () => {}, unref: () => {} };
  };

  await openDeepLink('perssua://session/start?handoff=hs_1', {
    platform: 'darwin',
    spawnFn: fakeSpawn,
  });
  assert.deepEqual(calls[0], { command: 'open', args: ['perssua://session/start?handoff=hs_1'] });

  await openDeepLink('perssua://session/start?a=1&b=2', {
    platform: 'win32',
    spawnFn: fakeSpawn,
  });
  assert.equal(calls[1].command, 'cmd');
  assert.ok(calls[1].args[3].includes('^&'));

  await openDeepLink('perssua://session/start', {
    platform: 'linux',
    spawnFn: fakeSpawn,
  });
  assert.equal(calls[2].command, 'xdg-open');
});
