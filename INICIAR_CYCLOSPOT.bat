@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONPATH=%~dp0.venv\Lib\site-packages"

echo ============================================================================
echo   CYCLOSPOT + ARDUINO USB - INICIALIZADOR UNIVERSAL (QUALQUER PC)
echo   IMPORTANTE: Feche o Monitor Serial da Arduino IDE antes de usar!
echo ============================================================================

REM Verifica se o Python deste PC possui fastapi, uvicorn, email_validator e pyserial
python -c "import fastapi, uvicorn, email_validator, serial" 2>nul
if %errorlevel% neq 0 (
    echo [1/2] Instalando bibliotecas necessarias neste computador...
    python -m pip install -r requirements.txt
)

echo [2/2] Iniciando servidor na porta 8001...
cd /d "%~dp0backend"
start "" "http://127.0.0.1:8001"
python -m uvicorn main:app --reload --port 8001
pause
