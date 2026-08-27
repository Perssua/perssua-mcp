import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  HANDOFF_ID_PATTERN,
  HANDOFF_LIMITS,
  buildHandoffPayload,
  inlineFile,
  writeHandoffFile,
} from '../src/handoffPayload.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perssua-mcp-test-'));

test('buildHandoffPayload produces a valid, capped payload', () => {
  const { payload, warnings } = buildHandoffPayload({
    assistant: '  Coach  ',
    prompt: 'Hello',
    context: 'Background',
    autoSubmit: true,
    source: 'claude',
    now: () => new Date('2026-08-25T12:00:00Z'),
  });

  assert.equal(payload.version, 1);
  assert.match(payload.id, HANDOFF_ID_PATTERN);
  assert.equal(payload.assistant, 'Coach');
  assert.equal(payload.prompt, 'Hello');
  assert.equal(payload.context, 'Background');
  assert.equal(payload.autoSubmit, true);
  assert.equal(payload.source, 'claude');
  assert.equal(payload.createdAt, '2026-08-25T12:00:00.000Z');
  assert.deepEqual(warnings, []);
});

test('buildHandoffPayload truncates oversized prompt and context with warnings', () => {
  const { payload, warnings } = buildHandoffPayload({
    prompt: 'p'.repeat(HANDOFF_LIMITS.promptChars + 10),
    context: 'c'.repeat(HANDOFF_LIMITS.contextChars + 10),
  });

  assert.equal(payload.prompt.length, HANDOFF_LIMITS.promptChars);
  assert.equal(payload.context.length, HANDOFF_LIMITS.contextChars);
  assert.equal(warnings.length, 2);
});

test('buildHandoffPayload accepts inline file objects and caps file count', () => {
  const files = Array.from({ length: HANDOFF_LIMITS.maxFiles + 5 }, (_, index) => ({
    name: `file-${index}.txt`,
    content: `content ${index}`,
  }));

  const { payload, warnings } = buildHandoffPayload({ files });

  assert.equal(payload.files.length, HANDOFF_LIMITS.maxFiles);
  assert.ok(warnings.some((warning) => warning.includes('first 20 files')));
});

test('buildHandoffPayload omits empty fields and defaults autoSubmit to false', () => {
  const { payload } = buildHandoffPayload({});
  assert.equal(payload.autoSubmit, false);
  assert.equal('prompt' in payload, false);
  assert.equal('context' in payload, false);
  assert.equal('files' in payload, false);
  assert.equal('assistant' in payload, false);
});

test('buildHandoffPayload drops the largest file to satisfy the total-size cap', () => {
  const limits = { ...HANDOFF_LIMITS, totalJsonBytes: 600, fileContentChars: 500 };
  const { payload, warnings } = buildHandoffPayload({
    files: [
      { name: 'small.txt', content: 'tiny' },
      { name: 'big.txt', content: 'x'.repeat(450) },
    ],
    limits,
  });

  assert.deepEqual(payload.files.map((file) => file.name), ['small.txt']);
  assert.ok(warnings.some((warning) => warning.includes('big.txt')));
});

test('inlineFile reads text files and rejects binary files', () => {
  const dir = makeTempDir();
  const textPath = path.join(dir, 'notes.md');
  fs.writeFileSync(textPath, '# Notes\nhello');
  const binaryPath = path.join(dir, 'blob.bin');
  fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]));

  const textResult = inlineFile(textPath);
  assert.equal(textResult.file.name, 'notes.md');
  assert.equal(textResult.file.content, '# Notes\nhello');
  assert.equal(textResult.file.truncated, false);

  const binaryResult = inlineFile(binaryPath);
  assert.equal(binaryResult.file, undefined);
  assert.match(binaryResult.error, /binary/);

  const missingResult = inlineFile(path.join(dir, 'missing.txt'));
  assert.ok(missingResult.error);
});

test('writeHandoffFile writes into the handoff dir and rejects bad ids', () => {
  const dir = path.join(makeTempDir(), 'external-handoffs');
  const { payload } = buildHandoffPayload({ prompt: 'hi' });

  const filePath = writeHandoffFile(dir, payload);
  assert.equal(path.dirname(filePath), dir);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(parsed.prompt, 'hi');

  assert.throws(() => writeHandoffFile(dir, { ...payload, id: '../evil' }));
  assert.throws(() => writeHandoffFile(dir, { ...payload, id: 'a' }));
});

test('buildHandoffPayload carries a new-assistant spec and drops the assistant ref', () => {
  const { payload, warnings } = buildHandoffPayload({
    assistant: 'Coach',
    newAssistant: { name: '  Interview Coach  ', instructions: 'Be sharp.', category: 'Career' },
    prompt: 'hi',
    source: 'claude',
  });

  assert.deepEqual(payload.newAssistant, {
    name: 'Interview Coach',
    instructions: 'Be sharp.',
    category: 'Career',
  });
  assert.equal(payload.assistant, undefined);
  assert.deepEqual(warnings, []);
});

test('buildHandoffPayload truncates oversized new-assistant fields with warnings', () => {
  const { payload, warnings } = buildHandoffPayload({
    newAssistant: {
      name: 'n'.repeat(HANDOFF_LIMITS.assistantNameChars + 5),
      instructions: 'i'.repeat(HANDOFF_LIMITS.assistantInstructionsChars + 5),
    },
  });

  assert.equal(payload.newAssistant.name.length, HANDOFF_LIMITS.assistantNameChars);
  assert.equal(payload.newAssistant.instructions.length, HANDOFF_LIMITS.assistantInstructionsChars);
  assert.ok(warnings.some((warning) => warning.includes('assistant name truncated')));
  assert.ok(warnings.some((warning) => warning.includes('instructions truncated')));
});

test('buildHandoffPayload ignores new-assistant specs missing name or instructions', () => {
  const { payload, warnings } = buildHandoffPayload({
    newAssistant: { name: 'Coach', instructions: '   ' },
    prompt: 'hi',
  });

  assert.equal(payload.newAssistant, undefined);
  assert.ok(warnings.some((warning) => warning.includes('newAssistant ignored')));
});
