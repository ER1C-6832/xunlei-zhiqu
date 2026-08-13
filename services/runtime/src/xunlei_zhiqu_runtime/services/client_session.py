from dataclasses import dataclass
from hmac import compare_digest
from typing import Literal, Protocol


@dataclass(frozen=True, slots=True)
class RuntimeClientSession:
    session_id: str
    auth_mode: str


class ClientSessionAuthPort(Protocol):
    def authenticate(self, token: str | None) -> RuntimeClientSession | None: ...


class AuthOffClientSession:
    def authenticate(self, token: str | None) -> RuntimeClientSession:
        return RuntimeClientSession(session_id="demo-local", auth_mode="off")


class StaticTokenClientSession:
    def __init__(self, token: str) -> None:
        value = token.strip()
        if not value:
            raise ValueError("RUNTIME_STATIC_SESSION_TOKEN is required for static_token auth mode")
        self._token = value

    def authenticate(self, token: str | None) -> RuntimeClientSession | None:
        if token is None or not compare_digest(token, self._token):
            return None
        return RuntimeClientSession(session_id="static-session", auth_mode="static_token")


def create_client_session_auth(
    mode: Literal["off", "static_token"],
    static_token: str | None,
) -> ClientSessionAuthPort:
    if mode == "off":
        return AuthOffClientSession()
    return StaticTokenClientSession(static_token or "")
