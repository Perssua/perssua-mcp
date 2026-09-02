import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  HANDOFF_ID_PATTERN,
  HANDOFF_LIMITS,
  buildHandoffPayload,
  buildLegacyPromptProjection,
  inlineFile,
  writeHandoffFile,
} from '../src/handoffPayload.js';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perssua-mcp-test-'));

// Frozen v1 desktop projection: native extension keys must never be required
// to create the basic assistant.
const parseFrozenLegacyNewAssistant = (payload) => {
  if (payload?.version !== 1 || !payload.newAssistant?.name || !payload.newAssistant?.instructions) {
    return null;
  }
  return {
    name: payload.newAssistant.name,
    instructions: payload.newAssistant.instructions,
    ...(payload.newAssistant.category ? { category: payload.newAssistant.category } : {}),
  };
};

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

test('buildHandoffPayload keeps assistant-wide behavior separate from a top-level session goal', () => {
  const { payload } = buildHandoffPayload({
    newAssistant: {
      name: 'Meeting guide',
      instructions: 'Be concise.',
      realtimePrompt: 'Write only the next sentence ME can say.',
      followUpPrompt: 'Offer three questions.',
      emailPrompt: 'Summarize owners and decisions.',
      requireCertainty: true,
    },
    context: 'Permanent product vocabulary',
    sessionGoal: 'Plan the pricing review.',
  });

  assert.deepEqual(payload.newAssistant, {
    name: 'Meeting guide',
    instructions: 'Be concise.',
    realtimePrompt: 'Write only the next sentence ME can say.',
    followUpPrompt: 'Offer three questions.',
    emailPrompt: 'Summarize owners and decisions.',
    requireCertainty: true,
  });
  assert.equal(payload.context, 'Permanent product vocabulary');
  assert.equal(payload.sessionGoal, 'Plan the pricing review.');
  assert.equal(payload.version, 1);
  assert.deepEqual(parseFrozenLegacyNewAssistant(payload), {
    name: 'Meeting guide',
    instructions: 'Be concise.',
  });
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

test('buildHandoffPayload warns when native assistant prompts are truncated', () => {
  const { payload, warnings } = buildHandoffPayload({
    newAssistant: {
      name: 'Coach',
      instructions: 'Be concise.',
      realtimePrompt: 'r'.repeat(HANDOFF_LIMITS.assistantRealtimePromptChars + 1),
      followUpPrompt: 'f'.repeat(HANDOFF_LIMITS.assistantFollowUpPromptChars + 1),
      emailPrompt: 'e'.repeat(HANDOFF_LIMITS.assistantEmailPromptChars + 1),
    },
  });

  assert.equal(payload.newAssistant.realtimePrompt.length, HANDOFF_LIMITS.assistantRealtimePromptChars);
  assert.equal(payload.newAssistant.followUpPrompt.length, HANDOFF_LIMITS.assistantFollowUpPromptChars);
  assert.equal(payload.newAssistant.emailPrompt.length, HANDOFF_LIMITS.assistantEmailPromptChars);
  assert.ok(warnings.some((warning) => warning.includes('realtime prompt truncated')));
  assert.ok(warnings.some((warning) => warning.includes('follow-up prompt truncated')));
  assert.ok(warnings.some((warning) => warning.includes('email prompt truncated')));
});

test('legacy prompt projection preserves the complete first prompt before the session goal', () => {
  const firstPrompt = 'p'.repeat(HANDOFF_LIMITS.promptChars);
  const sessionGoal = 'g'.repeat(HANDOFF_LIMITS.sessionGoalChars);

  assert.equal(
    buildLegacyPromptProjection(firstPrompt, sessionGoal, HANDOFF_LIMITS.promptChars),
    firstPrompt,
  );

  const shortPrompt = 'Start with the highest-risk assumption.';
  const projection = buildLegacyPromptProjection(
    shortPrompt,
    'Compare two research directions.',
    HANDOFF_LIMITS.promptChars,
  );
  assert.match(projection, /^Session goal: Compare two research directions\./);
  assert.ok(projection.endsWith(shortPrompt));
});

test('buildHandoffPayload ignores new-assistant specs missing name or instructions', () => {
  const { payload, warnings } = buildHandoffPayload({
    newAssistant: { name: 'Coach', instructions: '   ' },
    prompt: 'hi',
  });

  assert.equal(payload.newAssistant, undefined);
  assert.ok(warnings.some((warning) => warning.includes('newAssistant ignored')));
});
