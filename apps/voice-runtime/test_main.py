import asyncio

from fastapi.testclient import TestClient

from app.adapters import AgentProposal, TranscriptEvent
from app.main import VoiceSession, app


client = TestClient(app)


def test_intake_speaks_disclosure_and_callback_for_urgent_need():
    response = client.post(
        "/v1/voice/intake/screen",
        json={
            "case_id": "case_voice_1",
            "utterance": "I need a shelter tonight, please call back when you find one",
            "language_hint": "en",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "urgent"
    assert "AI coordination agent" in body["disclosureScript"]
    assert body["shouldHangUpForCallback"] is True
    assert body["safetyEscalation"] is False


def test_voice_dependencies_are_named_capabilities():
    response = client.get("/health/dependencies")

    assert response.status_code == 200
    names = {item["name"] for item in response.json()["dependencies"]}
    assert {"exotel", "deepgram-flux", "elevenlabs", "strands", "call-e"}.issubset(names)


def test_session_plan_describes_media_pipeline():
    response = client.post(
        "/v1/voice/session/plan",
        json={"call_sid": "exo_call_123", "language_hint": "hinglish"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["media"]["sampleRateHz"] == 8000
    assert body["pipeline"] == ["exotel", "deepgram-flux", "strands", "elevenlabs", "call-e"]


def test_existing_reference_selects_existing_case_mode():
    response = client.post(
        "/v1/voice/intake/screen",
        json={
            "case_id": "case_voice_2",
            "utterance": "I am calling about my earlier hold",
            "existing_reference": "D-8842",
            "language_hint": "hinglish",
        },
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "existing"


def test_third_party_call_is_flagged_without_becoming_a_mode():
    response = client.post(
        "/v1/voice/intake/screen",
        json={
            "case_id": "case_voice_3",
            "utterance": "My friend needs help later this week",
            "language_hint": "en",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "planning"
    assert body["requestedFor"] == "someone_else"


def test_mid_call_safety_escalation_stops_coordination():
    response = client.post(
        "/v1/voice/turn/safety",
        json={
            "case_id": "case_voice_4",
            "utterance": "Actually she is not breathing",
            "language_hint": "en",
            "turn_index": 4,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["midCallEscalation"] is True
    assert body["continueCoordination"] is False
    assert "112 or 108" in body["handoffScript"]


def test_exotel_stream_speaks_disclosure_and_handles_media_and_safety(monkeypatch):
    created = {"called": False, "safety": None}

    def fake_lookup(session_token: str):
        return {
            "token": session_token,
            "callSid": "exo_call_456",
            "language": "en",
            "callerPhoneBlindIndex": "blind_exo_call_456",
        }

    def fake_create_case(payload):
        created["called"] = True
        return {
            "case": {"id": "case_from_voice"},
            "workflow": {"started": True, "workflowId": "case-case_from_voice"},
        }

    monkeypatch.setattr("app.main.lookup_voice_session", fake_lookup)
    monkeypatch.setattr("app.main.create_case_from_intake", fake_create_case)
    monkeypatch.setattr("app.main.signal_safety_handoff", lambda case_id: created.update(safety=case_id) or True)

    with client.websocket_connect("/v1/telephony/exotel/stream/vs_test_token?language=en") as websocket:
        disclosure = websocket.receive_json()
        assert disclosure["event"] == "speak"
        assert disclosure["recordingNotice"] is True
        assert disclosure["sessionToken"] == "vs_test_token"

        websocket.send_bytes(b"\x00\x01")
        media_ack = websocket.receive_json()
        assert media_ack["event"] == "media_ack"
        assert media_ack["sampleRateHz"] == 8000
        assert media_ack["bytes"] == 2

        websocket.send_json({"event": "consent", "accepted": True, "recordingAccepted": True})
        consent = websocket.receive_json()
        assert consent["event"] == "consent_recorded"
        assert consent["accepted"] is True

        websocket.send_json({"event": "transcript", "text": "I need help tonight"})
        turn = websocket.receive_json()
        assert turn["event"] == "transcript"
        assert turn["mode"] == "urgent"
        assert turn["continueCoordination"] is True
        assert turn["caseCreated"] is True
        assert turn["caseId"] == "case_from_voice"
        assert created["called"] is True

        websocket.send_json({"event": "transcript", "text": "Actually, she is not breathing"})
        handoff = websocket.receive_json()
        assert handoff["event"] == "safety_handoff"
        assert handoff["continueCoordination"] is False
        assert "112 or 108" in handoff["text"]
        assert created["safety"] == "case_from_voice"


def test_live_browser_rejects_fabricated_transcript(monkeypatch):
    class Tts:
        async def synthesize(self, _text, _language):
            return b"\x00\x00"

    monkeypatch.setattr("app.main.provider_mode", lambda: "live")
    monkeypatch.setattr("app.main.build_tts_adapter", lambda: Tts())
    monkeypatch.setattr("app.main.lookup_voice_session", lambda token: {
        "token": token, "channel": "browser", "callSid": "browser_test", "language": "en", "service": "shelter"
    })
    monkeypatch.setattr("app.main.create_case_from_intake", lambda _payload: (_ for _ in ()).throw(AssertionError("intake bypassed STT")))

    with client.websocket_connect("/v1/browser/stream/test_browser") as websocket:
        assert websocket.receive_json()["event"] == "speak"
        assert websocket.receive_json()["event"] == "media"
        websocket.send_json({"event": "consent", "accepted": True, "recordingAccepted": False})
        assert websocket.receive_json()["event"] == "consent_recorded"
        websocket.send_json({"event": "transcript", "text": "I need shelter tonight"})
        assert websocket.receive_json() == {"event": "error", "code": "AUDIO_REQUIRED"}


def test_audio_turn_transcribes_proposes_and_archives_consented_recording(monkeypatch):
    archived = []

    class Stt:
        async def transcribe(self, audio, language_hint):
            assert audio == b"\x00\x01"
            return TranscriptEvent("I need help tonight", True, True, language_hint)

    class Agent:
        async def propose(self, utterance, language_hint, mode):
            assert (utterance, language_hint, mode) == ("I need help tonight", "en", "urgent")
            return AgentProposal("urgent", "I will coordinate options and call back.", False)

    monkeypatch.setattr("app.main.create_case_from_intake", lambda _payload: {"case": {"id": "case-audio"}, "workflow": {"started": True}})
    monkeypatch.setattr("app.main.archive_case_artifact", lambda *args: archived.append(args) or {})
    session = VoiceSession("token", "call", "en", "blind")
    session.start()
    session.handle_consent(True, True)
    session.handle_media(b"\x00\x01")

    result = asyncio.run(session.finish_audio_turn(Stt(), Agent()))

    assert result["caseId"] == "case-audio"
    assert result["transcript"] == "I need help tonight"
    assert result["text"] == "I will coordinate options and call back."
    assert archived[0][1:] == ("recording", b"\x00\x01", "audio/L16;rate=8000;channels=1")
