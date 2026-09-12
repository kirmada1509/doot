import asyncio
import base64
from dataclasses import dataclass
import json
import os
from typing import Dict, List, Literal, Protocol, runtime_checkable
from urllib.parse import urlencode

import websockets


AdapterKind = Literal["telephony", "stt", "tts", "agent", "outbound"]


@dataclass(frozen=True)
class TranscriptEvent:
    text: str
    is_final: bool
    speech_final: bool
    language: str


@dataclass(frozen=True)
class AgentProposal:
    mode: Literal["urgent", "planning", "existing"]
    response_text: str
    safety_escalation: bool


@runtime_checkable
class DeepgramAdapter(Protocol):
    async def transcribe(self, audio: bytes, language_hint: str) -> TranscriptEvent:
        ...


@runtime_checkable
class ElevenLabsAdapter(Protocol):
    async def synthesize(self, text: str, language_hint: str) -> bytes:
        ...


@runtime_checkable
class StrandsAdapter(Protocol):
    async def propose(self, utterance: str, language_hint: str, mode: str) -> AgentProposal:
        ...


class MockDeepgramAdapter:
    async def transcribe(self, audio: bytes, language_hint: str) -> TranscriptEvent:
        return TranscriptEvent(
            text=f"mock transcript ({len(audio)} bytes)",
            is_final=True,
            speech_final=True,
            language=language_hint,
        )


class FixtureDeepgramAdapter:
    """Deterministic 8 kHz fixture path used when DEEPGRAM_API_KEY is the demo placeholder."""

    def __init__(self, fixture_text: str = "I need a wheelchair accessible shelter tonight"):
        self.fixture_text = fixture_text

    async def transcribe(self, audio: bytes, language_hint: str) -> TranscriptEvent:
        # Telephony frames are 8 kHz PCM; keep the fixture path independent of live Flux.
        _ = (audio, language_hint)
        return TranscriptEvent(
            text=self.fixture_text,
            is_final=True,
            speech_final=True,
            language=language_hint,
        )


class DeepgramFluxAdapter:
    def __init__(self, api_key: str, endpoint: str = "wss://api.deepgram.com/v2/listen"):
        self.api_key = api_key
        self.endpoint = endpoint

    async def transcribe(self, audio: bytes, language_hint: str) -> TranscriptEvent:
        hints = ["en", "hi"] if language_hint in {"hi", "hinglish"} else ["en"]
        query = urlencode(
            [
                ("model", "flux-general-multi"),
                ("encoding", "linear16"),
                ("sample_rate", "8000"),
                ("eot_timeout_ms", "3000"),
                *(('language_hint', hint) for hint in hints),
            ]
        )
        async with websockets.connect(
            f"{self.endpoint}?{query}",
            additional_headers={"Authorization": f"Token {self.api_key}"},
            open_timeout=10,
        ) as socket:
            # Flux performs best with 80 ms linear16 frames at 8 kHz (1,280 bytes).
            for offset in range(0, len(audio), 1280):
                await socket.send(audio[offset : offset + 1280])
            await socket.send(json.dumps({"type": "ForceEndTurn"}))
            while True:
                message = json.loads(await asyncio.wait_for(socket.recv(), timeout=10))
                if message.get("type") == "Error":
                    raise RuntimeError(f"Deepgram Flux error: {message.get('code', 'unknown')}")
                if message.get("type") == "TurnInfo" and message.get("event") == "EndOfTurn":
                    await socket.send(json.dumps({"type": "CloseStream"}))
                    return TranscriptEvent(
                        text=str(message.get("transcript", "")).strip(),
                        is_final=True,
                        speech_final=True,
                        language=language_hint,
                    )


def build_stt_adapter() -> DeepgramAdapter:
    key = os.getenv("DEEPGRAM_API_KEY", "").strip()
    if provider_mode() == "live":
        if not key or key == "demo-deepgram-key":
            raise RuntimeError("VOICE_PROVIDER_MODE=live requires DEEPGRAM_API_KEY")
        return DeepgramFluxAdapter(key)
    return FixtureDeepgramAdapter()


class MockElevenLabsAdapter:
    async def synthesize(self, text: str, language_hint: str) -> bytes:
        return text.encode("utf-8")


class ElevenLabsDialogueAdapter:
    def __init__(self, api_key: str, voice_id: str, endpoint: str = "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input"):
        self.api_key = api_key
        self.voice_id = voice_id
        self.endpoint = endpoint

    async def synthesize(self, text: str, language_hint: str) -> bytes:
        _ = language_hint
        uri = f"{self.endpoint}?{urlencode({'model_id': 'eleven_v3_conversational', 'output_format': 'pcm_8000'})}"
        chunks: list[bytes] = []
        async with websockets.connect(
            uri,
            additional_headers={"xi-api-key": self.api_key},
            open_timeout=10,
        ) as socket:
            await socket.send(json.dumps({"voices": [self.voice_id]}))
            await socket.send(json.dumps({"inputs": [{"text": text, "voice_id": self.voice_id, "new_turn": True}]}))
            await socket.send(json.dumps({"flush": True}))
            while True:
                message = json.loads(await asyncio.wait_for(socket.recv(), timeout=15))
                if message.get("audio"):
                    chunks.append(base64.b64decode(message["audio"], validate=True))
                if message.get("is_final_audio_for_turn") or message.get("isFinal"):
                    await socket.send(json.dumps({"close_socket": True}))
                    return b"".join(chunks)


class MockStrandsAdapter:
    async def propose(self, utterance: str, language_hint: str, mode: str) -> AgentProposal:
        return AgentProposal(
            mode=mode if mode in {"urgent", "planning", "existing"} else "planning",
            response_text=utterance,
            safety_escalation=False,
        )


class BedrockStrandsAdapter:
    def __init__(self, fast_model: str, planning_model: str):
        self.fast_model = fast_model
        self.planning_model = planning_model

    async def propose(self, utterance: str, language_hint: str, mode: str) -> AgentProposal:
        selected_mode = mode if mode in {"urgent", "planning", "existing"} else "planning"
        model_id = self.fast_model if selected_mode in {"urgent", "existing"} else self.planning_model
        response = await asyncio.to_thread(self._invoke, model_id, utterance, language_hint, selected_mode)
        return AgentProposal(mode=selected_mode, response_text=response[:800], safety_escalation=False)

    @staticmethod
    def _invoke(model_id: str, utterance: str, language_hint: str, mode: str) -> str:
        from strands import Agent

        agent = Agent(
            model=model_id,
            system_prompt=(
                "You are Doot's bounded voice copy assistant. Never claim eligibility, availability, a hold, "
                "a booking, or emergency capability. Do not make decisions or call tools. Return one short, "
                "plain-language spoken response acknowledging the request and explaining the next coordination step."
            ),
        )
        result = agent(f"Language: {language_hint}\nMode: {mode}\nCaller request: {utterance}")
        text = str(result).strip()
        if not text:
            raise RuntimeError("Strands returned an empty response")
        return text


def build_tts_adapter() -> ElevenLabsAdapter:
    if provider_mode() != "live":
        return MockElevenLabsAdapter()
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    voice_id = os.getenv("ELEVENLABS_VOICE_ID", "").strip()
    if not key or key == "demo-elevenlabs-key" or not voice_id:
        raise RuntimeError("VOICE_PROVIDER_MODE=live requires ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID")
    return ElevenLabsDialogueAdapter(key, voice_id)


def build_agent_adapter() -> StrandsAdapter:
    if provider_mode() != "live":
        return MockStrandsAdapter()
    return BedrockStrandsAdapter(
        fast_model=os.getenv("STRANDS_FAST_MODEL_ID", "global.anthropic.claude-haiku-4-5"),
        planning_model=os.getenv("STRANDS_PLANNING_MODEL_ID", "global.anthropic.claude-sonnet-4-6"),
    )


def provider_mode() -> Literal["fixture", "live"]:
    return "live" if os.getenv("VOICE_PROVIDER_MODE", "fixture").strip().lower() == "live" else "fixture"


@dataclass(frozen=True)
class VoiceAdapter:
    name: str
    kind: AdapterKind
    purpose: str
    required_env: List[str]
    demo_fallback: str

    def as_capability(self) -> Dict[str, object]:
        configured = provider_mode() == "live" and all(os.getenv(item, "").strip() for item in self.required_env)
        return {
            "name": self.name,
            "kind": self.kind,
            "purpose": self.purpose,
            "configured": configured,
            "mode": "live" if configured else "demo",
            "requiredEnv": self.required_env,
            "demoFallback": self.demo_fallback,
        }


VOICE_ADAPTERS = [
    VoiceAdapter(
        name="exotel",
        kind="telephony",
        purpose="Own the inbound +91 hotline and deliver authenticated narrowband media frames.",
        required_env=["EXOTEL_ACCOUNT_SID", "EXOTEL_API_TOKEN"],
        demo_fallback="HTTP intake screening without a live media WebSocket.",
    ),
    VoiceAdapter(
        name="deepgram-flux",
        kind="stt",
        purpose="Transcribe Hindi/English code-switched telephony audio with interruption-aware endpointing.",
        required_env=["DEEPGRAM_API_KEY"],
        demo_fallback="Deterministic text payloads in tests and demos.",
    ),
    VoiceAdapter(
        name="elevenlabs",
        kind="tts",
        purpose="Stream multilingual spoken responses and support barge-in interruption.",
        required_env=["ELEVENLABS_API_KEY"],
        demo_fallback="Return the exact script text for operator-visible proof.",
    ),
    VoiceAdapter(
        name="strands",
        kind="agent",
        purpose="Generate bounded coordination proposals while deterministic policy keeps authority.",
        required_env=["STRANDS_MODEL_PROFILE"],
        demo_fallback="Rule-based mode, safety, callback, and language decisions.",
    ),
    VoiceAdapter(
        name="call-e",
        kind="outbound",
        purpose="Run provider negotiations and caller callbacks as structured outbound goals.",
        required_env=["CALL_E_API_KEY"],
        demo_fallback="Synthetic provider results mapped through the CALL-E flat schema.",
    ),
]


def voice_capabilities() -> List[Dict[str, object]]:
    return [adapter.as_capability() for adapter in VOICE_ADAPTERS]


def session_plan(call_sid: str, language_hint: str) -> Dict[str, object]:
    return {
        "callSid": call_sid,
        "languageHint": language_hint,
        "media": {
            "transport": "exotel-websocket",
            "sampleRateHz": 8000,
            "encoding": "linear16",
        },
        "pipeline": [
            "exotel",
            "deepgram-flux",
            "strands",
            "elevenlabs",
            "call-e",
        ],
        "capabilities": voice_capabilities(),
    }
