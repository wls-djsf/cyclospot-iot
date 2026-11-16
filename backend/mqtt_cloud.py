"""
Módulo Gateway IoT Cloud (MQTT v3.1.1 Nativo em Python Puro).
Publica em tempo real os dados dos sensores do Arduino (conectado via cabo USB)
para os brokers públicos MQTT em nuvem (EMQX e HiveMQ), permitindo que o site
hospedado no GitHub Pages atualize instantaneamente em qualquer celular ou PC.
"""

import json
import secrets
import socket
import threading
import time

MQTT_TOPIC = "cyclospot/italo/2026/telemetria"
MQTT_BROKERS = [
    ("broker.emqx.io", 1883),
    ("broker.hivemq.com", 1883),
]


def _encode_varint(length: int) -> bytes:
    out = bytearray()
    while True:
        byte = length % 128
        length //= 128
        if length > 0:
            byte |= 0x80
        out.append(byte)
        if length == 0:
            break
    return bytes(out)


def _encode_utf8(texto: str) -> bytes:
    b = texto.encode("utf-8")
    return len(b).to_bytes(2, "big") + b


def _montar_pacote_connect(client_id: str) -> bytes:
    var_header = _encode_utf8("MQTT") + b"\x04\x02\x00\x3c"
    payload = _encode_utf8(client_id)
    corpo = var_header + payload
    return b"\x10" + _encode_varint(len(corpo)) + corpo


def _montar_pacote_publish(topic: str, mensagem_json: str, retain: bool = True) -> bytes:
    header_byte = b"\x31" if retain else b"\x30"
    topico_bytes = _encode_utf8(topic)
    payload_bytes = mensagem_json.encode("utf-8")
    corpo = topico_bytes + payload_bytes
    return header_byte + _encode_varint(len(corpo)) + corpo


class GatewayMQTTCloud:
    def __init__(self):
        self.ultimo_payload = None
        self.conectado_nuvem = False
        self.broker_ativo = None
        self._lock = threading.Lock()
        self._evento_novo = threading.Event()
        self._iniciado = False

    def iniciar(self):
        if self._iniciado:
            return
        self._iniciado = True
        for host, port in MQTT_BROKERS:
            threading.Thread(
                target=self._worker_broker,
                args=(host, port),
                daemon=True
            ).start()

    def publicar(self, dados: dict):
        with self._lock:
            dados_envio = dict(dados)
            dados_envio["timestamp_ms"] = int(time.time() * 1000)
            self.ultimo_payload = json.dumps(dados_envio, ensure_ascii=False)
        self._evento_novo.set()

    def _worker_broker(self, host: str, port: int):
        client_id = f"cyclospot-gw-{secrets.token_hex(4)}"
        while True:
            sock = None
            try:
                sock = socket.create_connection((host, port), timeout=5)
                sock.sendall(_montar_pacote_connect(client_id))
                resp = sock.recv(4)
                if len(resp) < 4 or resp[0] != 0x20 or resp[3] != 0x00:
                    raise RuntimeError("CONNACK invalido")

                self.conectado_nuvem = True
                self.broker_ativo = f"{host}:{port}"
                sock.settimeout(0.2)
                ultimo_enviado = ""
                ultimo_ping = time.time()

                while True:
                    self._evento_novo.wait(timeout=1.0)
                    self._evento_novo.clear()

                    with self._lock:
                        payload_atual = self.ultimo_payload

                    agora = time.time()
                    if payload_atual and (payload_atual != ultimo_enviado or (agora - ultimo_ping) >= 3.0):
                        pacote = _montar_pacote_publish(MQTT_TOPIC, payload_atual, retain=True)
                        sock.sendall(pacote)
                        ultimo_enviado = payload_atual

                    if (agora - ultimo_ping) >= 20.0:
                        sock.sendall(b"\xc0\x00")  # MQTT PINGREQ
                        ultimo_ping = agora

                    try:
                        sock.recv(128)
                    except socket.timeout:
                        pass
            except Exception:
                time.sleep(3)
            finally:
                if sock:
                    try:
                        sock.close()
                    except Exception:
                        pass


gateway_nuvem = GatewayMQTTCloud()
