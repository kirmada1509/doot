import asyncio
import base64
import binascii
import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.adapters import build_agent_adapter, build_stt_adapter, build_tts_adapter, provider_mode, session_plan, voice_capabilities
from app.control_client import archive_case_artifact, browser_case_progress, create_case_from_intake, lookup_voice_session, signal_safety_handoff
from app.provider_answerer import DemoInventory, provider_stream


def verify_live_voice_configuration():
    if provider_mode() != "live":
        if os.getenv("COMMUNICATION_MODE", "mock") == "live":
            raise RuntimeError("Real CALL-E provider calls require VOICE_PROVIDER_MODE=live for the AI answerers")
        return
    build_stt_adapter()
    build_tts_adapter()
    build_agent_adapter()
    import boto3

    if boto3.Session().get_credentials() is None:
        raise RuntimeError("VOICE_PROVIDER_MODE=live requires an AWS credential source for Bedrock")
    if os.getenv("COMMUNICATION_MODE", "mock") == "live":
        try:
            phone_map = json.loads(os.getenv("PROVIDER_ANSWERER_PHONE_MAP_JSON", "{}"))
        except json.JSONDecodeError as error:
            raise RuntimeError("Provider answerer phone map must be JSON") from error
        if (len(os.getenv("PROVIDER_ANSWERER_TOKEN", "")) < 24 or
            os.getenv("EXOTEL_ACCOUNT_SID", "") in {"", "demo-exotel-sid", "replace-me"} or
            any(not str(phone_map.get(provider, "")).startswith("+") for provider in ["provider_lotus", "provider_ashraya"])):
            raise RuntimeError("Live answerers require Exotel account, both authorized DIDs, and a strong answerer token")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    verify_live_voice_configuration()
    yield


app = FastAPI(title="Doot Voice Runtime", version="0.1.0", lifespan=lifespan)


class IntakeUtterance(BaseModel):
    case_id: str
    caller_phone_blind_index: str = "demo-blind-index"
    utterance: str
    language_hint: Literal["en", "hi", "hinglish"] = "hinglish"
    existing_reference: Optional[str] = None
    turn_index: int = 0


class VoiceTurn(BaseModel):
    case_id: str
    utterance: str
    language_hint: Literal["en", "hi", "hinglish"] = "hinglish"
    turn_index: int = 0
    mode: Optional[Literal["urgent", "planning", "existing"]] = None


class VoiceSessionPlanRequest(BaseModel):
    call_sid: str
    language_hint: Literal["en", "hi", "hinglish"] = "hinglish"


class VoiceSession:
    def __init__(
        self,
        session_token: str,
        call_sid: str,
        language_hint: str,
        caller_phone_blind_index: str,
        channel: str = "phone",
        service: str = "shelter",
    ):
        self.session_token = session_token
        self.call_sid = call_sid
        self.language_hint = language_hint
        self.caller_phone_blind_index = caller_phone_blind_index
        self.channel = channel
        self.service = service
        self.turn_index = 0
        self.mode = None
        self.active = True
        self.disclosure_spoken = False
        self.consent_accepted = False
        self.recording_accepted = False
        self.case_id = None
        self.case_created = False
        self.audio_buffer = bytearray()
        self.recording_buffer = bytearray()

    def start(self):
        self.disclosure_spoken = True
        return {
            "event": "speak",
            "sessionToken": self.session_token,
            "callSid": self.call_sid,
            "text": DISCLOSURE[self.language_hint],
            "recordingNotice": True,
            "consentRequired": True,
        }

    def handle_transcript(self, utterance: str, existing_reference: Optional[str] = None):
        if not self.active:
            return {"event": "closed", "callSid": self.call_sid, "sessionToken": self.session_token}

        if not self.consent_accepted:
            return {"event": "consent_required", "sessionToken": self.session_token, "callSid": self.call_sid}

        self.turn_index += 1
        lowered = normalize(utterance)
        escalation = has_any(lowered, SAFETY_TERMS)
        if escalation:
            self.active = False
            if self.case_id:
                signal_safety_handoff(self.case_id)
            return {
                "event": "safety_handoff",
                "sessionToken": self.session_token,
                "callSid": self.call_sid,
                "turnIndex": self.turn_index,
                "continueCoordination": False,
                "text": MID_CALL_HANDOFF[self.language_hint],
            }

        self.mode = self.mode or classify_mode(lowered, existing_reference)
        case_payload = None
        if self.disclosure_spoken and not self.case_created:
            case_payload = self._persist_consented_intake(utterance, existing_reference)
            if case_payload.get("error"):
                return {
                    "event": "intake_error",
                    "sessionToken": self.session_token,
                    "callSid": self.call_sid,
                    "continueCoordination": False,
                    "code": "CASE_PERSISTENCE_FAILED",
                }

        return {
            "event": "transcript",
            "sessionToken": self.session_token,
            "callSid": self.call_sid,
            "turnIndex": self.turn_index,
            "mode": self.mode,
            "caseId": self.case_id,
            "caseCreated": self.case_created,
            "workflowStarted": bool((case_payload or {}).get("workflow", {}).get("started")),
            "transcript": utterance,
            "text": ("I have your request. I am checking Lotus and Ashraya now; stay on this browser call while I find options."
                     if self.channel == "browser" else CALLBACK_PROMPT[self.language_hint]),
            "continueCoordination": True,
        }

    def handle_consent(self, accepted: bool, recording_accepted: bool):
        self.consent_accepted = accepted
        self.recording_accepted = accepted and recording_accepted
        if not accepted:
            self.active = False
            self.audio_buffer.clear()
            self.recording_buffer.clear()
        return {
            "event": "consent_recorded",
            "sessionToken": self.session_token,
            "callSid": self.call_sid,
            "accepted": self.consent_accepted,
            "recordingAccepted": self.recording_accepted,
            "continueCoordination": self.consent_accepted,
        }

    def _persist_consented_intake(self, utterance: str, existing_reference: Optional[str]):
        requested_for = "someone_else" if has_any(normalize(utterance), THIRD_PARTY_TERMS) else "unknown"
        try:
            created = create_case_from_intake(
                {
                    "callSid": self.call_sid,
                    "callerPhoneBlindIndex": self.caller_phone_blind_index,
                    "consentAccepted": self.consent_accepted,
                    "recordingAccepted": self.recording_accepted,
                    "utterance": utterance,
                    "languageHint": self.language_hint,
                    "requestedFor": requested_for,
                    "sessionToken": self.session_token if self.channel == "browser" else None,
                    "service": self.service,
                    "requestedTimeframe": "now" if self.channel == "browser" else None,
                    "existingReference": existing_reference,
                    "accessibilityNeeds": ["wheelchair"] if "wheelchair" in normalize(utterance) else [],
                }
            )
            self.case_created = True
            self.case_id = created.get("case", {}).get("id")
            return created
        except Exception as error:  # noqa: BLE001 - keep the call alive; surface failure to Exotel side
            return {"error": str(error), "workflow": {"started": False}}

    def handle_media(self, payload):
        if self.channel == "browser" and not self.consent_accepted:
            return {"event": "consent_required", "sessionToken": self.session_token}
        try:
            audio = base64.b64decode(payload, validate=True) if isinstance(payload, str) else bytes(payload)
        except (binascii.Error, ValueError, TypeError):
            return {"event": "error", "code": "INVALID_MEDIA_PAYLOAD"}
        self.audio_buffer.extend(audio)
        if self.recording_accepted:
            self.recording_buffer.extend(audio)
        return {
            "event": "media_ack",
            "sessionToken": self.session_token,
            "callSid": self.call_sid,
            "sampleRateHz": 8000,
            "bytes": len(audio),
        }

    async def finish_audio_turn(self, stt, agent):
        if not self.consent_accepted:
            return {"event": "consent_required", "sessionToken": self.session_token, "callSid": self.call_sid}
        if not self.audio_buffer:
            return {"event": "error", "code": "EMPTY_AUDIO_TURN"}
        audio = bytes(self.audio_buffer)
        self.audio_buffer.clear()
        transcript = await stt.transcribe(audio, self.language_hint)
        result = await asyncio.to_thread(self.handle_transcript, transcript.text)
        if result.get("event") != "transcript":
            return result
        proposal = await agent.propose(transcript.text, self.language_hint, str(self.mode or "planning"))
        result["transcript"] = transcript.text
        result["text"] = result["text"] if self.channel == "browser" else proposal.response_text
        result["providers"] = {"stt": "deepgram-flux", "agent": "strands-bedrock"}
        if self.case_id and self.recording_buffer:
            recording = bytes(self.recording_buffer)
            self.recording_buffer.clear()
            await asyncio.to_thread(archive_case_artifact, self.case_id, "recording", recording, "audio/L16;rate=8000;channels=1")
        return result


SAFETY_TERMS = {
    "suicide",
    "kill myself",
    "heart attack",
    "not breathing",
    "life-threatening",
    "jaan khatra",
    "khud ko nuksan",
    "saans nahi",
}
URGENT_TERMS = {"tonight", "now", "today", "urgent", "abhi", "aaj", "within hours", "raat", "turant"}
PLANNING_TERMS = {"next week", "planning", "exploring", "later", "kal", "agle hafte", "baad mein"}
CALLBACK_TERMS = {"call back", "callback", "phone later", "baad mein call", "wapas call"}
THIRD_PARTY_TERMS = {"my friend", "my mother", "my sister", "someone else", "mere dost", "meri maa"}

DISCLOSURE = {
    "en": "Hi, I am Doot, an AI coordination agent. I can record this call to find options, keep the record for 365 days, and you can ask for deletion later. If this is life-threatening, call 112 or 108 now.",
    "hi": "Namaste, main Doot hoon, ek AI coordination agent. Main options dhoondhne ke liye call record kar sakta hoon, record 365 din tak rakha ja sakta hai, aur aap baad mein deletion maang sakte hain. Agar jaan ko khatra hai, abhi 112 ya 108 par call kijiye.",
    "hinglish": "Hi, main Doot hoon, ek AI coordination agent. Main options dhoondhne ke liye call record kar sakta hoon, record 365 days tak rakha ja sakta hai, aur aap deletion maang sakte hain. Agar life-threatening emergency hai, abhi 112 ya 108 call kijiye.",
}

CALLBACK_PROMPT = {
    "en": "I will call you back with up to three real options, then ask you to choose one.",
    "hi": "Main aapko teen tak real options ke saath wapas call karunga, phir ek choice confirm karunga.",
    "hinglish": "Main aapko up to three real options ke saath callback karunga, phir aapse ek choice confirm karunga.",
}

MID_CALL_HANDOFF = {
    "en": "I need to pause coordination. If there is immediate danger, call 112 or 108 now.",
    "hi": "Mujhe coordination rokna hoga. Agar turant khatra hai, abhi 112 ya 108 call kijiye.",
    "hinglish": "Mujhe coordination pause karna hoga. Agar immediate danger hai, abhi 112 ya 108 call kijiye.",
}


@app.get("/health/live")
def live():
    return {"ok": True, "service": "voice-runtime"}


@app.get("/health/dependencies")
def dependencies():
    return {"dependencies": voice_capabilities()}


@app.post("/v1/voice/session/plan")
def plan_session(payload: VoiceSessionPlanRequest):
    return session_plan(payload.call_sid, payload.language_hint)


@app.websocket("/v1/telephony/exotel/stream/{session_token}")
async def exotel_stream(websocket: WebSocket, session_token: str):
    await run_stream(websocket, session_token, "phone")


@app.websocket("/v1/browser/stream/{session_token}")
async def browser_stream(websocket: WebSocket, session_token: str):
    await run_stream(websocket, session_token, "browser")


@app.websocket("/v1/telephony/exotel/provider/{provider_id}/stream")
async def exotel_provider_stream(websocket: WebSocket, provider_id: str):
    await provider_stream(websocket, provider_id)


@app.get("/v1/internal/provider-holds/verify")
def verify_provider_hold(providerId: str, caseCode: str, reference: str, authorization: str = Header(default="")):
    if authorization != f"Bearer {os.getenv('INTERNAL_SERVICE_TOKEN', 'doot-local-service-token')}":
        raise HTTPException(status_code=401, detail="Invalid service credential")
    if providerId not in {"provider_lotus", "provider_ashraya"} or re.fullmatch(r"\d{6}", caseCode) is None:
        raise HTTPException(status_code=400, detail="Invalid hold identity")
    ledger = DemoInventory(os.getenv("PROVIDER_LEDGER_PATH", "/tmp/doot-provider-ledger.sqlite3"))
    return ledger.read(providerId, caseCode, reference) or {"status": "missing", "expiresAt": None}


async def run_stream(websocket: WebSocket, session_token: str, channel: str):
    session_meta = lookup_voice_session(session_token)
    if session_meta is None or session_meta.get("channel", "phone") != channel:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    language_hint = websocket.query_params.get("language") or session_meta.get("language") or "hinglish"
    if language_hint not in DISCLOSURE:
        language_hint = "hinglish"
    session = VoiceSession(
        session_token=session_token,
        call_sid=str(session_meta.get("callSid") or session_token),
        language_hint=language_hint,
        caller_phone_blind_index=str(session_meta.get("callerPhoneBlindIndex") or f"blind_{session_token}"),
        channel=channel,
        service=str(session_meta.get("service") or "shelter"),
    )
    stt = build_stt_adapter()
    tts = build_tts_adapter()
    agent = build_agent_adapter()
    pending_speech = None
    last_announced_state = None
    await websocket.send_json(session.start())
    if channel == "browser" and provider_mode() == "live":
        try:
            disclosure_audio = await tts.synthesize(DISCLOSURE[session.language_hint], session.language_hint)
            await websocket.send_json({
                "event": "media",
                "encoding": "linear16",
                "sampleRateHz": 8000,
                "payload": base64.b64encode(disclosure_audio).decode("ascii"),
            })
        except Exception:
            await websocket.send_json({"event": "provider_error", "provider": "elevenlabs"})
    try:
        while session.active:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("text"):
                payload = json.loads(message["text"])
                event = payload.get("event")
                if event == "transcript":
                    if channel == "browser" and provider_mode() == "live":
                        await websocket.send_json({"event": "error", "code": "AUDIO_REQUIRED"})
                        continue
                    await websocket.send_json(
                        await asyncio.to_thread(
                            session.handle_transcript,
                            str(payload.get("text", "")),
                            payload.get("existingReference"),
                        )
                    )
                elif event == "consent":
                    accepted = payload.get("accepted")
                    recording_accepted = payload.get("recordingAccepted")
                    if not isinstance(accepted, bool) or not isinstance(recording_accepted, bool):
                        await websocket.send_json({"event": "error", "code": "INVALID_CONSENT_EVENT"})
                        continue
                    await websocket.send_json(session.handle_consent(accepted, recording_accepted))
                elif event == "media":
                    if pending_speech and not pending_speech.done():
                        pending_speech.cancel()
                        await websocket.send_json({"event": "clear", "reason": "barge_in"})
                    await websocket.send_json(session.handle_media(payload.get("payload", "")))
                elif event in {"end_turn", "dtmf"}:
                    result = await session.finish_audio_turn(stt, agent)
                    await websocket.send_json(result)
                    if result.get("event") == "transcript" and result.get("text") and provider_mode() == "live":
                        async def deliver_speech(text: str):
                            try:
                                audio = await tts.synthesize(text, session.language_hint)
                                await websocket.send_json({
                                    "event": "media",
                                    "encoding": "linear16",
                                    "sampleRateHz": 8000,
                                    "payload": base64.b64encode(audio).decode("ascii"),
                                })
                            except asyncio.CancelledError:
                                raise
                            except Exception:
                                await websocket.send_json({"event": "provider_error", "provider": "elevenlabs"})
                        pending_speech = asyncio.create_task(deliver_speech(str(result["text"])))
                elif event == "stop":
                    break
                elif event == "announce" and channel == "browser":
                    snapshot = await asyncio.to_thread(browser_case_progress, session_token)
                    current = snapshot.get("case") or {}
                    state = current.get("state")
                    if state == last_announced_state:
                        continue
                    if state == "awaiting_decision":
                        holds = [item for item in current.get("holds", []) if item.get("status") == "active"]
                        def spoken_expiry(item):
                            try:
                                value = datetime.fromisoformat(str(item.get("expiresAt", "")).replace("Z", "+00:00"))
                                return value.astimezone(timezone.utc).strftime("%H:%M UTC")
                            except ValueError:
                                return "soon"
                        choices = "; ".join(
                            f"Option {index + 1}: {item.get('reference')}, expires at {spoken_expiry(item)}"
                            for index, item in enumerate(holds[:3])
                        )
                        announcement = f"I found {len(holds)} demo options. {choices}. Please choose one."
                    elif state == "resolved":
                        selected = next((item for item in current.get("holds", []) if item.get("status") == "committed"), None)
                        announcement = f"Your demo reservation {selected.get('reference')} is confirmed." if selected else "Your decision is recorded."
                    elif state == "no_options":
                        announcement = "I could not confirm an available option. No reservation was made."
                    elif state == "manual_review":
                        announcement = "This needs human review. I cannot confirm a reservation yet."
                    else:
                        continue
                    last_announced_state = state
                    await websocket.send_json({"event": "announcement", "text": announcement})
                    if provider_mode() == "live":
                        audio = await tts.synthesize(announcement, session.language_hint)
                        await websocket.send_json({
                            "event": "media",
                            "encoding": "linear16",
                            "sampleRateHz": 8000,
                            "payload": base64.b64encode(audio).decode("ascii"),
                        })
            elif message.get("bytes") is not None:
                if pending_speech and not pending_speech.done():
                    pending_speech.cancel()
                    await websocket.send_json({"event": "clear", "reason": "barge_in"})
                await websocket.send_json(session.handle_media(message["bytes"]))
    except WebSocketDisconnect:
        return
    finally:
        if pending_speech and not pending_speech.done():
            pending_speech.cancel()


@app.post("/v1/voice/intake/screen")
def screen_intake(payload: IntakeUtterance):
    lowered = normalize(payload.utterance)
    escalation = has_any(lowered, SAFETY_TERMS)
    mode = classify_mode(lowered, payload.existing_reference)
    requested_for = "someone_else" if has_any(lowered, THIRD_PARTY_TERMS) else "unknown"
    return {
        "caseId": payload.case_id,
        "at": datetime.now(timezone.utc).isoformat(),
        "language": payload.language_hint,
        "mode": mode,
        "disclosureScript": DISCLOSURE[payload.language_hint],
        "callbackScript": CALLBACK_PROMPT[payload.language_hint],
        "requestedFor": requested_for,
        "shouldHangUpForCallback": mode in {"urgent", "planning"} and has_any(lowered, CALLBACK_TERMS | URGENT_TERMS),
        "safetyEscalation": escalation,
        "handoffScript": "If this is life-threatening, call 112 or 108 now. Doot is a coordination line, not emergency dispatch."
        if escalation
        else None,
    }


@app.post("/v1/voice/turn/safety")
def monitor_turn(payload: VoiceTurn):
    lowered = normalize(payload.utterance)
    escalation = has_any(lowered, SAFETY_TERMS)
    return {
        "caseId": payload.case_id,
        "at": datetime.now(timezone.utc).isoformat(),
        "turnIndex": payload.turn_index,
        "midCallEscalation": escalation,
        "continueCoordination": not escalation,
        "handoffScript": MID_CALL_HANDOFF[payload.language_hint] if escalation else None,
    }


def classify_mode(utterance: str, existing_reference: Optional[str]):
    if existing_reference:
        return "existing"
    if has_any(utterance, URGENT_TERMS):
        return "urgent"
    if has_any(utterance, PLANNING_TERMS):
        return "planning"
    return "planning"


def has_any(utterance: str, terms: set[str]):
    return any(term in utterance for term in terms)


def normalize(value: str):
    return " ".join(value.lower().strip().split())
