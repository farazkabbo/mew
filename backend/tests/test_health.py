from fastapi.testclient import TestClient

from mew_api import __version__


def test_health_is_public_and_minimal(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "api", "version": __version__}


def test_security_headers_are_set(client: TestClient) -> None:
    headers = client.get("/health").headers

    assert headers["x-content-type-options"] == "nosniff"
    assert headers["x-frame-options"] == "DENY"
    assert headers["cache-control"] == "no-store"
    assert "default-src 'none'" in headers["content-security-policy"]


def test_unknown_host_is_rejected(client: TestClient) -> None:
    response = client.get("/health", headers={"Host": "evil.example"})

    assert response.status_code == 400


def test_docs_are_disabled_outside_development(client: TestClient) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
