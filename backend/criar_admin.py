"""Cria ou promove uma conta para administrador. Execute: python criar_admin.py"""
import getpass
import sqlite3
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from main import DB_PATH, hash_senha, inicializar_banco

inicializar_banco()
nome = input("Nome do administrador: ").strip()
email = input("E-mail do administrador: ").strip().lower()
senha = getpass.getpass("Senha (mínimo 8 caracteres): ")
if len(nome) < 2 or len(senha) < 8 or "@" not in email:
    raise SystemExit("Dados inválidos. Confira nome, e-mail e senha.")

with sqlite3.connect(DB_PATH) as con:
    existente = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if existente:
        con.execute("UPDATE users SET role='admin',name=?,password_hash=? WHERE email=?",
                    (nome, hash_senha(senha), email))
        print("Conta existente promovida para administradora.")
    else:
        from datetime import datetime
        con.execute(
            "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
            (nome,email,hash_senha(senha),"admin",datetime.now().astimezone().isoformat())
        )
        print("Administrador criado com sucesso.")
