import asyncio
import audioop
import base64
import hmac
import json
import os
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import WebSocket, WebSocketDisconnect

from app.adapters import build_stt_adapter, build_tts_adapter, provider_mode
from app.control_client import control_api_url, service_token


PROVIDERS = {"provider_lotus": "Lotus", "provider_ashraya": "Ashraya"}
CODE_PATTERN = re.compile(r"(?<!\d)(\d(?:[\s-]?\d){5})(?!\d)")
REFERENCE_PATTERN = re.compile(r"\b(LOTUS|ASHRAYA)[- ]?(\d{6})\b", re.IGNORECASE)


class DemoInventory:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("create table if not exists holds (reference text primary key, provider_id text not null, case_code text not null, service text not null, expires_at text not null, status text not null)")

    def connect(self):
        return sqlite3.connect(self.path, timeout=5)

    def hold(self, provider_id: str, case_code: str, service: str):
        reference = f"{PROVIDERS[provider_id].upper()}-{case_code}"
        with self.connect() as db:
            db.execute("begin immediate")
            existing = db.execute("select expires_at, status from holds where reference = ?", (reference,)).fetchone()
            if existing:
                if existing[1] == "active" and datetime.fromisoformat(existing[0]) > datetime.now(timezone.utc):
                    return {"reference": reference, "expiresAt": existing[0], "status": "active"}
                return {"reference": reference, "expiresAt": existing[0], "status": existing[1]}
            active_count = db.execute("select count(*) from holds where provider_id = ? and status = 'active' and expires_at > ?", (provider_id, datetime.now(timezone.utc).isoformat())).fetchone()[0]
            if active_count >= 2:
                return {"reference": reference, "expiresAt": None, "status": "full"}
            expiry = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
            db.execute("insert into holds values (?, ?, ?, ?, ?, 'active')", (reference, provider_id, case_code, service, expiry))
            return {"reference": reference, "expiresAt": expiry, "status": "active"}

    def release(self, provider_id: str, reference: str):
        with self.connect() as db:
            db.execute("begin immediate")
            row = db.execute("select status from holds where reference = ? and provider_id = ?", (reference, provider_id)).fetchone()
            if not row:
                return False
            if row[0] == "released":
                return True
            if row[0] != "active":
                return False
            db.execute("update holds set status = 'released' where reference = ?", (reference,))
            return True

    def read(self, provider_id: str, case_code: str, reference: str):
        with self.connect() as db:
            row = db.execute("select status, expires_at from holds where provider_id = ? and case_code = ? and reference = ?", (provider_id, case_code, reference)).fetchone()
        return {"status": row[0], "expiresAt": row[1]} if row else None


def resolve_case(code: str):
    response = httpx.get(f"{control_api_url()}/v1/internal/demo-cases/{code}", headers={"authorization": f"Bearer {service_token()}"}, timeout=3)
    if response.status_code != 200:
        return None
    return response.json()


def archive_turns(case_id: str, case_code: str, provider_id: str, stream_sid: str, kind: str, turns):
    response = httpx.post(
        f"{control_api_url()}/v1/internal/provider-transcripts",
        headers={"authorization": f"Bearer {service_token()}"},
        json={"caseId": case_id, "caseCode": case_code, "providerId": provider_id, "streamSid": stream_sid, "kind": kind, "turns": turns},
        timeout=10,
    )
    response.raise_for_status()


def provider_reply(provider_id: str, transcript: str, ledger: DemoInventory, case_lookup=resolve_case):
    normalized = transcript.lower()
    reference_match = REFERENCE_PATTERN.search(transcript)
    code_match = CODE_PATTERN.search(transcript)
    code = re.sub(r"\D", "", code_match.group(1)) if code_match else reference_match.group(2) if reference_match else None
    if not code:
        return None, "Please say the six-digit Doot demo case code so I can check the synthetic inventory."
    case = case_lookup(code)
    if not case:
        return None, "I cannot verify that demo case code. Please repeat all six digits."
    if "release" in normalized or "cancel" in normalized:
        reference = f"{reference_match.group(1).upper()}-{reference_match.group(2)}" if reference_match else f"{PROVIDERS[provider_id].upper()}-{code}"
        released = ledger.release(provider_id, reference)
        return (case["caseId"], f"{PROVIDERS[provider_id]} confirms demo hold {reference} is released." if released else f"I cannot confirm release of {reference}; please request manual review.")
    service = "respite" if "respite" in str(case.get("needSummary", "")).lower() else "shelter"
    held = ledger.hold(provider_id, code, service)
    if held["status"] == "full":
        return case["caseId"], f"{PROVIDERS[provider_id]} has no remaining {service} demo capacity. No hold was made."
    if held["status"] != "active":
        return case["caseId"], f"Demo hold {held['reference']} is {held['status']}; I cannot offer it again."
    return case["caseId"], f"{PROVIDERS[provider_id]} can offer one synthetic {service} place. Demo hold {held['reference']} expires at {held['expiresAt']}. This is not a real service booking."


async def provider_stream(websocket: WebSocket, provider_id: str):
    configured_token = os.getenv("PROVIDER_ANSWERER_TOKEN", "")
    if provider_id not in PROVIDERS or provider_mode() != "live" or len(configured_token) < 24 or not hmac.compare_digest(websocket.query_params.get("token", ""), configured_token):
        await websocket.close(code=4401)
        return
    try:
        phone_map = json.loads(os.getenv("PROVIDER_ANSWERER_PHONE_MAP_JSON", "{}"))
    except json.JSONDecodeError:
        await websocket.close(code=4401)
        return
    expected_number = phone_map.get(provider_id)
    if not expected_number or not os.getenv("EXOTEL_ACCOUNT_SID"):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    stt = build_stt_adapter()
    tts = build_tts_adapter()
    ledger = DemoInventory(os.getenv("PROVIDER_LEDGER_PATH", "/tmp/doot-provider-ledger.sqlite3"))
    stream_sid = ""
    case_id = None
    case_code = None
    interaction_kind = "hold"
    turns = []
    audio_buffer = bytearray()
    speech_started = False
    silence_ms = 0

    async def speak(text: str):
        turns.append({"speaker": "Provider", "text": text})
        pcm = await tts.synthesize(text, "en")
        for offset in range(0, len(pcm), 32000):
            chunk = pcm[offset:offset + 32000]
            target = max(3200, ((len(chunk) + 319) // 320) * 320)
            chunk += bytes(target - len(chunk))
            await websocket.send_json({"event": "media", "stream_sid": stream_sid, "media": {"payload": base64.b64encode(chunk).decode("ascii")}})

    try:
        while True:
            event = await websocket.receive_json()
            kind = event.get("event")
            if kind == "start":
                start = event.get("start") or {}
                if start.get("account_sid") != os.getenv("EXOTEL_ACCOUNT_SID") or start.get("to") != expected_number:
                    await websocket.close(code=4403)
                    return
                media_format = start.get("media_format") or {}
                if str(media_format.get("sample_rate")) != "8000" or media_format.get("encoding") != "audio/x-raw":
                    await websocket.close(code=4400)
                    return
                stream_sid = str(start.get("stream_sid") or "")
                await speak(f"Hello, this is {PROVIDERS[provider_id]}, an AI answerer for a synthetic Doot demo. Please state the six-digit demo case code and your request.")
            elif kind == "media" and stream_sid:
                try:
                    pcm = base64.b64decode((event.get("media") or {}).get("payload", ""), validate=True)
                except (ValueError, TypeError):
                    continue
                if len(pcm) % 2:
                    continue
                audio_buffer.extend(pcm)
                loud = audioop.rms(pcm, 2) > 450
                if loud:
                    speech_started = True
                    silence_ms = 0
                elif speech_started:
                    silence_ms += len(pcm) / 16
                if speech_started and (silence_ms >= 850 or len(audio_buffer) > 8000 * 2 * 30):
                    turn_audio = bytes(audio_buffer)
                    audio_buffer.clear()
                    speech_started = False
                    silence_ms = 0
                    recognized = await stt.transcribe(turn_audio, "en")
                    if not recognized.text.strip():
                        continue
                    turns.append({"speaker": "Doot", "text": recognized.text})
                    if "release" in recognized.text.lower() or "cancel" in recognized.text.lower():
                        interaction_kind = "release"
                    match = CODE_PATTERN.search(recognized.text)
                    if match:
                        case_code = re.sub(r"\D", "", match.group(1))
                    resolved_id, response = await asyncio.to_thread(provider_reply, provider_id, recognized.text, ledger)
                    case_id = resolved_id or case_id
                    await speak(response)
            elif kind == "stop":
                break
    except WebSocketDisconnect:
        pass
    finally:
        if case_id and case_code and turns:
            try:
                await asyncio.to_thread(archive_turns, case_id, case_code, provider_id, stream_sid, interaction_kind, turns)
            except Exception:
                pass
