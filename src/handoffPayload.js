/**
 * Handoff payload construction for external session starts.
 *
 * A handoff is a single-use JSON file dropped into the app's
 * external-handoffs directory, referenced from a perssua://session/start
 * deep link by id. The desktop app validates and deletes it after reading.
 *
 * Keep caps and shape in sync with electron/externalSessionHandoff.js and
 * src/utils/externalSessionHandoff.js in the Perssua repository.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HANDOFF_VERSION = 1;
export const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export const HANDOFF_LIMITS = {
  promptChars: 16000,
  contextChars: 128000,
  assistantRefChars: 200,
  assistantNameChars: 200,
  assistantInstructionsChars: 32000,
  assistantCategoryChars: 64,
  sourceChars: 32,
  fileNameChars: 200,
  fileContentChars: 256000,
  maxFiles: 20,
  totalJsonBytes: 2 * 1024 * 1024,
};

const truncateString = (value, maxChars) => {
  const str = String(value ?? '');
  if (str.length <= maxChars) return { value: str, truncated: false };
  return { value: str.slice(0, maxChars), truncated: true };
};

const looksBinary = (buffer) => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
};

export const generateHandoffId = () =>
  `hs_${crypto.randomBytes(16).toString('hex')}`;

/**
 * Read a local file into an inlined handoff file entry.
 * Returns { file } on success or { error } describing why it was skipped.
 */
export const inlineFile = (filePath, limits = HANDOFF_LIMITS) => {
  const name = path.basename(String(filePath || ''));
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return { error: `${name}: not a regular file` };
    }

    const buffer = fs.readFileSync(filePath);
    if (looksBinary(buffer)) {
      return {
        error: `${name}: looks like a binary file — only text files can be attached as context in this version`,
      };
    }

    const { value, truncated } = truncateString(
      buffer.toString('utf8'),
      limits.fileContentChars,
    );

    return {
      file: {
        name: truncateString(name, limits.fileNameChars).value,
        content: value,
        truncated,
      },
    };
  } catch (error) {
    return { error: `${name}: ${error.message}` };
  }
};

/**
 * Build a validated handoff payload from tool arguments.
 * `files` entries may be local paths (read + inlined here) or already-inlined
 * { name, content } objects.
 *
 * Returns { payload, warnings }.
 */
export const buildHandoffPayload = ({
  assistant = null,
  newAssistant = null,
  prompt = '',
  context = '',
  files = [],
  autoSubmit = false,
  source = 'mcp',
  now = () => new Date(),
  limits = HANDOFF_LIMITS,
} = {}) => {
  const warnings = [];

  const payload = {
    version: HANDOFF_VERSION,
    id: generateHandoffId(),
    source: truncateString(source, limits.sourceChars).value || 'mcp',
    createdAt: now().toISOString(),
    autoSubmit: autoSubmit === true,
  };

  if (newAssistant && typeof newAssistant === 'object') {
    const name = truncateString(String(newAssistant.name || '').trim(), limits.assistantNameChars);
    const instructions = truncateString(
      String(newAssistant.instructions || ''),
      limits.assistantInstructionsChars,
    );
    if (name.value && instructions.value.trim()) {
      const category = truncateString(
        String(newAssistant.category || '').trim(),
        limits.assistantCategoryChars,
      );
      payload.newAssistant = {
        name: name.value,
        instructions: instructions.value,
        ...(category.value ? { category: category.value } : {}),
      };
      if (name.truncated) warnings.push('assistant name truncated');
      if (instructions.truncated) {
        warnings.push(`assistant instructions truncated to ${limits.assistantInstructionsChars} characters`);
      }
      if (category.truncated) warnings.push('assistant category truncated');
    } else {
      warnings.push('newAssistant ignored — it needs both a name and instructions');
    }
  }

  if (!payload.newAssistant && assistant && String(assistant).trim()) {
    const { value, truncated } = truncateString(
      String(assistant).trim(),
      limits.assistantRefChars,
    );
    payload.assistant = value;
    if (truncated) warnings.push('assistant reference truncated');
  }

  if (prompt && String(prompt).trim()) {
    const { value, truncated } = truncateString(String(prompt), limits.promptChars);
    payload.prompt = value;
    if (truncated) warnings.push(`prompt truncated to ${limits.promptChars} characters`);
  }

  if (context && String(context).trim()) {
    const { value, truncated } = truncateString(String(context), limits.contextChars);
    payload.context = value;
    if (truncated) warnings.push(`context truncated to ${limits.contextChars} characters`);
  }

  const inlined = [];
  const fileList = Array.isArray(files) ? files : [];
  for (const entry of fileList) {
    if (inlined.length >= limits.maxFiles) {
      warnings.push(`only the first ${limits.maxFiles} files were attached`);
      break;
    }

    if (entry && typeof entry === 'object' && typeof entry.content === 'string') {
      const name = truncateString(entry.name || `file-${inlined.length + 1}`, limits.fileNameChars);
      const content = truncateString(entry.content, limits.fileContentChars);
      inlined.push({ name: name.value, content: content.value, truncated: content.truncated });
      if (content.truncated) warnings.push(`${name.value}: content truncated`);
      continue;
    }

    if (typeof entry === 'string' && entry.trim()) {
      const result = inlineFile(entry.trim(), limits);
      if (result.file) {
        inlined.push(result.file);
        if (result.file.truncated) warnings.push(`${result.file.name}: content truncated`);
      } else {
        warnings.push(result.error);
      }
    }
  }
  if (inlined.length > 0) {
    payload.files = inlined;
  }

  // Enforce the total-size cap by dropping the largest files until it fits.
  let serialized = JSON.stringify(payload);
  while (
    Buffer.byteLength(serialized, 'utf8') > limits.totalJsonBytes &&
    Array.isArray(payload.files) &&
    payload.files.length > 0
  ) {
    let largestIndex = 0;
    payload.files.forEach((file, index) => {
      if (file.content.length > payload.files[largestIndex].content.length) {
        largestIndex = index;
      }
    });
    const [dropped] = payload.files.splice(largestIndex, 1);
    warnings.push(`${dropped.name}: dropped to keep the handoff under the size limit`);
    if (payload.files.length === 0) delete payload.files;
    serialized = JSON.stringify(payload);
  }

  if (Buffer.byteLength(serialized, 'utf8') > limits.totalJsonBytes) {
    const { value } = truncateString(payload.context || '', Math.floor(limits.contextChars / 4));
    if (payload.context && payload.context !== value) {
      payload.context = value;
      warnings.push('context further truncated to keep the handoff under the size limit');
    }
  }

  return { payload, warnings };
};

/**
 * Write a handoff payload into the app's handoff directory.
 * Creates the directory if needed. Returns the absolute file path.
 */
export const writeHandoffFile = (handoffDir, payload) => {
  if (!HANDOFF_ID_PATTERN.test(payload?.id || '')) {
    throw new Error('Invalid handoff id');
  }
  fs.mkdirSync(handoffDir, { recursive: true });
  const filePath = path.join(handoffDir, `${payload.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  return filePath;
};
