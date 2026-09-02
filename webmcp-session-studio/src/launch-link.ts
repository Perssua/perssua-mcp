export const PERSSUA_SESSION_PARAM_LIMITS = {
  mode: 16,
  assistantName: 200,
  assistantInstructions: 4_000,
  assistantCategory: 64,
  assistantRealtimePrompt: 4_000,
  assistantFollowUpPrompt: 4_000,
  assistantEmailPrompt: 4_000,
  assistantRequireCertainty: 5,
  sessionGoal: 2_000,
  prompt: 4_000,
  context: 8_000,
  source: 8_000,
} as const;

export const LEGACY_CREATE_PARAMS = [
  "mode",
  "assistantName",
  "assistantInstructions",
  "assistantCategory",
  "prompt",
  "context",
  "source",
] as const;

/**
 * These keys extend the v1 create proposal. Legacy Electron builds ignore
 * them, while every link still contains the complete v1 projection above.
 */
export const CREATE_EXTENSION_PARAMS = [
  "assistantRealtimePrompt",
  "assistantFollowUpPrompt",
  "assistantEmailPrompt",
  "assistantRequireCertainty",
  "sessionGoal",
] as const;

const ALLOWED_PARAMS = [
  ...LEGACY_CREATE_PARAMS,
  ...CREATE_EXTENSION_PARAMS,
] as const;

export type PerssuaSessionParam = (typeof ALLOWED_PARAMS)[number];
export type PerssuaSessionDeepLinkInput = Partial<
  Record<PerssuaSessionParam, string | null | undefined>
>;

export type LaunchLinkResult =
  | { ok: true; deepLink: string }
  | { ok: false; error: string };

export const PERSSUA_SESSION_URL_MAX_CHARACTERS = 24_000;

export type StrictLaunchLinkResult =
  | { ok: true; deepLink: string; encodedLength: number }
  | {
      ok: false;
      code: "invalid_parameter" | "field_too_long" | "url_too_long";
      error: string;
      field?: PerssuaSessionParam;
      encodedLength?: number;
    };

/**
 * Serializer for the Studio's one create-proposal contract. The Studio uses
 * the strict serializer below for human-reviewed handoffs.
 */
export function buildPerssuaSessionDeepLink(
  input: PerssuaSessionDeepLinkInput,
): string {
  const params = new URLSearchParams();

  for (const key of ALLOWED_PARAMS) {
    const value = input[key];
    if (!value) continue;
    params.set(key, value.slice(0, PERSSUA_SESSION_PARAM_LIMITS[key]));
  }

  const query = params.toString();
  return `perssua://session/start${query ? `?${query}` : ""}`;
}

/**
 * Strict serializer for human-reviewed handoffs. It rejects over-limit or
 * invalid proposals instead of silently truncating them.
 */
export function buildPerssuaSessionDeepLinkStrict(
  input: PerssuaSessionDeepLinkInput,
  maxCharacters = PERSSUA_SESSION_URL_MAX_CHARACTERS,
): StrictLaunchLinkResult {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_PARAMS.includes(key as PerssuaSessionParam)) {
      return {
        ok: false,
        code: "invalid_parameter",
        error: `Unsupported session parameter: ${key}.`,
      };
    }
  }

  for (const key of ALLOWED_PARAMS) {
    const value = input[key];
    if (value == null || value === "") continue;
    if (typeof value !== "string") {
      return {
        ok: false,
        code: "invalid_parameter",
        field: key,
        error: `${key} must be a string.`,
      };
    }
    if (value.length > PERSSUA_SESSION_PARAM_LIMITS[key]) {
      return {
        ok: false,
        code: "field_too_long",
        field: key,
        error: `${key} exceeds its ${PERSSUA_SESSION_PARAM_LIMITS[key].toLocaleString()} character limit.`,
      };
    }
    if (
      key === "assistantRequireCertainty" &&
      value !== "true" &&
      value !== "false" &&
      value !== "1" &&
      value !== "0"
    ) {
      return {
        ok: false,
        code: "invalid_parameter",
        field: key,
        error: "assistantRequireCertainty must be true, false, 1, or 0.",
      };
    }
  }

  if (input.mode != null && input.mode !== "create") {
    return {
      ok: false,
      code: "invalid_parameter",
      field: "mode",
      error: "mode must be create when provided.",
    };
  }

  if (!input.assistantName?.trim() || !input.assistantInstructions?.trim()) {
    return {
      ok: false,
      code: "invalid_parameter",
      error:
        "A create proposal requires a non-empty assistantName and assistantInstructions.",
    };
  }

  const deepLink = buildPerssuaSessionDeepLink(input);
  const encodedLength = deepLink.length;
  if (encodedLength > maxCharacters) {
    return {
      ok: false,
      code: "url_too_long",
      error: `The encoded session URL is ${encodedLength.toLocaleString()} characters; reduce the assistant instructions or knowledge notes to stay within ${maxCharacters.toLocaleString()}.`,
      encodedLength,
    };
  }

  return { ok: true, deepLink, encodedLength };
}

/**
 * Rebuild an inline deep link from a fragment payload. The fragment keeps the
 * payload out of HTTP requests, and this parser drops every unknown parameter.
 */
export function buildLaunchDeepLink(rawFragment: string): LaunchLinkResult {
  const raw = rawFragment.startsWith("#") ? rawFragment.slice(1) : rawFragment;
  if (!raw) {
    return { ok: false, error: "This link is missing its session payload." };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, error: "This link is malformed." };
  }

  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return { ok: false, error: "This link is malformed." };
  }

  const route = (url.hostname + url.pathname)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (url.protocol !== "perssua:" || route !== "session/start") {
    return {
      ok: false,
      error: "This link does not point to a Perssua session.",
    };
  }

  const params: PerssuaSessionDeepLinkInput = {};
  if (url.searchParams.get("mode") !== "create") {
    return { ok: false, error: "This link must contain mode=create." };
  }
  params.mode = "create";
  for (const key of ALLOWED_PARAMS) {
    if (key === "mode") continue;
    const value = url.searchParams.get(key);
    if (value) params[key] = value;
  }

  const strict = buildPerssuaSessionDeepLinkStrict(params);
  return strict.ok
    ? { ok: true, deepLink: strict.deepLink }
    : { ok: false, error: strict.error };
}
