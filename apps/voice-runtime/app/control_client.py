from __future__ import annotations

import os
import base64
from typing import Any, Dict, Optional

import httpx


def control_api_url() -> str:
    return os.getenv("CONTROL_API_URL", "http://localhost:4000").rstrip("/")


def service_token() -> str:
    return os.getenv("INTERNAL_SERVICE_TOKEN", "doot-local-service-token")


def lookup_voice_session(session_token: str) -> Optional[Dict[str, Any]]:
    try:
        response = httpx.get(
            f"{control_api_url()}/v1/internal/telephony/sessions/{session_token}",
            headers={"authorization": f"Bearer {service_token()}"},
            timeout=2.0,
        )
    except httpx.HTTPError:
        return None
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return response.json()


def create_case_from_intake(payload: Dict[str, Any]) -> Dict[str, Any]:
    response = httpx.post(
        f"{control_api_url()}/v1/cases",
        headers={
            "authorization": f"Bearer {service_token()}",
            "content-type": "application/json",
            "x-request-id": payload.get("requestId", f"voice_{payload.get('callSid', 'unknown')}"),
        },
        json={key: value for key, value in {
            "callerPhoneBlindIndex": payload["callerPhoneBlindIndex"],
            "callerLabel": payload.get("callerLabel", "Authenticated caller"),
            "utterance": payload["utterance"],
            "consentAccepted": payload["consentAccepted"],
            "recordingAccepted": payload["recordingAccepted"],
            "requestedFor": payload.get("requestedFor", "unknown"),
            "languageHint": payload.get("languageHint", "hinglish"),
            "existingReference": payload.get("existingReference"),
            "location": payload.get("location", "indiranagar"),
            "service": payload.get("service", "shelter"),
            "accessibilityNeeds": payload.get("accessibilityNeeds", []),
            "requestedTimeframe": payload.get("requestedTimeframe"),
            "sessionToken": payload.get("sessionToken"),
        }.items() if value is not None},
        timeout=5.0,
    )
    response.raise_for_status()
    return response.json()


def browser_case_progress(session_token: str) -> Dict[str, Any]:
    response = httpx.get(
        f"{control_api_url()}/v1/caller/sessions/{session_token}",
        timeout=3.0,
    )
    response.raise_for_status()
    return response.json()


def signal_safety_handoff(case_id: str) -> bool:
    try:
        response = httpx.post(
            f"{control_api_url()}/v1/internal/cases/{case_id}/safety-handoff",
            headers={"authorization": f"Bearer {service_token()}"},
            timeout=2.0,
        )
        response.raise_for_status()
        return True
    except httpx.HTTPError:
        return False


def archive_case_artifact(case_id: str, artifact_type: str, content: bytes, content_type: str) -> Dict[str, Any]:
    response = httpx.post(
        f"{control_api_url()}/v1/internal/cases/{case_id}/artifacts",
        headers={"authorization": f"Bearer {service_token()}"},
        json={
            "artifactType": artifact_type,
            "contentBase64": base64.b64encode(content).decode("ascii"),
            "contentType": content_type,
        },
        timeout=10.0,
    )
    response.raise_for_status()
    return response.json()
