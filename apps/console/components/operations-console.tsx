"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock3,
  FileSearch,
  Headphones,
  Inbox,
  LogIn,
  LogOut,
  LockKeyhole,
  PhoneCall,
  RotateCcw,
  Send,
  ShieldCheck,
  XCircle
} from "lucide-react";
import type { AuditArtifact, CompactDiagnostics, DootCase, Hold, OutboxItem, WebhookInboxEntry } from "@doot/contracts";
import type { Provider, ProviderReliabilityProjection } from "@doot/contracts";

type CasesResponse = {
  cases: DootCase[];
  metrics: {
    totalCases: number;
    resolved: number;
    eligibleResolvedBeforeExpiry: number;
    orphanHoldRate: number;
    humanOverrideRate: number;
  };
};

type ActionState = "idle" | "saving" | "error";
type AuthState = { authMode: "demo-header" | "oidc"; role: string } | null;

const apiBase = process.env.NEXT_PUBLIC_DOOT_API_URL ?? "/api/control";

export function OperationsConsole({ initialCases, initialCase, initialDiagnostics, initialMetrics }: {
  initialCases: DootCase[];
  initialCase: DootCase;
  initialDiagnostics: CompactDiagnostics;
  initialMetrics: CasesResponse["metrics"];
}) {
  const [cases, setCases] = useState(initialCases);
  const [currentCase, setCurrentCase] = useState(initialCase);
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [projection, setProjection] = useState<ProviderReliabilityProjection | null>(null);
  const [artifacts, setArtifacts] = useState<AuditArtifact[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [inbox, setInbox] = useState<WebhookInboxEntry[]>([]);
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [message, setMessage] = useState("Demo case loaded.");
  const [now, setNow] = useState(Date.now());
  const [verificationPhone, setVerificationPhone] = useState("");
  const [verificationReference, setVerificationReference] = useState("");
  const [auth, setAuth] = useState<AuthState>(null);

  const selectedHold = useMemo(
    () => currentCase.holds.find((hold) => hold.status === "active") ?? currentCase.holds[0],
    [currentCase.holds]
  );
  const releasePending = currentCase.holds.filter((hold) => hold.status === "release_pending");
  const activeHolds = currentCase.holds.filter((hold) => hold.status === "active");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void refresh();
    void fetchProviders();
    void fetchArtifacts();
    void fetchWorkQueues();
    void fetchAuthContext();
  }, []);

  useEffect(() => {
    const source = new EventSource(`${apiBase}/v1/ops/events`, { withCredentials: true });
    source.addEventListener("case.snapshot", (event) => {
      try {
        const nextCases = JSON.parse((event as MessageEvent).data) as DootCase[];
        if (!Array.isArray(nextCases) || nextCases.length === 0) return;
        setCases(nextCases);
        setCurrentCase((previous) => nextCases.find((item) => item.id === previous.id) ?? nextCases[0]!);
        setMessage("Live case stream updated.");
      } catch {
        /* ignore malformed SSE payloads */
      }
    });
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, []);

  async function apiFetch(input: string, init: RequestInit = {}) {
    return fetch(`${apiBase}${input}`, { ...init, credentials: "include" });
  }

  async function fetchAuthContext() {
    const response = await apiFetch("/v1/auth/context", { cache: "no-store" });
    if (response.ok) setAuth(await response.json() as AuthState);
  }

  async function fetchProviders() {
    const response = await apiFetch("/v1/providers", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { providers: Provider[] };
    setProviders(data.providers);
    const first = data.providers[0];
    if (first) {
      const projectionResponse = await apiFetch(`/v1/providers/${first.id}/reliability/project`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recordedOutcome: "honoured" })
      });
      if (projectionResponse.ok) setProjection((await projectionResponse.json()) as ProviderReliabilityProjection);
    }
  }

  async function fetchArtifacts() {
    const response = await apiFetch("/v1/audit/artifacts", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { artifacts: AuditArtifact[] };
    setArtifacts(data.artifacts);
  }

  async function refresh() {
    const response = await apiFetch("/v1/ops/cases", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not refresh cases.");
    const data = (await response.json()) as CasesResponse;
    setCases(data.cases);
    const nextCase = data.cases.find((item) => item.id === currentCase.id) ?? data.cases[0];
    if (!nextCase) throw new Error("No demo case returned.");
    setCurrentCase(nextCase);
    setMetrics(data.metrics);
    await refreshDiagnostics(nextCase.id);
    await fetchWorkQueues();
  }

  async function fetchWorkQueues() {
    const [outboxResponse, inboxResponse] = await Promise.all([
      apiFetch("/v1/ops/outbox", { cache: "no-store" }),
      apiFetch("/v1/ops/inbox", { cache: "no-store" })
    ]);
    if (outboxResponse.ok) setOutbox(((await outboxResponse.json()) as { items: OutboxItem[] }).items);
    if (inboxResponse.ok) setInbox(((await inboxResponse.json()) as { entries: WebhookInboxEntry[] }).entries);
  }

  async function refreshDiagnostics(caseId = currentCase.id) {
    const response = await apiFetch(`/v1/diagnostics/cases/${caseId}/bundle`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not refresh diagnostics.");
    setDiagnostics((await response.json()) as CompactDiagnostics);
  }

  async function runAction(action: () => Promise<void>, success: string) {
    setActionState("saving");
    try {
      await action();
      await refresh();
      setActionState("idle");
      setMessage(success);
    } catch (error) {
      setActionState("error");
      setMessage(error instanceof Error ? error.message : "Action failed.");
    }
  }

  async function commitSelectedHold() {
    if (!selectedHold) return;
    await runAction(async () => {
      if (currentCase.mode === "existing" && !currentCase.callerVerifiedAt) {
        const verifyResponse = await apiFetch(`/v1/ops/cases/${currentCase.id}/actions/verify-existing`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-doot-role": "supervisor" },
          body: JSON.stringify({
            suppliedPhoneBlindIndex: verificationPhone,
            suppliedReference: verificationReference
          })
        });
        if (!verifyResponse.ok) throw new Error("Existing-case phone/reference verification failed.");
        const verified = await verifyResponse.json() as { case?: DootCase };
        if (verified.case) setCurrentCase(verified.case);
      }
      const latest = currentCase.mode === "existing"
        ? (await (await apiFetch(`/v1/ops/cases/${currentCase.id}`, { headers: { "x-doot-role": "supervisor" } })).json() as DootCase)
        : currentCase;
      const response = await apiFetch(`/v1/ops/cases/${latest.id}/actions/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-doot-role": "supervisor" },
        body: JSON.stringify({
          caseVersion: latest.version,
          selectedHoldId: selectedHold.id,
          actor: currentCase.mode === "existing" ? "caller" : "caller",
          verification: "phone_match_and_reference"
        })
      });
      if (!response.ok) {
        const failure = await response.json();
        throw new Error(failure.message ?? "Decision was rejected.");
      }
    }, `${selectedHold.reference} committed; alternatives moved to release.`);
  }

  async function confirmRelease(hold: Hold, succeeded: boolean) {
    await runAction(async () => {
      const response = await apiFetch(`/v1/ops/cases/${currentCase.id}/actions/release-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holdId: hold.id, succeeded })
      });
      if (!response.ok) throw new Error("Release result was rejected.");
    }, succeeded ? `${hold.reference} release confirmed.` : `${hold.reference} flagged for manual review.`);
  }

  async function resetDemo() {
    await runAction(async () => {
      const response = await apiFetch("/v1/demo/reset", { method: "POST" });
      if (!response.ok) throw new Error("Demo reset failed.");
    }, "Demo case reset.");
  }

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Operations navigation">
        <div className="brand">
          <div className="mark">दू</div>
          <div>
            <strong>Doot</strong>
            <span>Operations</span>
          </div>
        </div>
        <nav>
          <a className="active" href="#live"><Activity size={18} /> Live</a>
          <a href="#timeline"><Clock3 size={18} /> Timeline</a>
          <a href="#outcomes"><CheckCircle2 size={18} /> Outcomes</a>
          <a href="#workflow"><Send size={18} /> Workflow</a>
          <a href="#diagnostics"><FileSearch size={18} /> Diagnostics</a>
          <a href="#audit"><Archive size={18} /> Audit Vault</a>
        </nav>
        <div className="safety">
          <ShieldCheck size={18} />
          <span>Emergency calls route to 112 or 108. Doot coordinates only after safety screening.</span>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Internal hotline coordination</p>
            <h1>Live Operations</h1>
          </div>
          <div className="topActions">
            <div className={`notice ${actionState}`}>
              <span />
              {message}
            </div>
            <button onClick={resetDemo} aria-label="Reset demo case" title="Reset demo case">
              <RotateCcw size={19} />
            </button>
            <a href={auth?.authMode === "oidc" ? "/api/auth/logout" : "/api/auth/login"} aria-label={auth?.authMode === "oidc" ? "Sign out" : "Sign in"} title={auth?.authMode === "oidc" ? "Sign out" : "Sign in"}>
              {auth?.authMode === "oidc" ? <LogOut size={19} /> : <LogIn size={19} />}
            </a>
            <div className="statusPill">
              <span />
              {currentCase.state.replace("_", " ")}
            </div>
          </div>
        </header>

        <section className="caseQueue" aria-label="Case queue">
          {cases.map((item) => (
            <button
              className={item.id === currentCase.id ? "caseTab active" : "caseTab"}
              key={item.id}
              onClick={() => {
                setCurrentCase(item);
                void refreshDiagnostics(item.id);
              }}
            >
              <span>{item.mode}</span>
              <strong>{item.callerLabel}</strong>
              <em>{item.state.replace("_", " ")}</em>
            </button>
          ))}
        </section>

        <section id="live" className="grid liveGrid">
          <article className="panel casePanel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Case</p>
                <h2>{currentCase.callerLabel}</h2>
              </div>
              <span className="badge urgent">{currentCase.mode}</span>
            </div>
            <p className="summary">{currentCase.needSummary}</p>
            {currentCase.mode === "existing" && !currentCase.callerVerifiedAt ? (
              <div className="verificationFields">
                <input aria-label="Caller phone blind index" value={verificationPhone} onChange={(event) => setVerificationPhone(event.target.value)} placeholder="Phone verification token" />
                <input aria-label="Spoken case reference" value={verificationReference} onChange={(event) => setVerificationReference(event.target.value)} placeholder="Spoken reference" />
              </div>
            ) : null}
            <div className="facts">
              <span><PhoneCall size={16} /> Callback due {minutesUntil(currentCase.callbackDeadlineAt, now)}</span>
              <span><Headphones size={16} /> {currentCase.language}</span>
              <span><LockKeyhole size={16} /> Consent captured</span>
            </div>
          </article>

          <article className="panel decisionPanel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">One Decision Gate</p>
                <h2>{currentCase.state === "awaiting_decision" ? "Awaiting caller" : titleCase(currentCase.state)}</h2>
              </div>
              <button
                onClick={commitSelectedHold}
                disabled={actionState === "saving" || currentCase.state !== "awaiting_decision" || !selectedHold}
                aria-label="Commit selected hold"
                title="Commit selected hold"
              >
                <CheckCircle2 size={20} />
              </button>
            </div>
            <div className="holdList">
              {currentCase.holds.map((hold) => (
                <div className={`hold ${hold.status}`} key={hold.id}>
                  <div>
                    <strong>{hold.reference}</strong>
                    <span>{hold.constraints.join(" · ")}</span>
                    <em>{hold.status.replace("_", " ")}</em>
                  </div>
                  <time>{minutesUntil(hold.expiresAt, now)}</time>
                </div>
              ))}
            </div>
          </article>
        </section>

        {releasePending.length > 0 ? (
          <section className="panel releaseQueue" aria-label="Release queue">
            <div>
              <p className="eyebrow">Release Queue</p>
              <h2>{releasePending.length} alternative hold pending</h2>
            </div>
            <div className="releaseActions">
              {releasePending.map((hold) => (
                <div key={hold.id} className="releaseItem">
                  <strong>{hold.reference}</strong>
                  <button onClick={() => confirmRelease(hold, true)} aria-label={`Confirm release for ${hold.reference}`} title="Confirm release">
                    <CheckCircle2 size={18} />
                  </button>
                  <button onClick={() => confirmRelease(hold, false)} aria-label={`Flag release failure for ${hold.reference}`} title="Flag release failure">
                    <XCircle size={18} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section id="workflow" className="grid">
          <article className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Outbound Work</p>
                <h2>Command Outbox</h2>
              </div>
              <Send size={20} />
            </div>
            <div className="table workTable">
              {outbox.slice(0, 5).map((item) => (
                <div className="row workRow" key={item.id}>
                  <span>{item.command.goal.name}</span>
                  <span className={`badge ${item.status}`}>{item.status.replace("_", " ")}</span>
                  <span>{item.attempts}</span>
                </div>
              ))}
              {outbox.length === 0 ? <p className="summary small">No outbound commands queued.</p> : null}
            </div>
          </article>

          <article className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Webhook Inbox</p>
                <h2>Accepted Events</h2>
              </div>
              <Inbox size={20} />
            </div>
            <div className="table workTable">
              {inbox.slice(0, 5).map((entry) => (
                <div className="row workRow" key={`${entry.id}-${entry.duplicate ? "dupe" : "first"}`}>
                  <span>{entry.source}</span>
                  <span className={entry.duplicate ? "badge failed" : "badge sent"}>{entry.duplicate ? "duplicate" : "accepted"}</span>
                  <span>{entry.processedAt ? "done" : "new"}</span>
                </div>
              ))}
              {inbox.length === 0 ? <p className="summary small">No webhook events received.</p> : null}
            </div>
          </article>
        </section>

        <section className="grid">
          <article className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Provider Fan-out</p>
                <h2>Attempts</h2>
              </div>
            </div>
            <div className="table">
              {currentCase.attempts.map((attempt) => (
                <div className="row" key={attempt.id}>
                  <span>{attempt.providerName}</span>
                  <span className={`badge ${attempt.outcome}`}>{attempt.outcome.replace("_", " ")}</span>
                  <span>{attempt.durationSeconds}s</span>
                </div>
              ))}
            </div>
          </article>

          <article id="outcomes" className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Outcomes</p>
                <h2>Proof Metrics</h2>
              </div>
            </div>
            <div className="metrics">
              <Metric label="Resolved" value={`${metrics.resolved}/${metrics.totalCases}`} />
              <Metric label="Before expiry" value={String(metrics.eligibleResolvedBeforeExpiry)} />
              <Metric label="Orphan hold rate" value={`${Math.round(metrics.orphanHoldRate * 100)}%`} />
              <Metric label="Override rate" value={`${Math.round(metrics.humanOverrideRate * 100)}%`} />
            </div>
          </article>
        </section>

        <section className="grid">
          <article className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Provider Reliability</p>
                <h2>Registry</h2>
              </div>
            </div>
            <div className="table">
              {providers.slice(0, 4).map((provider) => (
                <div className="row reliabilityRow" key={provider.id}>
                  <span>{provider.name}</span>
                  <span>{Math.round(provider.reliability.holdHonourRate * 100)}% honour</span>
                  <span>{provider.reliability.averageResponseSeconds}s</span>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Post-Commit Signal</p>
                <h2>Reliability Projection</h2>
              </div>
            </div>
            {projection ? (
              <div className="projection">
                <strong>{Math.round(projection.score * 100)}%</strong>
                <span>Projected score after honoured confirmation for {projection.providerId}</span>
              </div>
            ) : (
              <p className="summary small">Provider reliability is waiting for registry data.</p>
            )}
          </article>
        </section>

        <section className="grid">
          <article id="timeline" className="panel">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Case Timeline</p>
                <h2>Events</h2>
              </div>
            </div>
            <ol className="timeline">
              {currentCase.timeline.map((item) => (
                <li key={item.id}>
                  <span className={`dot ${item.kind}`} />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </article>

          <article id="diagnostics" className="panel diagnostics">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Diagnostics</p>
                <h2>Compact Bundle</h2>
              </div>
              {diagnostics.firstRelevantError ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
            </div>
            <dl>
              <dt>Workflow</dt>
              <dd>{diagnostics.workflowStatus}</dd>
              <dt>Trace</dt>
              <dd>{currentCase.traceId.slice(0, 12)}...</dd>
              <dt>Next check</dt>
              <dd>{diagnostics.nextChecks[0]}</dd>
            </dl>
          </article>
        </section>

        <section id="audit" className="panel audit">
          <div>
            <p className="eyebrow">Audit Vault</p>
            <h2>Restricted Artifacts</h2>
          </div>
          <div className="auditGrid">
            {artifacts.slice(0, 4).map((artifact) => (
              <span key={artifact.id}>
                <strong>{artifact.artifactType.replace("_", " ")}</strong>
                <em>{artifact.deletionStatus.replace("_", " ")}</em>
              </span>
            ))}
            {artifacts.length === 0 ? <span>Artifact inventory waiting for API.</span> : null}
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function minutesUntil(iso: string, now: number) {
  const value = Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60_000));
  return `${value}m`;
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
