"""Source embedded in the administrator-owned PL/Python function at install time.

No runtime import from the application checkout and no HTTP work in a helper
process. The PostgreSQL backend opens every socket. The DNS-only daemon never
calls SPI; at most one resolver can be outstanding per function and backend.
"""
import base64
import ctypes
import hashlib
import http.client
import io
import ipaddress
import json
import math
import queue
import re
import socket
import ssl
import threading
import time
from email.utils import parsedate_to_datetime

HOST = "api-seller.ozon.ru"
PORT = 443
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_REGISTRY_BYTES = 25 * 1024 * 1024
READ_ROUTES = frozenset((
    "/v3/product/list", "/v3/product/info/list", "/v1/description-category/tree",
    "/v4/product/info/stocks", "/v1/finance/accrual/by-day", "/v1/finance/accrual/types",
    "/v1/analytics/data", "/v5/product/info/prices", "/v3/posting/fbo/list", "/v4/posting/fbs/list",
))


class TransportFailure(Exception):
    def __init__(self, code):
        self.code = code


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TransportFailure("TIMEOUT")
    return value


def failure(code, status=0, retry_after=None):
    result = {"ok": False, "status": status, "code": code}
    if retry_after is not None:
        result["retryAfterMs"] = retry_after
    return result


def decrypt_current_user(ciphertext):
    # Matches .NET ProtectedData.Unprotect(..., null, CurrentUser). Native DPAPI
    # runs under the PostgreSQL service account; no shell/process sees the key.
    if not hasattr(ctypes, "WinDLL"):
        raise TransportFailure("CREDENTIAL_UNAVAILABLE")
    class Blob(ctypes.Structure):
        _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]
    plain = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = ctypes.c_int
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    try:
        raw = base64.b64decode(ciphertext, validate=True)
        if not raw or len(raw) > 65536:
            raise ValueError()
        buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        encrypted = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
        if not crypt.CryptUnprotectData(ctypes.byref(encrypted), None, None, None, None, 1, ctypes.byref(plain)):
            raise ValueError()
        if plain.cbData < 1 or plain.cbData > 4096:
            raise ValueError()
        key = ctypes.string_at(plain.pbData, plain.cbData).decode("utf-8", "strict")
        if not re.fullmatch(r"[\x21-\x7e]{1,4096}", key):
            raise ValueError()
        return key
    except Exception:
        raise TransportFailure("CREDENTIAL_UNAVAILABLE") from None
    finally:
        if plain.pbData:
            ctypes.memset(plain.pbData, 0, plain.cbData)
            kernel.LocalFree(plain.pbData)


def load_key(plpy, store_id, state_schema):
    logical_key = "file/" + hashlib.sha256(b"stores.json").hexdigest()
    # state_schema is an installer-validated identifier embedded in function
    # source, never an SQL request parameter. Do not expose SPI error text.
    query = ("SELECT content,sha256 FROM " + state_schema + ".document_states "
             "WHERE logical_key=$1 AND NOT deleted AND media_type='application/json'")
    rows = plpy.execute(plpy.prepare(query, ["text"]), [logical_key], 1)
    if len(rows) != 1:
        raise TransportFailure("STORE_MISSING")
    raw = bytes(rows[0]["content"])
    if len(raw) > MAX_REGISTRY_BYTES or hashlib.sha256(raw).digest() != bytes(rows[0]["sha256"]):
        raise TransportFailure("CREDENTIAL_UNAVAILABLE")
    registry = json.loads(raw.decode("utf-8", "strict"))
    store = registry.get(store_id) if isinstance(registry, dict) else None
    if not isinstance(store, dict) or str(store.get("clientId")) != store_id or store.get("market", "Ozon") != "Ozon":
        raise TransportFailure("STORE_MISSING")
    ciphertext = store.get("key")
    if not isinstance(ciphertext, str) or not 1 <= len(ciphertext) <= 65536:
        raise TransportFailure("CREDENTIAL_UNAVAILABLE")
    return decrypt_current_user(ciphertext)


def resolve(sd, deadline):
    cached = sd.get("ozon_http_dns")
    if cached and time.monotonic() < cached[0]:
        return cached[1]
    pending = sd.get("ozon_http_dns_pending")
    if pending is None:
        result = queue.Queue(maxsize=1)
        def lookup():
            try:
                result.put(socket.getaddrinfo(HOST, PORT, type=socket.SOCK_STREAM))
            except Exception:
                result.put(None)
        worker = threading.Thread(target=lookup, name="pult-ozon-dns", daemon=True)
        pending = (worker, result)
        sd["ozon_http_dns_pending"] = pending
        worker.start()
    try:
        addresses = pending[1].get(timeout=remaining(deadline))
    except queue.Empty:
        raise TransportFailure("TIMEOUT") from None
    finally:
        if not pending[0].is_alive():
            sd.pop("ozon_http_dns_pending", None)
    # The queue item has been consumed even if the resolver is finishing its
    # last instruction. The next call may create one new completed-DNS request.
    sd.pop("ozon_http_dns_pending", None)
    if not addresses:
        raise TransportFailure("NETWORK_ERROR")
    addresses = [entry for entry in addresses if entry[0] in (socket.AF_INET, socket.AF_INET6)
                 and ipaddress.ip_address(entry[4][0]).is_global]
    if not addresses:
        raise TransportFailure("NETWORK_ERROR")
    sd["ozon_http_dns"] = (time.monotonic() + 60, addresses)
    return addresses


class DeadlineReader(io.RawIOBase):
    def __init__(self, sock, deadline):
        super().__init__()
        self.sock = sock
        self.deadline = deadline
        # SocketIO owns the normal socket.makefile reference: HTTPConnection
        # may close its reference on Connection: close before reading the body.
        self.raw = sock.makefile("rb", buffering=0)

    def readable(self):
        return True

    def readinto(self, target):
        self.sock.settimeout(remaining(self.deadline))
        return self.raw.readinto(target)

    def close(self):
        try:
            self.raw.close()
        finally:
            super().close()


class DeadlineSocket:
    def __init__(self, sock, deadline):
        self.sock = sock
        self.deadline = deadline

    def makefile(self, mode, buffering=None):
        if mode != "rb":
            raise TransportFailure("NETWORK_ERROR")
        return io.BufferedReader(DeadlineReader(self.sock, self.deadline))

    def sendall(self, value):
        self.sock.settimeout(remaining(self.deadline))
        self.sock.sendall(value)

    def close(self):
        self.sock.close()


def connect(sd, deadline):
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    # Explicit even though create_default_context sets both: never allow a
    # custom URL, CA bundle, proxy, redirect, disabled validation or hostname.
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    addresses = resolve(sd, deadline)
    for family, kind, protocol, _, address in addresses:
        raw = None
        try:
            raw = socket.socket(family, kind, protocol)
            raw.settimeout(remaining(deadline))
            raw.connect(address)
            raw.settimeout(remaining(deadline))
            secured = context.wrap_socket(raw, server_hostname=HOST, do_handshake_on_connect=False)
            raw = secured
            secured.settimeout(remaining(deadline))
            secured.do_handshake()
            return DeadlineSocket(secured, deadline)
        except ssl.SSLError:
            if raw is not None:
                raw.close()
            raise TransportFailure("TLS_ERROR") from None
        except (OSError, TransportFailure):
            if raw is not None:
                raw.close()
            remaining(deadline)
    raise TransportFailure("NETWORK_ERROR")


def retry_after(headers):
    value = headers.get("Retry-After") or headers.get("X-Ratelimit-Retry")
    if not value or len(value) > 128:
        return None
    try:
        seconds = float(value)
        if not math.isfinite(seconds) or seconds < 0:
            return None
    except (ValueError, TypeError):
        try:
            seconds = max(0, parsedate_to_datetime(value).timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            return None
    return min(86400000, math.ceil(seconds * 1000))


def validate_response_json(data, deadline):
    # Python's JSON parser accepts values that PostgreSQL jsonb cannot encode:
    # overflowed floats, NUL and unpaired UTF-16 surrogates. Reject them inside
    # the sanitized boundary, before PL/Python attempts its SQL conversion.
    pending = [data]
    while pending:
        remaining(deadline)
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value.keys())
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, float) and not math.isfinite(value):
            raise TransportFailure("INVALID_RESPONSE")
        elif isinstance(value, str):
            if "\x00" in value:
                raise TransportFailure("INVALID_RESPONSE")
            value.encode("utf-8", "strict")


def request(sd, store_id, key, route, body, deadline):
    connection = http.client.HTTPConnection(HOST, PORT)
    response = None
    try:
        connection.sock = connect(sd, deadline)
        connection.request("POST", route, body=body, headers={
            "Host": HOST, "Client-Id": store_id, "Api-Key": key,
            "Content-Type": "application/json", "Accept": "application/json",
            "Accept-Encoding": "identity", "Connection": "close",
        })
        response = connection.getresponse()
        status = response.status
        if not 200 <= status <= 299:
            code = "AUTH_FAILED" if status in (401, 403) else "RATE_LIMITED" if status == 429 else "HTTP_ERROR"
            return failure(code, status, retry_after(response.headers))
        if response.headers.get("Content-Encoding", "identity").lower() not in ("identity", ""):
            raise TransportFailure("INVALID_RESPONSE")
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            if not content_length.isdigit():
                raise TransportFailure("INVALID_RESPONSE")
            if int(content_length) > MAX_RESPONSE_BYTES:
                raise TransportFailure("RESPONSE_TOO_LARGE")
        chunks, size = [], 0
        while True:
            remaining(deadline)
            chunk = response.read(min(65536, MAX_RESPONSE_BYTES + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise TransportFailure("RESPONSE_TOO_LARGE")
            chunks.append(chunk)
        raw = b"".join(chunks)
        if status == 204:
            data = {}
        else:
            data = json.loads(raw.decode("utf-8", "strict"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(data, (dict, list)):
                raise TransportFailure("INVALID_RESPONSE")
        validate_response_json(data, deadline)
        # Reject an unexpected credential echo, including escaped JSON strings.
        if key in json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")):
            raise TransportFailure("INVALID_RESPONSE")
        remaining(deadline)
        return {"ok": True, "status": status, "data": data}
    finally:
        if response is not None:
            response.close()
        connection.close()


def execute(plpy, sd, store_id, route, payload, timeout_ms, state_schema):
    key = None
    try:
        if (not isinstance(store_id, str) or not re.fullmatch(r"[0-9]{1,32}", store_id)
                or route not in READ_ROUTES or isinstance(timeout_ms, bool)
                or not isinstance(timeout_ms, int) or not 1 <= timeout_ms <= 120000):
            raise TransportFailure("INVALID_ARGUMENT")
        deadline = time.monotonic() + timeout_ms / 1000.0
        if not isinstance(payload, str) or len(payload.encode("utf-8")) > MAX_REQUEST_BYTES:
            raise TransportFailure("INVALID_ARGUMENT")
        parsed = json.loads(payload, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(parsed, dict):
            raise TransportFailure("INVALID_ARGUMENT")
        body = json.dumps(parsed, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(body) > MAX_REQUEST_BYTES:
            raise TransportFailure("INVALID_ARGUMENT")
        try:
            key = load_key(plpy, store_id, state_schema)
        except TransportFailure:
            raise
        except Exception:
            raise TransportFailure("CREDENTIAL_UNAVAILABLE") from None
        remaining(deadline)
        result = request(sd, store_id, key, route, body, deadline)
    except TransportFailure as exc:
        result = failure(exc.code)
    except ssl.SSLError:
        result = failure("TLS_ERROR")
    except (TimeoutError, socket.timeout):
        result = failure("TIMEOUT")
    except (ValueError, UnicodeError, RecursionError, http.client.HTTPException):
        result = failure("INVALID_RESPONSE")
    except Exception:
        result = failure("NETWORK_ERROR")
    finally:
        key = None
    # No errors, exception strings, headers, keys, or upstream error body go to
    # PostgreSQL notices/logs or the caller. Successful JSON goes to collectors.
    return json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def verify_connection(plpy, sd, client_id, protected_key, timeout_ms):
    key = None
    try:
        if (not isinstance(client_id, str) or not re.fullmatch(r"[0-9]{1,32}", client_id)
                or not isinstance(protected_key, str) or not 1 <= len(protected_key) <= 65536
                or isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int)
                or not 1 <= timeout_ms <= 120000):
            raise TransportFailure("INVALID_ARGUMENT")
        deadline = time.monotonic() + timeout_ms / 1000.0
        key = decrypt_current_user(protected_key)
        remaining(deadline)
        result = request(sd, client_id, key, "/v3/product/list",
                         b'{"filter":{"visibility":"ALL"},"last_id":"","limit":1}', deadline)
        # A provisional credential cannot select arbitrary operations and does
        # not expose even the one product used to validate the connection.
        result.pop("data", None)
    except TransportFailure as exc:
        result = failure(exc.code)
    except ssl.SSLError:
        result = failure("TLS_ERROR")
    except (TimeoutError, socket.timeout):
        result = failure("TIMEOUT")
    except (ValueError, UnicodeError, RecursionError, http.client.HTTPException):
        result = failure("INVALID_RESPONSE")
    except Exception:
        result = failure("NETWORK_ERROR")
    finally:
        key = None
    return json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
