@echo off
setlocal
cd /d "%~dp0"

echo Preparando la version mas reciente de Four Kingdoms...
call npm run build
if errorlevel 1 (
  echo No se pudo preparar el juego.
  pause
  exit /b 1
)

echo Abriendo Four Kingdoms 2v2 en modo seguro...
start "Four Kingdoms - servidor local" /min cmd /c "npm run preview -- --port 4173"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:4173/"

echo Puedes cerrar esta ventana. Para detener el servidor, cierra la ventana minimizada "Four Kingdoms - servidor local".
timeout /t 4 /nobreak >nul
