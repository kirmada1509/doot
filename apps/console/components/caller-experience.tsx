"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Delete, Headphones, Mic, MicOff, Phone, PhoneOff, ShieldCheck } from "lucide-react";
import type { DootCase } from "@doot/contracts";

type ProviderCall = {
  id: string; providerName: string; kind: "provider_hold_goal" | "release_hold_goal";
  source: "fixture" | "call_e"; status: string; goalRunId: string | null;
  outcome: string | null; evidenceSummary: string | null; error: string | null;
};
type Progress = { case: DootCase | null; calls: ProviderCall[]; service: string };
type Line = { speaker: "Doot" | "You"; text: string };
type CallState = "idle" | "connecting" | "consent" | "listening" | "working" | "ended";
const apiBase = process.env.NEXT_PUBLIC_DOOT_API_URL ?? "/api/control";
const dialCode = process.env.NEXT_PUBLIC_DEMO_DIAL_CODE ?? "4040";

export function CallerExperience() {
  const [digits, setDigits] = useState("");
  const [service, setService] = useState<"shelter" | "respite">("shelter");
  const [language, setLanguage] = useState<"en" | "hi" | "hinglish">("en");
  const [state, setState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);
  const [recordingAccepted, setRecordingAccepted] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [meter, setMeter] = useState(0);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<"fixture" | "live">("fixture");
  const socket = useRef<WebSocket | null>(null);
  const context = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const processor = useRef<AudioWorkletNode | null>(null);
  const playback = useRef<AudioBufferSourceNode | null>(null);
  const speechAt = useRef(0);
  const inSpeech = useRef(false);
  const turnInFlight = useRef(false);
  const lastTurn = useRef(0);
  const lastAnnouncement = useRef("");
  const mutedRef = useRef(false);

  function speakFixture(text: string) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language === "hi" ? "hi-IN" : "en-IN";
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
  }

  const refresh = useCallback(async (token: string) => {
    const response = await fetch(`${apiBase}/v1/caller/sessions/${token}`, { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json() as Progress;
    setProgress(next);
    const phase = next.case?.state;
    if (phase && ["awaiting_decision", "resolved", "no_options", "manual_review"].includes(phase) &&
        phase !== lastAnnouncement.current && socket.current?.readyState === WebSocket.OPEN) {
      lastAnnouncement.current = phase;
      socket.current.send(JSON.stringify({ event: "announce" }));
    }
  }, []);

  useEffect(() => {
    if (!sessionToken) return;
    const timer = window.setInterval(() => void refresh(sessionToken), 1800);
    return () => window.clearInterval(timer);
  }, [sessionToken, refresh]);

  useEffect(() => () => {
    socket.current?.close();
    stream.current?.getTracks().forEach((track) => track.stop());
    void context.current?.close();
  }, []);

  async function playPcm(base64: string) {
    const audioContext = context.current ?? new AudioContext();
    context.current = audioContext;
    await audioContext.resume();
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    if (bytes.byteLength < 2) return;
    const view = new DataView(bytes.buffer);
    const buffer = audioContext.createBuffer(1, Math.floor(bytes.byteLength / 2), 8000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i += 1) channel[i] = view.getInt16(i * 2, true) / 32768;
    try { playback.current?.stop(); } catch { /* playback already ended */ }
    const node = audioContext.createBufferSource();
    node.buffer = buffer;
    node.connect(audioContext.destination);
    node.start();
    playback.current = node;
  }

  async function connect() {
    if (digits !== dialCode) {
      setError(`Dial the browser demo line: ${dialCode}.`);
      return;
    }
    setError("");
    setState("connecting");
    try {
      const response = await fetch(`${apiBase}/v1/caller/sessions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ dialedNumber: digits, service, language })
      });
      if (!response.ok) throw new Error("Could not connect to the demo line.");
      const created = await response.json() as { sessionToken: string; sessionUrl: string; voiceMode: "fixture" | "live" };
      setSessionToken(created.sessionToken);
      setVoiceMode(created.voiceMode);
      const ws = new WebSocket(created.sessionUrl);
      socket.current = ws;
      ws.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as Record<string, unknown>;
          if (event.event === "speak" && typeof event.text === "string") {
            setLines((old) => [...old, { speaker: "Doot", text: String(event.text) }]);
            setState("consent");
            if (created.voiceMode === "fixture") speakFixture(event.text);
          }
          if (event.event === "media" && typeof event.payload === "string") void playPcm(event.payload);
          if (event.event === "transcript") {
            turnInFlight.current = false;
            if (typeof event.transcript === "string") setLines((old) => [...old, { speaker: "You", text: String(event.transcript) }]);
            if (typeof event.text === "string") {
              setLines((old) => [...old, { speaker: "Doot", text: String(event.text) }]);
              if (created.voiceMode === "fixture") speakFixture(event.text);
            }
            setState("working");
            void refresh(created.sessionToken);
          }
          if (event.event === "announcement" && typeof event.text === "string") {
            setLines((old) => [...old, { speaker: "Doot", text: String(event.text) }]);
            if (created.voiceMode === "fixture") speakFixture(event.text);
          }
          if (event.event === "safety_handoff") {
            if (typeof event.text === "string") setLines((old) => [...old, { speaker: "Doot", text: String(event.text) }]);
            setState("ended");
          }
          if (event.event === "provider_error" || event.event === "intake_error") {
            setError("A voice service could not complete this turn. Check Operations for case status.");
            turnInFlight.current = false;
          }
          if (event.event === "clear") {
            try { playback.current?.stop(); } catch { /* already stopped */ }
          }
        } catch { setError("The call returned an unreadable event."); }
      };
      ws.onclose = () => setState("ended");
      ws.onerror = () => setError("The voice connection was interrupted.");
    } catch (reason) {
      setState("idle");
      setError(reason instanceof Error ? reason.message : "Could not connect.");
    }
  }

  async function acceptConsent() {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) return;
    socket.current.send(JSON.stringify({ event: "consent", accepted: true, recordingAccepted }));
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      } });
      stream.current = media;
      const audioContext = context.current ?? new AudioContext();
      context.current = audioContext;
      await audioContext.resume();
      await audioContext.audioWorklet.addModule("/audio-capture-worklet.js");
      const input = audioContext.createMediaStreamSource(media);
      const capture = new AudioWorkletNode(audioContext, "doot-capture");
      processor.current = capture;
      input.connect(capture);
      capture.connect(audioContext.destination);
      capture.port.onmessage = (message: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        if (mutedRef.current || turnInFlight.current || socket.current?.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        const rms = message.data.rms;
        setMeter(Math.min(1, rms * 12));
        if (rms > 0.018) {
          if (voiceMode === "fixture") window.speechSynthesis?.cancel();
          speechAt.current = now;
          inSpeech.current = true;
          try { playback.current?.stop(); } catch { /* already stopped */ }
          playback.current = null;
        }
        if (inSpeech.current) socket.current.send(message.data.pcm);
        if (inSpeech.current && now - speechAt.current > 950 && now - lastTurn.current > 1400) {
          socket.current.send(JSON.stringify({ event: "end_turn" }));
          turnInFlight.current = true;
          inSpeech.current = false;
          lastTurn.current = now;
          setState("working");
        }
      };
      setState("listening");
    } catch {
      setError("Microphone access is required. Allow it in your browser and try again.");
      setState("consent");
    }
  }

  async function chooseHold(holdId: string) {
    if (!sessionToken || !progress?.case) return;
    const response = await fetch(`${apiBase}/v1/caller/sessions/${sessionToken}/decision`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectedHoldId: holdId, caseVersion: progress.case.decisionVersion ?? progress.case.version })
    });
    if (!response.ok) {
      setError("That option changed or expired. Review the current choices.");
      await refresh(sessionToken);
      return;
    }
    setError("");
    await refresh(sessionToken);
  }

  function endCall() {
    window.speechSynthesis?.cancel();
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ event: "stop" }));
    socket.current?.close();
    stream.current?.getTracks().forEach((track) => track.stop());
    processor.current?.disconnect();
    setState("ended");
  }

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    stream.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }

  const activeHolds = progress?.case?.holds.filter((hold) => hold.status === "active" && Date.parse(hold.expiresAt) > Date.now()) ?? [];
  return <main className="caller">
    <header className="caller-header">
      <div className="caller-brand"><span className="caller-mark">दू</span><strong>Doot</strong><span>browser call</span></div>
      <a href="/ops">Operations <ArrowRight size={16} /></a>
    </header>
    <div className="caller-layout">
      <section className="caller-main" aria-label="Browser softphone">
        <div className="caller-intro"><p className="caller-kicker">DEMO LINE · NOT A CELLULAR CALL</p><h1>Call Doot</h1><p>Speak with the coordination agent, then choose a provider-confirmed demo option.</p></div>
        {state === "idle" ? <div className="dialer" key="dialer">
          <div className="service-switch" aria-label="Service">
            <button className={service === "shelter" ? "selected" : ""} onClick={() => setService("shelter")}>Shelter</button>
            <button className={service === "respite" ? "selected" : ""} onClick={() => setService("respite")}>Respite</button>
          </div>
          <label className="dial-label" htmlFor="dial-number">Doot demo line</label>
          <input id="dial-number" type="tel" inputMode="numeric" value={digits} onChange={(event) => setDigits(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder={dialCode} />
          <div className="dial-grid">{["1","2","3","4","5","6","7","8","9","","0","back"].map((digit) =>
            digit === "" ? <span key="spacer" /> : digit === "back"
              ? <button key={digit} onClick={() => setDigits((value) => value.slice(0, -1))} aria-label="Delete digit"><Delete size={21} /></button>
              : <button key={digit} onClick={() => setDigits((value) => (value + digit).slice(0, 8))} aria-label={`Dial ${digit}`}>{digit}</button>
          )}</div>
          <div className="dial-footer"><label htmlFor="call-language">Language</label><select id="call-language" value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>
            <option value="en">English</option><option value="hi">Hindi</option><option value="hinglish">Hinglish</option>
          </select></div>
          <button className="call-button" onClick={() => void connect()}><Phone size={19} /> Call demo line</button>
        </div> : <div className="call-active" key="active-call">
          <div className="call-identity"><span className="call-avatar"><Headphones size={28} /></span><div><strong>Doot AI agent</strong><span>{state === "connecting" ? "Connecting" : state === "ended" ? "Call ended" : state === "consent" ? "Consent needed" : "In call"}</span></div></div>
          <div className="call-wave" aria-label={muted ? "Microphone muted" : "Microphone level"}>{[18,28,16,24,18].map((base, index) => <span key={index} style={{ height: `${base + meter * 44}px` }} />)}</div>
          {state === "consent" ? <div className="consent">
            <p><ShieldCheck size={17} /> Doot is an AI coordination demo, not emergency dispatch. The spoken disclosure explains recording and deletion.</p>
            <label><input type="checkbox" checked={recordingAccepted} onChange={(event) => setRecordingAccepted(event.target.checked)} /> Allow call recording for the audit demo</label>
            <button onClick={() => void acceptConsent()}>I agree and continue</button>
          </div> : null}
          <div className="call-controls">
            <button onClick={toggleMute} disabled={!stream.current || state === "ended"} aria-label={muted ? "Unmute microphone" : "Mute microphone"} title={muted ? "Unmute" : "Mute"}>{muted ? <MicOff size={20} /> : <Mic size={20} />}</button>
            <button className="hangup" onClick={endCall} disabled={state === "ended"} aria-label="End call" title="End call"><PhoneOff size={20} /></button>
          </div>
          {voiceMode === "fixture" && state === "listening" && !progress?.case && <button className="fixture-request" onClick={() => socket.current?.send(JSON.stringify({ event: "transcript", text: service === "shelter" ? "I need a wheelchair accessible shelter tonight" : "I need respite care tonight" }))}>Use fixture spoken request</button>}
        </div>}
        {error ? <p className="caller-error" role="alert">{error}</p> : null}
        <div className="caller-boundary"><ShieldCheck size={17} /> Immediate danger? Call 112 or 108. Doot does not dispatch emergencies.</div>
      </section>
      <section className="caller-work" aria-label="Call progress">
        <div className="work-head"><div><p className="caller-kicker">CASE PROGRESS</p><h2>{progress?.case?.state === "resolved" ? "Choice confirmed" : progress?.case?.state === "no_options" ? "No option confirmed" : progress?.case?.state === "manual_review" ? "Needs human review" : progress?.case ? "Finding your options" : "Ready when you are"}</h2></div><span className="source-tag">{voiceMode === "live" ? "Live voice" : "Fixture voice"}</span></div>
        <div className="flow-steps">{["Understand need", "Check providers", "Compare options", "Confirm choice"].map((label, index) =>
          <div key={label} className={progress?.case && (index === 0 || progress.case.state === "resolved" || (index === 1 && progress.calls.length > 0) || (index === 2 && activeHolds.length > 0)) ? "step done" : "step"}><span>{index + 1}</span>{label}</div>
        )}</div>
        {progress?.calls.length ? <div className="caller-providers"><h3>Provider checks</h3>{progress.calls.filter((call) => call.kind === "provider_hold_goal").map((call) =>
          <div className="provider-line" key={call.id}><div><strong>{call.providerName}</strong><small>{call.source === "call_e" ? "Live CALL-E" : "Fixture"}{call.goalRunId ? ` · ${call.goalRunId}` : ""}</small>{call.error ? <small>{call.error}</small> : null}</div><span>{call.outcome?.replaceAll("_", " ") ?? call.status.replaceAll("_", " ")}</span></div>
        )}</div> : null}
        {progress?.case?.state === "awaiting_decision" && activeHolds.length ? <div className="caller-options"><h3>Choose one option</h3>{activeHolds.map((hold) =>
          <button key={hold.id} onClick={() => void chooseHold(hold.id)}><strong>{hold.reference}</strong><span>{hold.constraints.join(" · ")}</span><small>Expires {new Date(hold.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small><ArrowRight size={18} /></button>
        )}</div> : null}
        {progress?.case?.state === "no_options" ? <p className="caller-outcome">No demo reservation was made. Check Operations for provider failure or timeout details.</p> : null}
        {progress?.case?.state === "manual_review" ? <p className="caller-outcome">A human must review this case before any reservation can be confirmed.</p> : null}
        {progress?.case?.state === "resolved" ? <div className="caller-confirmed"><strong>Choice recorded</strong><span>{progress.case.holds.find((hold) => hold.status === "committed")?.reference ?? "Selected demo hold"} committed. {progress.case.holds.filter((hold) => hold.status === "released").map((hold) => hold.reference).join(", ") || "No alternatives"} released.</span></div> : null}
        <div className="conversation"><h3>Conversation</h3><div className="conversation-lines" aria-live="polite">{lines.length ? lines.map((line, index) =>
          <div className={line.speaker === "You" ? "spoken caller-spoken" : "spoken"} key={index}><strong>{line.speaker}</strong><p>{line.text}</p></div>
        ) : <p className="conversation-empty">The conversation appears here when the call starts.</p>}</div></div>
      </section>
    </div>
  </main>;
}
