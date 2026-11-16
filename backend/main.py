from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import base64
import sys
import threading
import time as time_module

# Garante acesso aos pacotes locais portáteis em qualquer computador (sem depender de caminho fixo)
for _extra_dir in (
    Path(__file__).resolve().parent / "vendor",
    Path(__file__).resolve().parent.parent / ".venv" / "Lib" / "site-packages",
):
    if _extra_dir.exists() and str(_extra_dir) not in sys.path:
        sys.path.append(str(_extra_dir))

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    serial = None

try:
    from mqtt_cloud import gateway_nuvem, MQTT_TOPIC
except ImportError:
    from backend.mqtt_cloud import gateway_nuvem, MQTT_TOPIC

from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(__file__).resolve().parent / "cyclospot.db"
SECRET_KEY = os.getenv("CYCLOSPOT_SECRET", "troque-esta-chave-antes-de-publicar-123456")
TOKEN_HOURS = 12

app = FastAPI(title="API CycloSpot", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Em produção, restrinja ao domínio do frontend.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def conectar():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def inicializar_banco():
    with conectar() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS bike_parks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            capacity INTEGER NOT NULL DEFAULT 30 CHECK(capacity BETWEEN 1 AND 30),
            hours TEXT NOT NULL DEFAULT '24 horas',
            is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL,
            selected_bike_park_id INTEGER REFERENCES bike_parks(id)
        );
        CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            bike_park_id INTEGER NOT NULL DEFAULT 1 REFERENCES bike_parks(id),
            slot_number INTEGER NOT NULL CHECK(slot_number BETWEEN 1 AND 30),
            reservation_date TEXT NOT NULL,
            reservation_time TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'confirmed',
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_reservation_date_time
        ON reservations(reservation_date, reservation_time, status);
        CREATE INDEX IF NOT EXISTS idx_reservation_user ON reservations(user_id);
        """)

        # Unidade piloto com 3 vagas físicas monitoradas por sensor ultrassônico.
        con.execute(
            """INSERT OR IGNORE INTO bike_parks(id,name,address,capacity,hours,is_active)
               VALUES(1,?,?,?,?,1)""",
            ("CycloSpot — Unidade Piloto", "Bloco A - Térreo", 3, "24 horas")
        )
        con.execute("UPDATE bike_parks SET capacity=3 WHERE id=1")

        # Migra bancos criados com a primeira versão do projeto, sem apagar dados.
        user_columns = {row[1] for row in con.execute("PRAGMA table_info(users)").fetchall()}
        if "selected_bike_park_id" not in user_columns:
            con.execute(
                "ALTER TABLE users ADD COLUMN selected_bike_park_id INTEGER REFERENCES bike_parks(id)"
            )

        reservation_columns = {row[1] for row in con.execute("PRAGMA table_info(reservations)").fetchall()}
        if "bike_park_id" not in reservation_columns:
            con.execute(
                "ALTER TABLE reservations ADD COLUMN bike_park_id INTEGER NOT NULL DEFAULT 1"
            )
        con.execute("CREATE INDEX IF NOT EXISTS idx_reservation_park ON reservations(bike_park_id)")


def agora():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def hash_senha(senha: str) -> str:
    salt = secrets.token_bytes(16)
    resultado = hashlib.pbkdf2_hmac("sha256", senha.encode(), salt, 240000)
    return base64.b64encode(salt + resultado).decode()


def verificar_senha(senha: str, armazenado: str) -> bool:
    try:
        dados = base64.b64decode(armazenado.encode())
        salt, esperado = dados[:16], dados[16:]
        atual = hashlib.pbkdf2_hmac("sha256", senha.encode(), salt, 240000)
        return hmac.compare_digest(atual, esperado)
    except Exception:
        return False


def gerar_token(usuario):
    payload = {
        "sub": usuario["id"],
        "role": usuario["role"],
        "exp": int((datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS)).timestamp())
    }
    corpo = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    assinatura = hmac.new(SECRET_KEY.encode(), corpo.encode(), hashlib.sha256).digest()
    assinatura = base64.urlsafe_b64encode(assinatura).decode().rstrip("=")
    return corpo + "." + assinatura


def usuario_atual(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Faça login para continuar.")
    token = authorization[7:]
    try:
        corpo, assinatura = token.split(".")
        esperada = hmac.new(SECRET_KEY.encode(), corpo.encode(), hashlib.sha256).digest()
        esperada = base64.urlsafe_b64encode(esperada).decode().rstrip("=")
        if not hmac.compare_digest(assinatura, esperada):
            raise ValueError()
        payload = json.loads(base64.urlsafe_b64decode(corpo + "=" * (-len(corpo) % 4)))
        if payload["exp"] < int(datetime.now(timezone.utc).timestamp()):
            raise ValueError()
        with conectar() as con:
            usuario = con.execute("SELECT id,name,email,role,selected_bike_park_id FROM users WHERE id=?", (payload["sub"],)).fetchone()
        if not usuario:
            raise ValueError()
        return dict(usuario)
    except Exception:
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada. Entre novamente.")


def administrador(usuario=Depends(usuario_atual)):
    if usuario["role"] != "admin":
        raise HTTPException(status_code=403, detail="Acesso permitido somente para administradores.")
    return usuario


class Cadastro(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class Login(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class NovaReserva(BaseModel):
    date: date
    time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    slot_number: int = Field(ge=1, le=30)
    bike_park_id: int = Field(ge=1)


class EscolhaBicicletario(BaseModel):
    bike_park_id: int = Field(ge=1)


# ==============================================================================
# INTEGRAÇÃO HARDWARE ARDUINO VIA CABO USB (SENSORES ULTRASSÔNICOS HC-SR04)
# ==============================================================================
LIMITE_CM_ARDUINO = 3  # Distância limite em cm configurada no Arduino

estado_arduino = {
    "connected": False,
    "port": None,
    "distances": {1: 999, 2: 999, 3: 999},
    "occupied_slots": set(),
    "activities": [
        {"type": "entrada", "label": "Entrada de bicicleta", "time": "14:28"},
        {"type": "saida", "label": "Saída de bicicleta", "time": "14:15"},
        {"type": "entrada", "label": "Entrada de bicicleta", "time": "14:03"},
        {"type": "saida", "label": "Saída de bicicleta", "time": "13:47"},
        {"type": "entrada", "label": "Entrada de bicicleta", "time": "13:29"},
    ],
}
_leitor_iniciado = False


def _publicar_nuvem():
    ocupadas_sensor = sorted(list(estado_arduino["occupied_slots"]))
    gateway_nuvem.publicar({
        "source": "gateway_python",
        "connected": estado_arduino["connected"],
        "port": estado_arduino["port"] or "USB",
        "occupied_slots": ocupadas_sensor,
        "occupied_count": len(ocupadas_sensor),
        "free_count": 3 - len(ocupadas_sensor),
        "distances": estado_arduino["distances"],
        "activities": estado_arduino["activities"][:6],
    })


def _atualizar_vaga_sensor(num_vaga: int, dist_cm: int):
    if num_vaga not in (1, 2, 3):
        return
    mudou_dist = estado_arduino["distances"].get(num_vaga) != dist_cm
    estado_arduino["distances"][num_vaga] = dist_cm
    estava_ocupada = num_vaga in estado_arduino["occupied_slots"]
    agora_ocupada = 0 < dist_cm <= LIMITE_CM_ARDUINO

    if agora_ocupada and not estava_ocupada:
        estado_arduino["occupied_slots"].add(num_vaga)
        horario = datetime.now().strftime("%H:%M")
        estado_arduino["activities"].insert(0, {
            "type": "entrada",
            "label": f"Entrada de bicicleta (Vaga 0{num_vaga})",
            "time": horario
        })
        del estado_arduino["activities"][8:]
        _publicar_nuvem()
    elif not agora_ocupada and estava_ocupada:
        estado_arduino["occupied_slots"].discard(num_vaga)
        horario = datetime.now().strftime("%H:%M")
        estado_arduino["activities"].insert(0, {
            "type": "saida",
            "label": f"Saída de bicicleta (Vaga 0{num_vaga})",
            "time": horario
        })
        del estado_arduino["activities"][8:]
        _publicar_nuvem()
    elif mudou_dist:
        _publicar_nuvem()


def _processar_linha_arduino(linha: str):
    linha = linha.strip()
    if not linha:
        return

    # Formato 1: JSON -> {"ocupadas":1,"livres":2,"vaga1":2,"vaga2":999,"vaga3":999}
    if linha.startswith("{") and linha.endswith("}"):
        try:
            dados = json.loads(linha)
            for idx in (1, 2, 3):
                chave = f"vaga{idx}"
                if chave in dados:
                    _atualizar_vaga_sensor(idx, int(dados[chave]))
            return
        except Exception:
            pass

    # Formato 2: Texto original do Arduino -> "Vaga 1: 2 cm"
    if linha.lower().startswith("vaga"):
        try:
            partes = linha.replace(":", "").split()
            num_vaga = int(partes[1])
            dist_cm = int(float(partes[2]))
            _atualizar_vaga_sensor(num_vaga, dist_cm)
            return
        except Exception:
            pass

    # Formato 3: CSV "ocupadas,livres" (ex: "1,2")
    if "," in linha and not linha.startswith("{"):
        partes = [p.strip() for p in linha.split(",")]
        if len(partes) == 2 and all(p.isdigit() for p in partes):
            ocup = int(partes[0])
            for idx in (1, 2, 3):
                _atualizar_vaga_sensor(idx, 2 if idx <= ocup else 999)
        elif len(partes) == 3 and all(p.isdigit() for p in partes):
            for idx, val in enumerate(partes, start=1):
                _atualizar_vaga_sensor(idx, 2 if int(val) == 1 else 999)


def _detectar_porta_arduino():
    if not serial:
        return None
    portas = list(serial.tools.list_ports.comports())
    # 1. Prioriza portas que tenham Arduino/USB/CH340/CP210 no nome ou no VID/PID USB
    for p in portas:
        desc = (p.description or "").lower()
        hwid = (p.hwid or "").lower()
        if any(k in desc or k in hwid for k in ["arduino", "ch340", "usb", "cp210", "ftdi", "vid_"]):
            return p.device
    # 2. Caso contrário, usa qualquer porta diferente da COM1 interna da placa-mãe
    for p in portas:
        if p.device.upper() != "COM1":
            return p.device
    return None


def _loop_leitor_serial():
    while True:
        porta = _detectar_porta_arduino()
        if not porta:
            estado_arduino["connected"] = False
            estado_arduino["port"] = None
            time_module.sleep(2)
            continue
        try:
            with serial.Serial(porta, 9600, timeout=1) as conn:
                estado_arduino["connected"] = True
                estado_arduino["port"] = porta
                print(f"[CycloSpot Hardware] Arduino conectado em {porta} (9600 baud)")
                while True:
                    raw = conn.readline().decode("utf-8", errors="ignore")
                    if raw:
                        _processar_linha_arduino(raw)
        except Exception:
            estado_arduino["connected"] = False
            time_module.sleep(2)


@app.on_event("startup")
def iniciar():
    global _leitor_iniciado
    inicializar_banco()
    gateway_nuvem.iniciar()
    _publicar_nuvem()
    if not _leitor_iniciado:
        _leitor_iniciado = True
        threading.Thread(target=_loop_leitor_serial, daemon=True).start()


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "service": "CycloSpot",
        "arduino_connected": estado_arduino["connected"],
        "arduino_port": estado_arduino["port"],
        "mqtt_cloud_connected": gateway_nuvem.conectado_nuvem,
        "mqtt_topic": MQTT_TOPIC
    }


@app.get("/api/sensors")
def sensores_tempo_real():
    """Retorna em tempo real o estado das 3 vagas monitoradas pelo Arduino via cabo USB."""
    ocupadas_sensor = sorted(list(estado_arduino["occupied_slots"]))
    return {
        "connected": estado_arduino["connected"],
        "port": estado_arduino["port"],
        "mqtt_cloud_connected": gateway_nuvem.conectado_nuvem,
        "mqtt_broker": gateway_nuvem.broker_ativo,
        "mqtt_topic": MQTT_TOPIC,
        "occupied_slots": ocupadas_sensor,
        "occupied_count": len(ocupadas_sensor),
        "free_count": 3 - len(ocupadas_sensor),
        "distances": estado_arduino["distances"],
        "activities": estado_arduino["activities"]
    }


@app.post("/api/sensors/toggle/{num_vaga}")
def alternar_sensor_teste(num_vaga: int):
    """Permite simular a ocupação/liberação física das Vagas 1, 2 ou 3 e publica na nuvem IoT."""
    if num_vaga not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="Apenas as vagas 1, 2 e 3 possuem sensores ultrassônicos.")
    nova_dist = 999 if num_vaga in estado_arduino["occupied_slots"] else 2
    _atualizar_vaga_sensor(num_vaga, nova_dist)
    return sensores_tempo_real()


@app.post("/api/register")
def registrar(dados: Cadastro):
    email = dados.email.lower()
    with conectar() as con:
        existe = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if existe:
            raise HTTPException(status_code=409, detail="Este e-mail já está cadastrado.")
        cursor = con.execute(
            "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
            (dados.name.strip(), email, hash_senha(dados.password), "user", agora())
        )
        usuario = con.execute("SELECT id,name,email,role FROM users WHERE id=?", (cursor.lastrowid,)).fetchone()
    usuario = dict(usuario)
    return {"access_token": gerar_token(usuario), "token_type": "bearer", "user": usuario}


@app.post("/api/login")
def login(dados: Login):
    with conectar() as con:
        usuario = con.execute("SELECT * FROM users WHERE email=?", (dados.email.lower(),)).fetchone()
    if not usuario or not verificar_senha(dados.password, usuario["password_hash"]):
        raise HTTPException(status_code=401, detail="E-mail ou senha incorretos.")
    usuario_publico = {k: usuario[k] for k in ("id", "name", "email", "role")}
    return {"access_token": gerar_token(usuario_publico), "token_type": "bearer", "user": usuario_publico}


@app.get("/api/me")
def me(usuario=Depends(usuario_atual)):
    return usuario


@app.get("/api/bike-parks")
def listar_bicicletarios(_=Depends(usuario_atual)):
    with conectar() as con:
        rows = con.execute(
            "SELECT id,name,address,capacity,hours FROM bike_parks WHERE is_active=1 ORDER BY name"
        ).fetchall()
    return [dict(row) for row in rows]


@app.patch("/api/me/bike-park")
def selecionar_bicicletario(dados: EscolhaBicicletario, usuario=Depends(usuario_atual)):
    with conectar() as con:
        parque = con.execute(
            "SELECT id FROM bike_parks WHERE id=? AND is_active=1", (dados.bike_park_id,)
        ).fetchone()
        if not parque:
            raise HTTPException(status_code=404, detail="Bicicletário não encontrado ou indisponível.")
        con.execute(
            "UPDATE users SET selected_bike_park_id=? WHERE id=?",
            (dados.bike_park_id, usuario["id"])
        )
    return {"message": "Bicicletário selecionado.", "bike_park_id": dados.bike_park_id}


@app.get("/api/slots")
def vagas(date: date, time: str = "08:00", bike_park_id: int = 1,
          _=Depends(usuario_atual)):
    if not __import__("re").fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", time):
        raise HTTPException(status_code=400, detail="Horário inválido.")
    with conectar() as con:
        parque = con.execute(
            "SELECT capacity FROM bike_parks WHERE id=? AND is_active=1", (bike_park_id,)
        ).fetchone()
        if not parque:
            raise HTTPException(status_code=404, detail="Bicicletário não encontrado.")
        ocupadas = {
            row["slot_number"] for row in con.execute(
                """SELECT slot_number FROM reservations
                   WHERE bike_park_id=? AND reservation_date=? AND reservation_time=? AND status='confirmed'""",
                (bike_park_id, date.isoformat(), time)
            ).fetchall()
        }
        # Integra em tempo real as 3 vagas físicas do Arduino (Vagas 1, 2 e 3)
        ocupadas_totais = ocupadas | set(estado_arduino["occupied_slots"])
    return {"capacity": parque["capacity"],
            "arduino_connected": estado_arduino["connected"],
            "arduino_port": estado_arduino["port"],
            "slots": [{"number": n,
                       "available": n not in ocupadas_totais,
                       "sensor_occupied": n in estado_arduino["occupied_slots"]}
                      for n in range(1, parque["capacity"] + 1)]}


@app.post("/api/reservations")
def criar_reserva(dados: NovaReserva, usuario=Depends(usuario_atual)):
    if dados.date < date.today():
        raise HTTPException(status_code=400, detail="Não é possível reservar uma data passada.")
    with conectar() as con:
        parque = con.execute(
            "SELECT capacity FROM bike_parks WHERE id=? AND is_active=1", (dados.bike_park_id,)
        ).fetchone()
        if not parque:
            raise HTTPException(status_code=404, detail="Bicicletário não encontrado ou indisponível.")
        if dados.slot_number > parque["capacity"]:
            raise HTTPException(status_code=400, detail="Esta vaga não existe neste bicicletário.")
        existe = con.execute(
            """SELECT id FROM reservations
               WHERE bike_park_id=? AND slot_number=? AND reservation_date=?
                 AND reservation_time=? AND status='confirmed'""",
            (dados.bike_park_id, dados.slot_number, dados.date.isoformat(), dados.time)
        ).fetchone()
        if existe:
            raise HTTPException(status_code=409, detail="Esta vaga já foi reservada nesse horário.")
        cursor = con.execute(
            """INSERT INTO reservations(user_id,bike_park_id,slot_number,reservation_date,
                       reservation_time,status,created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (usuario["id"], dados.bike_park_id, dados.slot_number, dados.date.isoformat(),
             dados.time, "confirmed", agora())
        )
        return {"id": cursor.lastrowid, "message": "Reserva registrada com sucesso.", "status": "confirmed"}


@app.get("/api/reservations/mine")
def minhas_reservas(usuario=Depends(usuario_atual)):
    with conectar() as con:
        rows = con.execute(
            """SELECT r.id,r.slot_number,r.reservation_date,r.reservation_time,r.status,
                      p.name AS bike_park_name
               FROM reservations r JOIN bike_parks p ON p.id=r.bike_park_id
               WHERE r.user_id=? ORDER BY r.reservation_date DESC,r.reservation_time DESC""",
            (usuario["id"],)
        ).fetchall()
    return [{"id": r["id"], "slot_number": r["slot_number"], "date": r["reservation_date"],
             "time": r["reservation_time"], "status": r["status"],
             "bike_park_name": r["bike_park_name"]} for r in rows]


@app.get("/api/admin/reservations")
def reservas_admin(_=Depends(administrador)):
    with conectar() as con:
        rows = con.execute(
            """SELECT r.id,u.name AS user_name,u.email,r.slot_number,
                      r.reservation_date,r.reservation_time,r.status,p.name AS bike_park_name
               FROM reservations r JOIN users u ON u.id=r.user_id
               JOIN bike_parks p ON p.id=r.bike_park_id
               ORDER BY r.reservation_date DESC,r.reservation_time DESC"""
        ).fetchall()
    return [{"id":r["id"],"user_name":r["user_name"],"email":r["email"],
             "slot_number":r["slot_number"],"date":r["reservation_date"],
             "time":r["reservation_time"],"status":r["status"],
             "bike_park_name":r["bike_park_name"]} for r in rows]


@app.delete("/api/admin/reservations/{reservation_id}")
def cancelar_reserva(reservation_id: int, _=Depends(administrador)):
    with conectar() as con:
        cursor = con.execute(
            "UPDATE reservations SET status='cancelled' WHERE id=? AND status!='cancelled'",
            (reservation_id,)
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Reserva não encontrada ou já cancelada.")
    return {"message": "Reserva cancelada."}


@app.get("/api/admin/users")
def usuarios_admin(_=Depends(administrador)):
    with conectar() as con:
        rows = con.execute(
            """SELECT u.id,u.name,u.email,COUNT(r.id) AS reservation_count,
                      MAX(r.reservation_date || ' ' || r.reservation_time) AS last_reservation
               FROM users u LEFT JOIN reservations r ON r.user_id=u.id AND r.status='confirmed'
               WHERE u.role='user' GROUP BY u.id ORDER BY reservation_count DESC,u.name"""
        ).fetchall()
    resultado = []
    for r in rows:
        total = r["reservation_count"]
        if total >= 3:
            classificacao = "Frequente"
        elif total == 1:
            classificacao = "Uma visita"
        elif total == 2:
            classificacao = "Retornou"
        else:
            classificacao = "Sem reservas"
        resultado.append({"id":r["id"],"name":r["name"],"email":r["email"],
                          "reservation_count":total,"last_reservation":r["last_reservation"],
                          "classification":classificacao})
    return resultado


@app.get("/api/admin/reports")
def relatorios(period: str = "30", bike_park_id: int | None = None,
               _=Depends(administrador)):
    if period not in {"7", "30", "all"}:
        raise HTTPException(status_code=400, detail="Período inválido.")

    filtros = ["status='confirmed'"]
    parametros = []
    if period in {"7", "30"}:
        dias = int(period)
        data_inicial = (date.today() - timedelta(days=dias - 1)).isoformat()
        filtros.append("reservation_date BETWEEN ? AND ?")
        parametros.extend([data_inicial, date.today().isoformat()])
    if bike_park_id is not None:
        filtros.append("bike_park_id = ?")
        parametros.append(bike_park_id)
    where = " AND ".join(filtros)

    with conectar() as con:
        resumo = con.execute(
            f"""SELECT COUNT(*) AS total,
                       COUNT(DISTINCT user_id) AS usuarios,
                       MIN(reservation_date) AS primeira_data,
                       MAX(reservation_date) AS ultima_data
                FROM reservations WHERE {where}""", parametros
        ).fetchone()
        horas = con.execute(
            f"""SELECT CAST(substr(reservation_time,1,2) AS INTEGER) AS hora, COUNT(*) AS total
                FROM reservations WHERE {where}
                GROUP BY substr(reservation_time,1,2)""", parametros
        ).fetchall()
        dias_semana = con.execute(
            f"""SELECT CAST(strftime('%w',reservation_date) AS INTEGER) AS dia, COUNT(*) AS total
                FROM reservations WHERE {where}
                GROUP BY strftime('%w',reservation_date)""", parametros
        ).fetchall()

    total = resumo["total"] or 0
    contagem_horas = {int(row["hora"]): row["total"] for row in horas}
    by_hour = [{"hour": f"{hora:02d}:00", "total": contagem_horas.get(hora, 0)}
               for hora in range(24)]
    horas_com_movimento = [item for item in by_hour if item["total"] > 0]
    quiet_hours = [item["hour"] for item in by_hour if item["total"] == 0] if total else []
    peak_hour = max(horas_com_movimento, key=lambda item: item["total"])["hour"] if total else None
    low_hour = min(horas_com_movimento, key=lambda item: item["total"])["hour"] if total else None

    nomes_dias = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"]
    contagem_dias = {int(row["dia"]): row["total"] for row in dias_semana}
    by_weekday = [{"day": nomes_dias[(i + 1) % 7], "total": contagem_dias.get((i + 1) % 7, 0)}
                  for i in range(7)]  # segunda a domingo

    if period in {"7", "30"}:
        dias_analisados = int(period)
    elif resumo["primeira_data"] and resumo["ultima_data"]:
        inicio = date.fromisoformat(resumo["primeira_data"])
        fim = date.fromisoformat(resumo["ultima_data"])
        dias_analisados = max((fim - inicio).days + 1, 1)
    else:
        dias_analisados = 1

    return {
        "total_reservations": total,
        "active_reservations": total,
        "total_users": resumo["usuarios"] or 0,
        "average_per_day": round(total / dias_analisados, 1),
        "peak_hour": peak_hour,
        "low_hour": low_hour,
        "quiet_hours": quiet_hours,
        "by_hour": by_hour,
        "by_weekday": by_weekday,
        "period_days": period
    }


# Os arquivos HTML/CSS/JS existentes são servidos pela própria aplicação.
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="frontend")
