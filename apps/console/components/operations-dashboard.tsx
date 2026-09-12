"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Archive, Check, Clock3, FileText, PhoneCall, RefreshCw, ShieldCheck } from "lucide-react";
import type { AuditArtifact, DootCase, OutboxItem, WebhookInboxEntry } from "@doot/contracts";

type CallRow = {
  id: string; providerName: string; providerId: string; kind: "provider_hold_goal" | "release_hold_goal";
  source: "call_e" | "fixture"; status: string; goalRunId: string | null; callId: string | null;
  createdAt: string; updatedAt: string; outcome: string | null; evidenceSummary: string | null;
  holdReference: string | null; error: string | null;
  transcriptArtifactId: string | null;
};
type View = "calls" | "proof";
type Rehearsal = {
  caseId: string; service: "shelter" | "respite"; callId: string | null; status: string;
  availability: "yes" | "no" | "unknown" | null; caseCodeConfirmed: "yes" | "no" | "unknown" | null;
  answered: boolean; caseCodeSpoken: boolean; taskCompleted: boolean | null; verifiedConversation: boolean;
  transcriptAvailable: boolean; errorCode: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
};
const apiBase = process.env.NEXT_PUBLIC_DOOT_API_URL ?? "/api/control";

export function OperationsDashboard() {
  const [cases, setCases] = useState<DootCase[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [inbox, setInbox] = useState<WebhookInboxEntry[]>([]);
  const [artifacts, setArtifacts] = useState<AuditArtifact[]>([]);
  const [view, setView] = useState<View>("calls");
  const [selectedHoldId, setSelectedHoldId] = useState("");
  const [notice, setNotice] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const [transcript, setTranscript] = useState<{ providerName: string; turns: Array<{ speaker: string; text: string }> } | null>(null);
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(null);
  const [rehearsalConfigured, setRehearsalConfigured] = useState(false);
  const [rehearsalService, setRehearsalService] = useState<"shelter" | "respite">("shelter");
  const [rehearsalConfirmed, setRehearsalConfirmed] = useState(false);
  const [rehearsalBusy, setRehearsalBusy] = useState(false);
  const [rehearsalTurns, setRehearsalTurns] = useState<Array<{ speaker: string; text: string }> | null>(null);
  const current = cases.find((item) => item.id === selectedCaseId) ?? cases[0] ?? null;
  const activeHolds = current?.holds.filter((hold) => hold.status === "active" && Date.parse(hold.expiresAt) > Date.now()) ?? [];

  const load = useCallback(async () => {
    const response = await fetch(`${apiBase}/v1/ops/cases`, { cache: "no-store", credentials: "include" });
    if (response.status === 401 || response.status === 403) { setUnauthorized(true); return; }
    if (!response.ok) { setNotice("Could not load the case queue."); return; }
    setUnauthorized(false);
    const data = await response.json() as { cases: DootCase[] };
    const ordered = [...data.cases].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    setCases(ordered);
    setSelectedCaseId((old) => ordered.some((item) => item.id === old) ? old : ordered[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!current) return;
    const caseId = current.id;
    const get = async () => {
      const response = await fetch(`${apiBase}/v1/ops/cases/${caseId}/provider-calls`, { cache: "no-store", credentials: "include" });
      if (response.ok) setCalls(((await response.json()) as { calls: CallRow[] }).calls);
    };
    void get();
    const timer = window.setInterval(() => void get(), 2000);
    return () => window.clearInterval(timer);
  }, [current?.id]);

  useEffect(() => {
    if (!current) { setRehearsal(null); return; }
    const caseId = current.id;
    const get = async () => {
      const response = await fetch(`${apiBase}/v1/ops/cases/${caseId}/call-e-rehearsal`, { cache: "no-store", credentials: "include" });
      if (!response.ok) return;
      const data = await response.json() as { configured: boolean; rehearsal: Rehearsal | null };
      setRehearsalConfigured(data.configured);
      setRehearsal(data.rehearsal);
    };
    void get();
    const timer = window.setInterval(() => void get(), 3000);
    return () => window.clearInterval(timer);
  }, [current?.id]);

  useEffect(() => {
    if (view !== "proof") return;
    const get = async () => {
      const results = await Promise.all([
        fetch(`${apiBase}/v1/ops/outbox`, { credentials: "include" }),
        fetch(`${apiBase}/v1/ops/inbox`, { credentials: "include" }),
        fetch(`${apiBase}/v1/audit/artifacts`, { credentials: "include" })
      ]);
      if (results[0]?.ok) setOutbox(((await results[0].json()) as { items: OutboxItem[] }).items);
      if (results[1]?.ok) setInbox(((await results[1].json()) as { entries: WebhookInboxEntry[] }).entries);
      if (results[2]?.ok) setArtifacts(((await results[2].json()) as { artifacts: AuditArtifact[] }).artifacts);
    };
    void get();
  }, [view, current?.id]);

  async function overrideDecision() {
    if (!current || !selectedHoldId) return;
    const response = await fetch(`${apiBase}/v1/ops/cases/${current.id}/actions/decide`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "x-doot-role": "supervisor" },
      body: JSON.stringify({
        caseVersion: current.decisionVersion ?? current.version,
        selectedHoldId, actor: "operator", verification: "operator_override"
      })
    });
    if (!response.ok) {
      setNotice("Override rejected. Refresh the case and review hold expiry.");
      return;
    }
    setSelectedHoldId("");
    setNotice("Operator override recorded. Alternative release is tracked.");
    await load();
  }

  async function openTranscript(call: CallRow) {
    if (!current) return;
    const kind = call.kind === "release_hold_goal" ? "release" : "hold";
    const response = await fetch(`${apiBase}/v1/ops/cases/${current.id}/provider-transcripts/${call.providerId}?kind=${kind}`, { credentials: "include" });
    if (!response.ok) { setNotice("Provider-side transcript is not available to this role."); return; }
    const body = await response.json() as { turns: Array<{ speaker: string; text: string }> };
    setTranscript({ providerName: call.providerName, turns: body.turns });
  }

  async function startRehearsal() {
    if (!current || !rehearsalConfirmed || rehearsalBusy) return;
    setRehearsalBusy(true);
    try {
      const response = await fetch(`${apiBase}/v1/ops/cases/${current.id}/call-e-rehearsal`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true, service: rehearsal?.service ?? rehearsalService })
      });
      const data = await response.json() as Rehearsal & { code?: string };
      if (!response.ok) { setNotice(data.code === "CALL_E_CREATE_UNCONFIRMED" ? "CALL-E acceptance is unconfirmed. Retry uses the same call key." : `CALL-E rehearsal rejected: ${data.code ?? response.status}.`); return; }
      setRehearsal(data);
      setRehearsalConfirmed(false);
      setNotice(`CALL-E accepted rehearsal ${data.callId ?? "pending"}. Awaiting authenticated result.`);
    } finally { setRehearsalBusy(false); }
  }

  async function openRehearsalTranscript() {
    if (!current) return;
    const response = await fetch(`${apiBase}/v1/ops/cases/${current.id}/call-e-rehearsal/transcript`, { credentials: "include" });
    if (!response.ok) { setNotice("CALL-E transcript is not available to this role."); return; }
    const data = await response.json() as { turns: Array<{ speaker: string; text: string }> };
    setRehearsalTurns(data.turns);
  }

  return <main className="ops">
    <header className="ops-header"><div className="ops-brand"><span>दू</span><strong>Doot</strong><small>Operations</small></div><a href="/"><ArrowLeft size={16} /> Caller view</a></header>
    <div className="ops-layout">
      <aside className="ops-queue" aria-label="Case queue">
        <div className="ops-queue-title"><h2>Cases</h2><button aria-label="Refresh cases" title="Refresh cases" onClick={() => void load()}><RefreshCw size={17} /></button></div>
        {cases.map((item) => <button key={item.id} className={item.id === current?.id ? "ops-case active" : "ops-case"} onClick={() => { setSelectedCaseId(item.id); setSelectedHoldId(""); setTranscript(null); setRehearsalTurns(null); setRehearsalConfirmed(false); }}>
          <span>{item.id.startsWith("case_demo_") ? "Fixture seed" : item.callerChannel === "browser" ? "Browser call" : "Phone case"} · {item.mode}</span><strong>{item.callerLabel}</strong><small>{item.state.replaceAll("_", " ")}</small>
        </button>)}
        {!cases.length && <p className="ops-empty">{unauthorized ? "Sign in to view operations." : "No cases yet. Start a browser call."}</p>}
        {unauthorized && <a href="/api/auth/login">Sign in</a>}
      </aside>
      <section className="ops-content">
        <div className="ops-title"><div><p className="ops-kicker">CASE COORDINATION</p><h1>{current ? current.needSummary : "Waiting for a caller"}</h1></div><span className="ops-state">{current?.state.replaceAll("_", " ") ?? "idle"}</span></div>
        {current && <div className="ops-facts"><span><PhoneCall size={15} /> {current.callerChannel === "browser" ? "Browser softphone" : "Phone"}</span><span><Clock3 size={15} /> Deadline {new Date(current.callbackDeadlineAt).toLocaleTimeString()}</span><span><ShieldCheck size={15} /> Consent and safety screened</span></div>}
        <div className="ops-tabs" role="tablist" aria-label="Case views"><button role="tab" aria-selected={view === "calls"} onClick={() => setView("calls")}>Provider calls</button><button role="tab" aria-selected={view === "proof"} onClick={() => setView("proof")}>Proof and audit</button></div>
        {notice && <p className="ops-notice" role="status">{notice}</p>}
        {view === "calls" ? <>
          <section className="ops-section" aria-label="Provider call status"><div className="ops-section-head"><h2>Outbound calls</h2><span>{calls.length} commands</span></div>
            <div className="ops-call-head"><span>Provider</span><span>Source and reference</span><span>Status</span><span>Outcome</span></div>
            {calls.map((call) => <div className="ops-call" key={call.id}>
              <strong>{call.providerName}{call.kind === "release_hold_goal" ? " · release" : ""}</strong>
              <div><span className={call.source === "call_e" ? "ops-source live" : "ops-source"}>{call.source === "call_e" ? "LIVE CALL-E" : "FIXTURE"}</span><small>{call.goalRunId ?? "Not accepted yet"}</small>{call.callId && <small>Call {call.callId}</small>}</div>
              <span className="ops-call-status">{call.status.replaceAll("_", " ")}</span>
              <span>{call.outcome?.replaceAll("_", " ") ?? call.error ?? "Awaiting evidence"}</span>
              {call.evidenceSummary && <p>{call.evidenceSummary}</p>}
              {call.transcriptArtifactId && <button className="ops-transcript-button" onClick={() => void openTranscript(call)}>Provider-side transcript</button>}
            </div>)}
            {!calls.length && <p className="ops-empty">No outbound calls for this case yet.</p>}
          </section>
          {current && <section className="ops-section" aria-label="Decision options"><div className="ops-section-head"><h2>One decision</h2><span>{activeHolds.length} active holds</span></div>
            {current.holds.map((hold) => <label className="ops-hold" key={hold.id}>
              <input type="radio" name="operator-hold" checked={selectedHoldId === hold.id} disabled={current.state !== "awaiting_decision" || hold.status !== "active" || Date.parse(hold.expiresAt) <= Date.now()} onChange={() => setSelectedHoldId(hold.id)} />
              <span><strong>{hold.reference}</strong><small>{hold.constraints.join(" · ")}</small></span><em>{hold.status.replaceAll("_", " ")}</em><time>{new Date(hold.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </label>)}
            {current.holds.length === 0 && <p className="ops-empty">Options will appear after provider results are validated.</p>}
            <button className="ops-override" disabled={!selectedHoldId || current.state !== "awaiting_decision"} onClick={() => void overrideDecision()}><Check size={17} /> Commit operator override</button>
            <p className="ops-note">Caller choice is made in the softphone. This command records an attributed operator intervention.</p>
          </section>}
          {transcript && <section className="ops-section ops-transcript" aria-label="Provider-side transcript"><div className="ops-section-head"><h2>{transcript.providerName} · Provider-side transcript</h2><button onClick={() => setTranscript(null)} aria-label="Close provider-side transcript">Close</button></div>{transcript.turns.map((turn, index) => <p key={index}><strong>{turn.speaker}</strong> {turn.text}</p>)}</section>}
          {current && <section className="ops-section ops-timeline" aria-label="Case timeline"><div className="ops-section-head"><h2>Timeline</h2><span>{current.timeline.length} events</span></div><ol>{current.timeline.slice(-8).map((item) => <li key={item.id}><time>{new Date(item.at).toLocaleTimeString()}</time><span>{item.title}</span></li>)}</ol></section>}
        </> : <section className="ops-proof">
          {current && <section className="ops-rehearsal" aria-label="Live CALL-E rehearsal">
            <div className="ops-section-head"><h2>Live CALL-E rehearsal</h2><span>Authorized human answerer · separate from fixture holds</span></div>
            {rehearsal ? <div className="ops-rehearsal-result">
              <p><strong>Call ID</strong> {rehearsal.callId ?? "Acceptance unconfirmed"}</p>
              <p><strong>Status</strong> {rehearsal.status.replaceAll("_", " ")}</p>
              <p><strong>Answered conversation</strong> {rehearsal.verifiedConversation ? "Verified" : rehearsal.answered ? "Answer observed; result incomplete" : "Not verified"}</p>
              <p><strong>Demo code spoken</strong> {rehearsal.caseCodeSpoken ? "Observed" : "Not verified"}</p>
              <p><strong>Synthetic availability</strong> {rehearsal.availability ?? "No structured result"}</p>
              {rehearsal.errorCode && <p><strong>Error</strong> {rehearsal.errorCode}</p>}
              {rehearsal.transcriptAvailable && <button className="ops-transcript-button" onClick={() => void openRehearsalTranscript()}>View audited CALL-E transcript excerpt</button>}
            </div> : <p className="ops-note">No CALL-E rehearsal has been placed for this case.</p>}
            {(!rehearsal || (!rehearsal.callId && rehearsal.status === "pending")) && <div className="ops-rehearsal-action">
              <label>Demo service <select value={rehearsal?.service ?? rehearsalService} onChange={(event) => setRehearsalService(event.target.value as "shelter" | "respite")} disabled={Boolean(rehearsal)}><option value="shelter">Shelter</option><option value="respite">Respite</option></select></label>
              <label className="ops-rehearsal-consent"><input type="checkbox" checked={rehearsalConfirmed} onChange={(event) => setRehearsalConfirmed(event.target.checked)} /> I control the configured number and authorize this outbound AI call.</label>
              <button className="ops-override" disabled={!rehearsalConfigured || !rehearsalConfirmed || rehearsalBusy} onClick={() => void startRehearsal()}><PhoneCall size={17} /> {rehearsal?.status === "pending" ? "Retry same CALL-E call" : "Place CALL-E rehearsal call"}</button>
              {!rehearsalConfigured && <p className="ops-note">Use OIDC sign-in and set a valid CALL_E_API_KEY and CALL_E_DEMO_TARGET_E164 on the Control API to enable this action.</p>}
            </div>}
            {rehearsalTurns && <div className="ops-rehearsal-transcript"><div className="ops-section-head"><h3>CALL-E transcript · authorized human rehearsal</h3><button onClick={() => setRehearsalTurns(null)}>Close</button></div>{rehearsalTurns.map((turn, index) => <p key={index}><strong>{turn.speaker}</strong> {turn.text}</p>)}</div>}
          </section>}
          <div className="ops-proof-top"><div><FileText size={18} /><h2>Case timeline</h2></div><small>Trace {current?.traceId ?? "none"}</small></div>
          <ol>{current?.timeline.map((item) => <li key={item.id}><time>{new Date(item.at).toLocaleTimeString()}</time><div><strong>{item.title}</strong><p>{item.detail}</p></div></li>)}</ol>
          <div className="ops-proof-grid"><div><h3>Command outbox</h3>{outbox.filter((item) => item.caseId === current?.id).map((item) => <p key={item.id}>{item.command.kind.replaceAll("_", " ")} <b>{item.status}</b></p>)}</div><div><h3>Accepted webhooks</h3>{inbox.filter((entry) => outbox.some((item) => item.caseId === current?.id && item.externalRef && JSON.stringify(entry.payload).includes(item.externalRef))).map((entry) => <p key={entry.id}>{entry.source} <b>{entry.processedAt ? "processed" : "pending"}</b></p>)}</div><div><h3><Archive size={16} /> Audit artifacts</h3>{artifacts.filter((item) => item.caseId === current?.id).map((item) => <p key={item.id}>{item.artifactType.replaceAll("_", " ")} <b>{item.deletionStatus}</b></p>)}</div></div>
        </section>}
      </section>
    </div>
  </main>;
}
