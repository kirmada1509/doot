from app.control_client import create_case_from_intake, lookup_voice_session


def test_lookup_fails_closed_when_control_api_is_unreachable(monkeypatch):
    monkeypatch.setenv("CONTROL_API_URL", "http://127.0.0.1:9")
    assert lookup_voice_session("vs_offline") is None


def test_create_case_posts_consented_intake(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 201

        def raise_for_status(self):
            return None

        def json(self):
            return {"case": {"id": "case_1"}, "workflow": {"started": True}}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return FakeResponse()

    monkeypatch.setattr("app.control_client.httpx.post", fake_post)
    result = create_case_from_intake(
        {
            "callSid": "exo_1",
            "callerPhoneBlindIndex": "blind_1",
            "consentAccepted": True,
            "recordingAccepted": False,
            "utterance": "Need shelter tonight",
            "languageHint": "en",
            "accessibilityNeeds": [],
        }
    )
    assert result["case"]["id"] == "case_1"
    assert captured["json"]["consentAccepted"] is True
    assert captured["json"]["recordingAccepted"] is False
    assert "/v1/cases" in captured["url"]
