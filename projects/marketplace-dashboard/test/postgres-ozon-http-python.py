import base64
import ctypes
import importlib.util
import io
import json
import pathlib
import socket
import ssl
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "storage" / "acquisition" / "postgres-ozon-http.py"
spec = importlib.util.spec_from_file_location("ozon_http", SOURCE)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
SECRET = "test-only-not-a-real-api-key"


class Spi:
    def __init__(self, stores=None):
        self.stores = stores if stores is not None else {"1": {"clientId": "1", "key": "cHJvdGVjdGVk", "market": "Ozon"}}
        self.calls = []

    def prepare(self, query, types):
        self.calls.append((query, types))
        return query

    def execute(self, query, params, limit):
        self.calls.append((query, params, limit))
        raw = json.dumps(self.stores).encode()
        return [{"content": raw, "sha256": transport.hashlib.sha256(raw).digest()}]


class WireSocket:
    def __init__(self, wire):
        self.reader = io.BytesIO(wire)
        self.sent = []
        self.closed = False
        self.timeouts = []

    def makefile(self, mode, buffering=None):
        return self.reader

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def sendall(self, value):
        self.sent.append(value)

    def close(self):
        self.closed = True


def call(spi=None, route="/v3/product/list", payload="{}", **kwargs):
    return json.loads(transport.execute(spi or Spi(), {}, "1", route, payload, kwargs.get("timeout", 1000), '"pult"'))


def wire_request(wire):
    sock = WireSocket(wire)
    with patch.object(transport, "connect", return_value=sock):
        result = transport.request({}, "1", SECRET, "/v3/product/list", b'{}', time.monotonic() + 1)
    return result, sock


class TransportTests(unittest.TestCase):
    def test_exact_read_allowlist_and_input_fail_before_credentials(self):
        with patch.object(transport, "load_key") as keys:
            for route in ("/v1/product/import", "https://evil.test/", "/v3/product/list?url=x", "/v3/product/list\r\nX: x"):
                self.assertEqual(call(route=route)["code"], "INVALID_ARGUMENT")
            for timeout in (0, 120001, True):
                self.assertEqual(call(timeout=timeout)["code"], "INVALID_ARGUMENT")
            self.assertEqual(call(payload="[]")["code"], "INVALID_ARGUMENT")
            self.assertEqual(call(payload=json.dumps({"x": "x" * transport.MAX_REQUEST_BYTES}))["code"], "INVALID_ARGUMENT")
            keys.assert_not_called()

    def test_registry_lookup_is_fixed_and_never_contains_plaintext(self):
        spi = Spi()
        with patch.object(transport, "decrypt_current_user", return_value=SECRET), patch.object(transport, "request", return_value={"ok": True, "status": 200, "data": {}}):
            self.assertTrue(call(spi)["ok"])
        self.assertIn('FROM "pult".document_states', spi.calls[0][0])
        self.assertNotIn(SECRET, str(spi.calls))
        self.assertEqual(spi.calls[1][1], ["file/" + transport.hashlib.sha256(b"stores.json").hexdigest()])
        with patch.object(transport, "decrypt_current_user") as decrypt:
            self.assertEqual(call(Spi({"1": {"clientId": "2", "key": "private"}}))["code"], "STORE_MISSING")
            self.assertEqual(call(Spi({"1": {"clientId": "1", "key": "private", "market": "WB"}}))["code"], "STORE_MISSING")
            decrypt.assert_not_called()

    def test_registry_checksum_failure_prevents_dpapi_and_http(self):
        spi = Spi()
        spi.execute = lambda *args: [{"content": b'{}', "sha256": b'0' * 32}]
        with patch.object(transport, "decrypt_current_user") as decrypt, patch.object(transport, "request") as request:
            self.assertEqual(call(spi)["code"], "CREDENTIAL_UNAVAILABLE")
            decrypt.assert_not_called()
            request.assert_not_called()

    def test_errors_are_fixed_and_never_leak_spi_network_or_key(self):
        for fault, code in [(TimeoutError(SECRET), "TIMEOUT"), (ssl.SSLError(SECRET), "TLS_ERROR"), (ValueError(SECRET), "INVALID_RESPONSE"), (OSError(SECRET), "NETWORK_ERROR")]:
            with patch.object(transport, "load_key", return_value=SECRET), patch.object(transport, "request", side_effect=fault):
                result = call()
                self.assertEqual(result["code"], code)
                self.assertNotIn(SECRET, json.dumps(result))
        with patch.object(transport, "load_key", side_effect=RuntimeError(SECRET)):
            self.assertEqual(call()["code"], "CREDENTIAL_UNAVAILABLE")

    def test_wire_post_fixed_headers_and_json_success(self):
        result, sock = wire_request(b'HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"items":[]}')
        self.assertEqual(result, {"ok": True, "status": 200, "data": {"items": []}})
        sent = b"".join(sock.sent)
        self.assertIn(b"POST /v3/product/list HTTP/1.1", sent)
        self.assertIn(b"Host: api-seller.ozon.ru", sent)
        self.assertIn(b"Accept-Encoding: identity", sent)
        self.assertTrue(sock.closed)

    def test_redirects_never_follow_and_error_bodies_are_discarded(self):
        for status, code in ((302, "HTTP_ERROR"), (401, "AUTH_FAILED"), (429, "RATE_LIMITED"), (503, "HTTP_ERROR")):
            result, sock = wire_request(("HTTP/1.1 %d Error\r\nLocation: https://evil.test/\r\nRetry-After: 7\r\nContent-Length: 1000000\r\n\r\n%s" % (status, SECRET)).encode())
            self.assertEqual(result, {"ok": False, "status": status, "code": code, "retryAfterMs": 7000})
            self.assertNotIn(SECRET, json.dumps(result))
            self.assertEqual(len(sock.sent), 2)

    def test_size_compression_invalid_json_and_credential_echo_rejected(self):
        for wire, code in (
            (b'HTTP/1.1 200 OK\r\nContent-Length: 33554433\r\n\r\n', "RESPONSE_TOO_LARGE"),
            (b'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n', "INVALID_RESPONSE"),
            (('HTTP/1.1 200 OK\r\n\r\n{"key":"%s"}' % SECRET).encode(), "INVALID_RESPONSE"),
        ):
            with self.assertRaises(transport.TransportFailure) as raised:
                wire_request(wire)
            self.assertEqual(raised.exception.code, code)
        with patch.object(transport, "MAX_RESPONSE_BYTES", 4), self.assertRaises(transport.TransportFailure) as raised:
            wire_request(b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n12345\r\n0\r\n\r\n')
        self.assertEqual(raised.exception.code, "RESPONSE_TOO_LARGE")

    def test_per_read_deadline_defeats_slow_header_or_body_drips(self):
        sock = WireSocket(b"123456")
        reader = transport.DeadlineReader(sock, 10)
        with patch.object(transport.time, "monotonic", side_effect=[1, 9, 10.1]):
            self.assertEqual(reader.readinto(bytearray(1)), 1)
            self.assertEqual(reader.readinto(bytearray(1)), 1)
            with self.assertRaises(transport.TransportFailure) as raised:
                reader.readinto(bytearray(1))
        self.assertEqual(raised.exception.code, "TIMEOUT")
        self.assertEqual(sock.timeouts, [9, 1])

    def test_pg_jsonb_incompatible_responses_are_sanitized(self):
        for body in (b'{"x":1e309}', b'{"x":"\\u0000"}', b'{"x":"\\ud800"}', b'{"x":NaN}', b'[]garbage'):
            sock = WireSocket(b'HTTP/1.1 200 OK\r\n\r\n' + body)
            with patch.object(transport, "load_key", return_value=SECRET), patch.object(transport, "connect", return_value=sock):
                self.assertEqual(call(), {"ok": False, "status": 0, "code": "INVALID_RESPONSE"})

    def test_socket_file_reference_survives_connection_close(self):
        # Exercise actual socket.makefile lifetime used by HTTPConnection on
        # Connection: close, without Ozon/network access.
        left, right = socket.socketpair()
        try:
            right.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"items":[]}')
            with patch.object(transport, "connect", return_value=transport.DeadlineSocket(left, time.monotonic() + 1)):
                result = transport.request({}, "1", SECRET, "/v3/product/list", b'{}', time.monotonic() + 1)
            self.assertTrue(result["ok"])
        finally:
            left.close()
            right.close()

    def test_dns_is_pinned_public_and_fails_with_deadline(self):
        with patch.object(transport.socket, "getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]) as lookup:
            with self.assertRaises(transport.TransportFailure):
                transport.resolve({}, time.monotonic() + 1)
            lookup.assert_called_once_with("api-seller.ozon.ru", 443, type=socket.SOCK_STREAM)
        with self.assertRaises(transport.TransportFailure) as raised:
            transport.remaining(time.monotonic() - 1)
        self.assertEqual(raised.exception.code, "TIMEOUT")

    def test_tls_certificate_hostname_and_sni_are_required(self):
        class Context:
            minimum_version = None
            check_hostname = False
            verify_mode = ssl.CERT_NONE
            def wrap_socket(self, sock, **options):
                self.options = options
                raise ssl.SSLCertVerificationError("untrusted")
        context = Context()
        sock = WireSocket(b"")
        sock.connect = lambda address: None
        with patch.object(transport.ssl, "create_default_context", return_value=context), patch.object(transport, "resolve", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]), patch.object(transport.socket, "socket", return_value=sock):
            with self.assertRaises(transport.TransportFailure) as raised:
                transport.connect({}, time.monotonic() + 1)
        self.assertEqual(raised.exception.code, "TLS_ERROR")
        self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(context.options, {"server_hostname": "api-seller.ozon.ru", "do_handshake_on_connect": False})
        self.assertTrue(sock.closed)

    def test_verify_connection_cannot_choose_route_or_return_data(self):
        with patch.object(transport, "decrypt_current_user", return_value=SECRET), patch.object(transport, "request", return_value={"ok": True, "status": 200, "data": {"private": True}}) as request:
            result = json.loads(transport.verify_connection(None, {}, "1", "cHJvdGVjdGVk", 1000))
        self.assertEqual(result, {"ok": True, "status": 200})
        self.assertEqual(request.call_args.args[3], "/v3/product/list")
        self.assertEqual(json.loads(request.call_args.args[4]), {"filter": {"visibility": "ALL"}, "last_id": "", "limit": 1})

    @unittest.skipUnless(hasattr(ctypes, "WinDLL"), "Windows DPAPI only")
    def test_dpapi_current_user_roundtrip_and_invalid_ciphertext(self):
        class Blob(ctypes.Structure):
            _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]
        crypt = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        crypt.CryptProtectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
        crypt.CryptProtectData.restype = ctypes.c_int
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        raw = SECRET.encode()
        buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        plain, encrypted = Blob(len(raw), buffer), Blob()
        self.assertTrue(crypt.CryptProtectData(ctypes.byref(plain), None, None, None, None, 1, ctypes.byref(encrypted)))
        try:
            ciphertext = base64.b64encode(ctypes.string_at(encrypted.pbData, encrypted.cbData)).decode()
        finally:
            kernel.LocalFree(encrypted.pbData)
        self.assertEqual(transport.decrypt_current_user(ciphertext), SECRET)
        with self.assertRaises(transport.TransportFailure) as raised:
            transport.decrypt_current_user("not-a-dpapi-ciphertext")
        self.assertEqual(raised.exception.code, "CREDENTIAL_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
