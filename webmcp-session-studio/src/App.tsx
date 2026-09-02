import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  LockKeyhole,
  MessageSquareText,
  Sparkles,
  UserRound,
  WandSparkles,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import perssuaMark from "./assets/perssua-mark.svg";
import {
  buildStudioHandoff,
  compileStudioContext,
  compileStudioPrompt,
  isAssistantDefinitionReady,
  STUDIO_FIELD_LIMITS,
  StudioSetupStore,
  type StudioFlowStep,
  type StudioSetup,
  type StudioSetupField,
  type StudioTextField,
} from "./studio-brief";
import {
  registerStudioTools,
  STUDIO_TOOL_NAMES,
  type StudioToolName,
  type WebMcpModelContext,
} from "./studio-webmcp";
import {
  STUDIO_COMPATIBLE_DOWNLOADS,
  STUDIO_MIN_DESKTOP_VERSION,
} from "./studio-downloads";

export type WebMcpStatus = "checking" | "active" | "unsupported" | "error";
type StudioStep = StudioFlowStep;

export const STUDIO_STEPS: Array<{
  id: StudioStep;
  title: string;
  short: string;
}> = [
  { id: 1, title: "Draft the assistant", short: "Draft" },
  { id: 2, title: "Review the proposal", short: "Review" },
  { id: 3, title: "Add knowledge", short: "Knowledge" },
  { id: 4, title: "Prepare first message", short: "First message" },
  { id: 5, title: "Start the session", short: "Start" },
];

export const STUDIO_SESSION_START_CTA_COPY = "Create assistant and start session";

type StudioLocale = "en" | "pt" | "es";

const STUDIO_LOCALE_COPY: Record<StudioLocale, {
  language: string;
  studio: string;
  staysHere: string;
  draft: string;
  review: string;
  continue: string;
  cta: string;
}> = {
  en: { language: "Language", studio: "Session Studio", staysHere: "Setup stays in this tab", draft: "Draft your new assistant", review: "Review the proposal", continue: "Continue", cta: "Create assistant and start session" },
  pt: { language: "Idioma", studio: "Studio de sessão", staysHere: "A configuração fica nesta aba", draft: "Crie o assistente", review: "Revise a proposta", continue: "Continuar", cta: "Criar assistente e iniciar sessão" },
  es: { language: "Idioma", studio: "Studio de sesión", staysHere: "La configuración permanece en esta pestaña", draft: "Redacta el asistente", review: "Revisa la propuesta", continue: "Continuar", cta: "Crear asistente e iniciar la sesión" },
};

export function isStudioStepComplete(
  step: { id: StudioStep },
  currentStep: StudioStep,
  highestStep: StudioStep,
): boolean {
  return step.id < highestStep && step.id !== currentStep;
}

function initialStudioLocale(): StudioLocale {
  const value = new URLSearchParams(window.location.search).get("lang");
  return value === "pt" || value === "es" ? value : "en";
}

const TOOL_COPY: Record<StudioToolName, string> = {
  inspect_studio_setup: "Inspect setup",
  define_assistant: "Define assistant",
  append_knowledge_note: "Append knowledge",
  prepare_first_session: "Prepare first session",
  reset_studio_setup: "Reset setup",
};

const FIELD_LABELS: Record<StudioSetupField | "studioStep", string> = {
  assistantName: "Assistant name",
  assistantInstructions: "Instructions",
  assistantCategory: "Category",
  realtimePrompt: "Notch prompt",
  followUpPrompt: "Follow-up prompt",
  emailPrompt: "Summary prompt",
  requireCertainty: "Require certainty",
  sessionGoal: "Session goal",
  knowledgeNotes: "Knowledge notes",
  openingPrompt: "First message",
  studioStep: "Studio step",
};

function readModelContext(): WebMcpModelContext | null {
  return (
    document as Document & { modelContext?: WebMcpModelContext }
  ).modelContext ?? null;
}

export function CapabilityNotice({ status }: { status: WebMcpStatus }) {
  if (status === "active") {
    return (
      <div className="capability-notice capability-active">
        <span className="capability-dot" aria-hidden="true" />
        <span>
          <strong>WebMCP connected</strong>
          Five scoped tools are available.
        </span>
      </div>
    );
  }
  if (status === "unsupported") {
    return (
      <div className="capability-notice">
        <UserRound aria-hidden="true" />
        <span>
          <strong>Manual mode</strong>
          The complete wizard still works.
        </span>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="capability-notice capability-error">
        <CircleAlert aria-hidden="true" />
        <span>
          <strong>Agent tools unavailable</strong>
          Manual mode stayed active.
        </span>
      </div>
    );
  }
  return (
    <div className="capability-notice">
      <span className="capability-dot" aria-hidden="true" />
      <span>
        <strong>Checking WebMCP</strong>
        You can start immediately.
      </span>
    </div>
  );
}

function CharacterCount({ field, value }: { field: StudioTextField; value: string }) {
  return (
    <span className="character-count">
      {value.length.toLocaleString()} /{" "}
      {STUDIO_FIELD_LIMITS[field].toLocaleString()}
    </span>
  );
}

function TextField({
  field,
  label,
  hint,
  value,
  placeholder,
  multiline = false,
  rows = 3,
  optional = false,
  onChange,
}: {
  field: StudioTextField;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  rows?: number;
  optional?: boolean;
  onChange: (field: StudioTextField, value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-heading">
        <span>
          {label}
          {optional ? <em>Optional</em> : null}
        </span>
        <CharacterCount field={field} value={value} />
      </span>
      <span className="field-hint">{hint}</span>
      {multiline ? (
        <textarea
          rows={rows}
          value={value}
          maxLength={STUDIO_FIELD_LIMITS[field]}
          placeholder={placeholder}
          onChange={(event) => onChange(field, event.target.value)}
        />
      ) : (
        <input
          value={value}
          maxLength={STUDIO_FIELD_LIMITS[field]}
          placeholder={placeholder}
          onChange={(event) => onChange(field, event.target.value)}
        />
      )}
    </label>
  );
}

function AssistantPreview({ setup }: { setup: StudioSetup }) {
  const title = setup.assistantName.trim() || "Your new assistant";
  const instructions = setup.assistantInstructions.trim();

  return (
    <aside className="preview-column" aria-label="Live assistant preview">
      <div className="preview-topline">
        <span>Live preview</span>
        <span>
          <i aria-hidden="true" /> Local only
        </span>
      </div>
      <div className="preview-card preview-create">
        <div className="preview-glow" aria-hidden="true" />
        <div className="avatar-frame" aria-hidden="true">
          <div className="avatar-core">
            <Sparkles />
          </div>
          <span />
          <span />
        </div>
        <div className="preview-identity">
          <span className="preview-mode">
            New assistant proposal
          </span>
          <h3>{title}</h3>
          {setup.assistantCategory.trim() ? (
            <span className="category-pill">{setup.assistantCategory.trim()}</span>
          ) : null}
        </div>
        <div className="preview-rule" />
        <div className="preview-section">
          <span>Instructions</span>
          <p>
            {instructions ||
              "Add instructions to define how this assistant should think and respond."}
          </p>
        </div>
        <div className="preview-section">
          <span>First-session goal</span>
          <p>{setup.sessionGoal.trim() || "Your goal will appear here."}</p>
        </div>
        <div className="preview-footer">
          <span>
            <LockKeyhole /> Not saved
          </span>
          <span className={setup.openingPrompt.trim() ? "preview-ready" : undefined}>
            <MessageSquareText />
            {setup.openingPrompt.trim() ? "Message staged" : "No message yet"}
          </span>
        </div>
      </div>
      <p className="preview-caption">
        Perssua will ask you to confirm creation, then open the session and prefill the first message without sending it.
      </p>
    </aside>
  );
}

function ChangeValue({ value, emptyLabel }: { value: string; emptyLabel: string }) {
  return <div className="change-value">{value || <em>{emptyLabel}</em>}</div>;
}

function ActivityLedger({
  status,
  changes,
}: {
  status: WebMcpStatus;
  changes: ReturnType<StudioSetupStore["getSnapshot"]>["agentChanges"];
}) {
  return (
    <details className="activity-panel">
      <summary>
        <span>
          <Bot aria-hidden="true" />
          <strong>Agent activity</strong>
          <small>
            {changes.length} recorded change{changes.length === 1 ? "" : "s"}
          </small>
        </span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="activity-body">
        <div className="tool-list" aria-label="Registered WebMCP tools">
          {STUDIO_TOOL_NAMES.map((toolName) => (
            <span key={toolName}>
              <Check aria-hidden="true" /> {TOOL_COPY[toolName]}
            </span>
          ))}
        </div>
        <div className="ledger" aria-live="polite">
          {changes.length === 0 ? (
            <div className="empty-ledger">
              <Bot aria-hidden="true" />
              <span>
                <strong>No agent edits yet</strong>
                Every tool mutation will show exact before and after values here.
              </span>
            </div>
          ) : (
            changes.map((entry) => (
              <article className="change-card" key={entry.id}>
                <div className="change-meta">
                  <span>
                    {TOOL_COPY[entry.toolName as StudioToolName] ?? entry.toolName}
                  </span>
                  <time dateTime={entry.timestamp}>
                    {new Date(entry.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                {entry.changes.map((change) => (
                  <details key={`${entry.id}-${change.field}`}>
                    <summary>
                      <span>{FIELD_LABELS[change.field]}</span>
                      <ChevronDown aria-hidden="true" />
                    </summary>
                    <div className="diff-grid">
                      <div>
                        <span>Before</span>
                        <ChangeValue value={change.before} emptyLabel="Empty" />
                      </div>
                      <div>
                        <span>After</span>
                        <ChangeValue value={change.after} emptyLabel="Cleared" />
                      </div>
                    </div>
                  </details>
                ))}
              </article>
            ))
          )}
        </div>
        {status !== "active" ? (
          <p className="activity-fallback">
            The ledger remains available in manual mode.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function ReviewRow({
  label,
  value,
  empty = "Not provided",
}: {
  label: string;
  value: string;
  empty?: string;
}) {
  return (
    <div className="review-row">
      <span>{label}</span>
      <p>{value.trim() || <em>{empty}</em>}</p>
    </div>
  );
}

export function App() {
  const store = useMemo(() => new StudioSetupStore(), []);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [webMcpStatus, setWebMcpStatus] = useState<WebMcpStatus>("checking");
  const [proposalReviewed, setProposalReviewed] = useState(false);
  const [locale, setLocale] = useState<StudioLocale>(initialStudioLocale);
  const setup = snapshot.setup;
  const currentStep = snapshot.currentStep;
  const highestStep = snapshot.highestStep;
  const compiledContext = compileStudioContext(setup);
  const compiledPrompt = compileStudioPrompt(setup);
  const handoff = buildStudioHandoff(setup);
  const assistantReady = isAssistantDefinitionReady(setup);
  const copy = STUDIO_LOCALE_COPY[locale];

  const changeLocale = (nextLocale: StudioLocale) => {
    const url = new URL(window.location.href);
    url.searchParams.set("lang", nextLocale);
    window.history.replaceState({}, "", url);
    setLocale(nextLocale);
  };

  useEffect(() => {
    const modelContext = readModelContext();
    if (!modelContext) {
      setWebMcpStatus("unsupported");
      return;
    }
    const registration = registerStudioTools(modelContext, store);
    let mounted = true;
    void registration.registered
      .then(() => {
        if (mounted) setWebMcpStatus("active");
      })
      .catch(() => {
        if (mounted) setWebMcpStatus("error");
      });
    return () => {
      mounted = false;
      registration.cleanup();
    };
  }, [store]);

  useEffect(() => {
    setProposalReviewed(false);
  }, [
    setup.assistantName,
    setup.assistantInstructions,
    setup.assistantCategory,
    setup.realtimePrompt,
    setup.followUpPrompt,
    setup.emailPrompt,
    setup.requireCertainty,
    setup.sessionGoal,
  ]);

  const updateHuman = (field: StudioTextField, value: string) => {
    store.updateHuman(field, value);
  };

  const canContinue =
    currentStep === 1
      ? assistantReady
      : currentStep === 2
        ? proposalReviewed
        : currentStep === 3
          ? !compiledContext.overLimit
          : currentStep === 4
            ? handoff.ok
            : false;

  const continueWizard = () => {
    if (!canContinue || currentStep >= 5) return;
    store.advanceToNextStepFromHuman();
  };

  const goToStep = (step: StudioStep) => {
    store.goToStepFromHuman(step);
  };

  const stepCopy = {
    1: {
      kicker: "Step 1 of 5",
      title: copy.draft,
      body:
        "Define the proposal and the goal for its first session. You can edit every word.",
    },
    2: {
      kicker: "Step 2 of 5",
      title: copy.review,
      body:
        "Review every proposed value before continuing. This is still only a proposal and cannot create anything.",
    },
    3: {
      kicker: "Step 3 of 5",
      title: "Give it useful context",
      body:
        "Add facts, constraints, vocabulary, or background. Agents may append notes, never replace human-written context.",
    },
    4: {
      kicker: "Step 4 of 5",
      title: "Stage the first message",
      body:
        "Prepare exactly what should appear in the composer. This page never sends it for you.",
    },
    5: {
      kicker: "Step 5 of 5",
      title: "Start the session",
      body:
        "Review the final setup. After your click, Perssua asks you to confirm the assistant, opens the session, and pre-fills the first message without sending it.",
    },
  }[currentStep];

  return (
    <div className="studio-root wizard-root">
      <header className="site-header wizard-header">
        <a href="https://perssua.com" aria-label="Perssua home" className="brand">
          <img src={perssuaMark} alt="" width="21" height="40" />
          <span>perssua</span>
        </a>
        <div className="header-label">
          <span>WebMCP</span> {copy.studio}
        </div>
        <div className="local-only">
          <LockKeyhole aria-hidden="true" /> {copy.staysHere}
        </div>
        <label className="language-selector">
          <span>{copy.language}</span>
          <select value={locale} onChange={(event) => changeLocale(event.target.value as StudioLocale)}>
            <option value="en">English</option>
            <option value="pt">Português (Brasil)</option>
            <option value="es">Español</option>
          </select>
        </label>
      </header>

      <div className="wizard-shell">
        <aside className="wizard-sidebar">
          <div className="sidebar-intro">
            <span className="sidebar-kicker">Build the handoff</span>
            <h1>One clear decision at a time.</h1>
          </div>
          <nav className="step-list" aria-label="Studio setup progress">
            {STUDIO_STEPS.map((step) => {
              const active = step.id === currentStep;
              const completed = isStudioStepComplete(step, currentStep, highestStep);
              const available = step.id <= highestStep;
              return (
                <button
                  type="button"
                  key={step.id}
                  onClick={() => goToStep(step.id)}
                  disabled={!available}
                  aria-current={active ? "step" : undefined}
                  className={`step-item ${active ? "step-active" : ""} ${completed ? "step-complete" : ""}`}
                >
                  <span className="step-marker">
                    {completed ? <Check aria-hidden="true" /> : step.id}
                  </span>
                  <span>
                    <strong>{step.title}</strong>
                    <small>{step.short}</small>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-bottom">
            <CapabilityNotice status={webMcpStatus} />
            <ActivityLedger
              status={webMcpStatus}
              changes={snapshot.agentChanges}
            />
          </div>
        </aside>

        <main className="wizard-main">
          <div className="mobile-progress">
            <span>Step {currentStep} of 5</span>
            <div>
              {STUDIO_STEPS.map((step) => (
                <i
                  key={step.id}
                  className={step.id <= currentStep ? "mobile-progress-on" : undefined}
                />
              ))}
            </div>
          </div>

          <div className="step-heading">
            <p>{stepCopy.kicker}</p>
            <h2>{stepCopy.title}</h2>
            <span>{stepCopy.body}</span>
          </div>

          <div className="wizard-stage">
            <section className="task-panel" aria-label={stepCopy.title}>
              {currentStep === 1 ? (
                <div className="field-stack">
                  <TextField
                    field="assistantName"
                    label="Assistant name"
                    hint="The name you will see in Perssua."
                    value={setup.assistantName}
                    placeholder="Research interview partner"
                    onChange={updateHuman}
                  />
                  <TextField
                    field="realtimePrompt"
                    label="Notch realtime prompt"
                    hint="Optional. Guides real-time Notch suggestions."
                    value={setup.realtimePrompt}
                    placeholder="Listen for the user’s intent, then suggest one concise next sentence."
                    multiline
                    rows={4}
                    optional
                    onChange={updateHuman}
                  />
                  <TextField
                    field="followUpPrompt"
                    label="Follow-up prompt"
                    hint="Optional. Defines clickable follow-up suggestions."
                    value={setup.followUpPrompt}
                    placeholder="Offer three practical follow-up questions."
                    multiline
                    rows={3}
                    optional
                    onChange={updateHuman}
                  />
                  <TextField
                    field="emailPrompt"
                    label="Summary prompt"
                    hint="Optional. Defines the end-of-session summary."
                    value={setup.emailPrompt}
                    placeholder="Summarize decisions, owners, and the next step."
                    multiline
                    rows={3}
                    optional
                    onChange={updateHuman}
                  />
                  <label className="review-confirmation">
                    <input
                      type="checkbox"
                      checked={setup.requireCertainty}
                      onChange={(event) => store.updateHumanRequireCertainty(event.target.checked)}
                    />
                    <span><strong>Require certainty.</strong>Only reply when the assistant is sufficiently certain.</span>
                  </label>
                  <TextField
                    field="assistantInstructions"
                    label="Instructions"
                    hint="Define the assistant's role, behavior, boundaries, and response style."
                    value={setup.assistantInstructions}
                    placeholder="You help me run focused research interviews. Ask one clear follow-up at a time…"
                    multiline
                    rows={7}
                    onChange={updateHuman}
                  />
                  <TextField
                    field="assistantCategory"
                    label="Category"
                    hint="A lightweight label to organize the assistant."
                    value={setup.assistantCategory}
                    placeholder="Research"
                    optional
                    onChange={updateHuman}
                  />
                  <TextField
                    field="sessionGoal"
                    label="First-session goal"
                    hint="What should this first session accomplish?"
                    value={setup.sessionGoal}
                    placeholder="Identify the three strongest unmet needs from this interview."
                    multiline
                    rows={3}
                    onChange={updateHuman}
                  />
                </div>
              ) : null}

              {currentStep === 2 ? (
                <div className="review-panel">
                  <div className="review-badge">
                    <WandSparkles />
                    <span>
                      <strong>Create proposal</strong>
                      Review the visible proposal before continuing.
                    </span>
                  </div>
                  <ReviewRow label="Assistant name" value={setup.assistantName} />
                  <ReviewRow label="Instructions" value={setup.assistantInstructions} />
                  <ReviewRow label="Category" value={setup.assistantCategory} empty="No category" />
                  <ReviewRow label="Notch prompt" value={setup.realtimePrompt} empty="Use Perssua default" />
                  <ReviewRow label="Follow-up prompt" value={setup.followUpPrompt} empty="Use Perssua default" />
                  <ReviewRow label="Summary prompt" value={setup.emailPrompt} empty="Use Perssua default" />
                  <ReviewRow label="Require certainty" value={setup.requireCertainty ? "Yes" : "No"} />
                  <ReviewRow label="Session goal" value={setup.sessionGoal} />
                  <label className="review-confirmation">
                    <input type="checkbox" checked={proposalReviewed} onChange={(event) => setProposalReviewed(event.target.checked)} />
                    <span><strong>I reviewed this proposal.</strong>It is not created yet, and the final handoff still requires your click.</span>
                  </label>
                </div>
              ) : null}

              {currentStep === 3 ? (
                <div className="field-stack">
                  <TextField
                    field="knowledgeNotes"
                    label="Knowledge and context"
                    hint="Human-editable notes. An agent can only append through its dedicated tool."
                    value={setup.knowledgeNotes}
                    placeholder={
                      "Audience: product leaders\nConstraint: 30-minute interview\nKnown terminology: …"
                    }
                    multiline
                    rows={12}
                    optional
                    onChange={updateHuman}
                  />
                  <div
                    className={`context-budget ${compiledContext.overLimit ? "budget-error" : ""}`}
                  >
                    <span>Compiled desktop context</span>
                    <strong>
                      {compiledContext.length.toLocaleString()} / 8,000
                    </strong>
                    <i>
                      <b
                        style={{
                          width: `${Math.min(100, compiledContext.length / 80)}%`,
                        }}
                      />
                    </i>
                    <p>
                      {compiledContext.overLimit
                        ? "Reduce the permanent knowledge notes. Nothing will be truncated."
                        : "Only permanent knowledge is saved with the assistant. The first-session goal stays in the first message."}
                    </p>
                  </div>
                </div>
              ) : null}

              {currentStep === 4 ? (
                <div className="field-stack">
                  <TextField
                    field="openingPrompt"
                    label="First message"
                    hint="This will be staged for review in Perssua, never submitted automatically."
                    value={setup.openingPrompt}
                    placeholder="Start by summarizing the interview objective, then suggest the first question."
                    multiline
                    rows={10}
                    onChange={updateHuman}
                  />
                  <div className="composer-preview">
                    <span>
                      <MessageSquareText aria-hidden="true" /> Perssua composer
                      preview
                    </span>
                    <p>
                      {compiledPrompt.prompt.trim() ||
                        "Your first message will appear here."}
                    </p>
                    <small>Waiting for your review — not sent</small>
                  </div>
                  {!handoff.ok && handoff.code !== "incomplete" ? (
                    <div className="validation-error">
                      <CircleAlert aria-hidden="true" /> {handoff.error}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {currentStep === 5 ? (
                <div className="review-panel">
                  <div className="review-badge">
                    <WandSparkles />
                    <span>
                      <strong>Create proposal</strong>
                      Requires confirmation in Perssua
                    </span>
                  </div>
                  <ReviewRow label="Assistant name" value={setup.assistantName} />
                  <ReviewRow label="Instructions" value={setup.assistantInstructions} />
                  <ReviewRow label="Category" value={setup.assistantCategory} empty="No category" />
                  <ReviewRow label="Notch prompt" value={setup.realtimePrompt} empty="Use Perssua default" />
                  <ReviewRow label="Follow-up prompt" value={setup.followUpPrompt} empty="Use Perssua default" />
                  <ReviewRow label="Summary prompt" value={setup.emailPrompt} empty="Use Perssua default" />
                  <ReviewRow label="Require certainty" value={setup.requireCertainty ? "Yes" : "No"} />
                  <ReviewRow label="Session goal" value={setup.sessionGoal} />
                  <ReviewRow
                    label="Knowledge"
                    value={setup.knowledgeNotes}
                    empty="No additional knowledge"
                  />
                  <ReviewRow label="First message" value={setup.openingPrompt} />

                  <div className="handoff-facts">
                    <span>
                      <Check /> Nothing auto-submits
                    </span>
                    <span>
                      <Check /> No files or redirects
                    </span>
                    <span>
                      <Check /> Authentication stays in Perssua
                    </span>
                    <span>
                      <Check /> Source marked as WebMCP
                    </span>
                  </div>

                  {handoff.ok ? (
                    <div className="payload-summary">
                      <span>Encoded proposal</span>
                      <strong>
                        {handoff.encodedLength.toLocaleString()} / 24,000
                        characters
                      </strong>
                    </div>
                  ) : (
                    <div className="validation-error">
                      <CircleAlert aria-hidden="true" /> {handoff.error}
                    </div>
                  )}

                  <a
                    href={handoff.ok ? handoff.deepLink : undefined}
                    aria-disabled={!handoff.ok}
                    className={`open-button ${!handoff.ok ? "open-button-disabled" : ""}`}
                    onClick={(event) => {
                      if (!handoff.ok) event.preventDefault();
                    }}
                  >
                    {locale === "en" ? STUDIO_SESSION_START_CTA_COPY : copy.cta}
                    <ArrowUpRight aria-hidden="true" />
                  </a>
                  <p className="cta-note">
                    Perssua first asks you to confirm assistant creation, then opens the session and pre-fills the first message. Nothing is sent automatically.
                  </p>

                  <details className="download-fallback">
                    <summary>
                      Need a compatible desktop build?
                      <ChevronDown aria-hidden="true" />
                    </summary>
                    <p>
                      External handoffs require Perssua v
                      {STUDIO_MIN_DESKTOP_VERSION} or newer. These v
                      {STUDIO_MIN_DESKTOP_VERSION} links are isolated to Studio;
                      global download and canary channels remain unchanged.
                    </p>
                    <div className="download-grid">
                      {STUDIO_COMPATIBLE_DOWNLOADS.map((download) => (
                        <a href={download.href} key={download.platform}>
                          {download.label}
                          <ArrowUpRight />
                        </a>
                      ))}
                    </div>
                  </details>
                </div>
              ) : null}
            </section>

            <AssistantPreview setup={setup} />
          </div>

          <div className="wizard-navigation">
            <button
              type="button"
              className="back-button"
              onClick={() => store.goToStepFromHuman((currentStep - 1) as StudioStep)}
              disabled={currentStep === 1}
            >
              <ArrowLeft aria-hidden="true" /> Previous
            </button>
            <span>
              {currentStep < 5
                ? "Nothing leaves this page when you continue."
                : "Your click starts the handoff; sending stays in Perssua."}
            </span>
            {currentStep < 5 ? (
              <button
                type="button"
                className="continue-button"
                onClick={continueWizard}
                disabled={!canContinue}
              >
              {copy.continue} <ArrowRight aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="back-button"
                onClick={() => store.goToStepFromHuman(4)}
              >
                <FileText aria-hidden="true" /> Edit first message
              </button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
