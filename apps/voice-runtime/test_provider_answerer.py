from app.provider_answerer import DemoInventory, provider_reply
from app.main import app
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest


def test_two_answerers_issue_distinct_synthetic_holds_and_release(tmp_path):
    inventory = DemoInventory(str(tmp_path / "inventory.sqlite3"))
    lookup = lambda code: {"caseId": "case_1", "needSummary": "I need respite tonight"} if code == "123456" else None
    lotus_id, lotus = provider_reply("provider_lotus", "Doot case code 1 2 3 4 5 6. Can you hold respite?", inventory, lookup)
    ashraya_id, ashraya = provider_reply("provider_ashraya", "Doot case code 123456. Can you hold respite?", inventory, lookup)
    assert lotus_id == ashraya_id == "case_1"
    assert "LOTUS-123456" in lotus
    assert "ASHRAYA-123456" in ashraya
    assert "synthetic respite" in lotus
    _, released = provider_reply("provider_ashraya", "Release ASHRAYA-123456 for Doot case 123456", inventory, lookup)
    assert "confirms demo hold" in released
    assert inventory.release("provider_ashraya", "ASHRAYA-123456") is True
    assert inventory.release("provider_lotus", "ASHRAYA-123456") is False


def test_unknown_code_and_capacity_do_not_fabricate_hold(tmp_path):
    inventory = DemoInventory(str(tmp_path / "inventory.sqlite3"))
    lookup = lambda code: {"caseId": f"case_{code}", "needSummary": "shelter"} if code != "999999" else None
    assert "cannot verify" in provider_reply("provider_lotus", "case 999999", inventory, lookup)[1]
    for code in ["111111", "222222"]:
        assert "Demo hold" in provider_reply("provider_lotus", f"case {code}", inventory, lookup)[1]
    assert "No hold was made" in provider_reply("provider_lotus", "case 333333", inventory, lookup)[1]


def test_ledger_verification_requires_service_token(tmp_path, monkeypatch):
    monkeypatch.setenv("PROVIDER_LEDGER_PATH", str(tmp_path / "inventory.sqlite3"))
    inventory = DemoInventory(str(tmp_path / "inventory.sqlite3"))
    held = inventory.hold("provider_lotus", "123456", "shelter")
    client = TestClient(app)
    path = "/v1/internal/provider-holds/verify?providerId=provider_lotus&caseCode=123456&reference=LOTUS-123456"
    assert client.get(path).status_code == 401
    response = client.get(path, headers={"authorization": "Bearer doot-local-service-token"})
    assert response.status_code == 200
    assert response.json() == {"status": "active", "expiresAt": held["expiresAt"]}


def test_exotel_answerer_requires_token_and_authorized_start(monkeypatch, tmp_path):
    monkeypatch.setenv("PROVIDER_ANSWERER_TOKEN", "a" * 32)
    monkeypatch.setenv("PROVIDER_ANSWERER_PHONE_MAP_JSON", '{"provider_lotus":"+14155550123"}')
    monkeypatch.setenv("EXOTEL_ACCOUNT_SID", "account_test")
    monkeypatch.setenv("PROVIDER_LEDGER_PATH", str(tmp_path / "inventory.sqlite3"))
    monkeypatch.setattr("app.provider_answerer.provider_mode", lambda: "live")

    class FakeTts:
        async def synthesize(self, text, language):
            return bytes(3511)

    monkeypatch.setattr("app.provider_answerer.build_tts_adapter", lambda: FakeTts())
    monkeypatch.setattr("app.provider_answerer.build_stt_adapter", lambda: object())
    client = TestClient(app)
    path = "/v1/telephony/exotel/provider/provider_lotus/stream"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path):
            pass
    with client.websocket_connect(f"{path}?token={'a' * 32}") as socket:
        socket.send_json({"event": "start", "start": {"account_sid": "account_test", "to": "+14155550123", "stream_sid": "stream_1", "media_format": {"encoding": "audio/x-raw", "sample_rate": "8000"}}})
        event = socket.receive_json()
        assert event["event"] == "media"
        assert event["stream_sid"] == "stream_1"
        import base64
        assert len(base64.b64decode(event["media"]["payload"])) == 3520
        socket.send_json({"event": "stop"})
