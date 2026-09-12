import asyncio
import json

from app.adapters import (
    AgentProposal,
    DeepgramAdapter,
    DeepgramFluxAdapter,
    ElevenLabsDialogueAdapter,
    ElevenLabsAdapter,
    FixtureDeepgramAdapter,
    MockDeepgramAdapter,
    MockElevenLabsAdapter,
    MockStrandsAdapter,
    StrandsAdapter,
    TranscriptEvent,
    build_stt_adapter,
)


class FakeSocket:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def send(self, value):
        self.sent.append(value)

    async def recv(self):
        return next(self.responses)


def test_mock_adapters_implement_provider_contracts():
    assert isinstance(MockDeepgramAdapter(), DeepgramAdapter)
    assert isinstance(MockElevenLabsAdapter(), ElevenLabsAdapter)
    assert isinstance(MockStrandsAdapter(), StrandsAdapter)
    assert isinstance(FixtureDeepgramAdapter(), DeepgramAdapter)
    assert isinstance(build_stt_adapter(), DeepgramAdapter)


def test_mock_deepgram_returns_final_transcript_event():
    result = asyncio.run(MockDeepgramAdapter().transcribe(b"audio", "hinglish"))

    assert isinstance(result, TranscriptEvent)
    assert result.is_final is True
    assert result.speech_final is True
    assert result.language == "hinglish"
    assert "5 bytes" in result.text


def test_mock_elevenlabs_returns_utf8_audio_payload():
    result = asyncio.run(MockElevenLabsAdapter().synthesize("Namaste", "hi"))

    assert result == "Namaste".encode("utf-8")


def test_mock_strands_returns_bounded_proposal():
    result = asyncio.run(MockStrandsAdapter().propose("need help", "en", "urgent"))

    assert isinstance(result, AgentProposal)
    assert result.mode == "urgent"
    assert result.response_text == "need help"
    assert result.safety_escalation is False


def test_flux_uses_v2_multilingual_telephony_protocol(monkeypatch):
    socket = FakeSocket([
        json.dumps({"type": "Connected"}),
        json.dumps({"type": "TurnInfo", "event": "EndOfTurn", "transcript": "mujhe help chahiye"}),
    ])
    connection = {}

    def connect(uri, **kwargs):
        connection.update(uri=uri, kwargs=kwargs)
        return socket

    monkeypatch.setattr("app.adapters.websockets.connect", connect)
    result = asyncio.run(DeepgramFluxAdapter("secret").transcribe(b"a" * 1400, "hinglish"))

    assert "/v2/listen?" in connection["uri"]
    assert "model=flux-general-multi" in connection["uri"]
    assert "sample_rate=8000" in connection["uri"]
    assert connection["uri"].count("language_hint=") == 2
    assert [len(item) for item in socket.sent if isinstance(item, bytes)] == [1280, 120]
    assert json.loads(socket.sent[-2]) == {"type": "ForceEndTurn"}
    assert json.loads(socket.sent[-1]) == {"type": "CloseStream"}
    assert result.text == "mujhe help chahiye"


def test_elevenlabs_uses_v3_conversational_dialogue(monkeypatch):
    socket = FakeSocket([
        json.dumps({"audio": "YWJj"}),
        json.dumps({"is_final_audio_for_turn": True}),
    ])
    connection = {}

    def connect(uri, **kwargs):
        connection.update(uri=uri, kwargs=kwargs)
        return socket

    monkeypatch.setattr("app.adapters.websockets.connect", connect)
    result = asyncio.run(ElevenLabsDialogueAdapter("secret", "voice-1").synthesize("Namaste, how can I help?", "hinglish"))

    assert "/v1/text-to-dialogue/stream-input?" in connection["uri"]
    assert "model_id=eleven_v3_conversational" in connection["uri"]
    assert "output_format=pcm_8000" in connection["uri"]
    assert json.loads(socket.sent[0]) == {"voices": ["voice-1"]}
    assert result == b"abc"
