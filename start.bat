@echo off
setlocal enabledelayedexpansion
REM ---------------------------------------------------------------------------
REM  Krosalita launcher
REM
REM    start.bat          build, then serve the production build on 9995
REM    start.bat dev      Vite dev server with hot reload on 9995
REM    start.bat stop     just free the ports and exit
REM
REM  Always serves two things:
REM    9995  the app
REM    9996  the corpus pipeline monitor
REM
REM  Both bind 0.0.0.0, so any device on the tailnet can reach them. Vite's config
REM  already sets allowedHosts:true, which is what stops it answering
REM  "Blocked request ... is not allowed" when reached by Tailscale IP or MagicDNS name.
REM
REM  Anything already holding 9995/9996 is killed first -- a leaked `vite preview`
REM  keeps serving a STALE file list, so a rebuild's new asset hashes 404 into the SPA
REM  fallback and the page silently fails to load. Freeing the port is not optional.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

set "APP_PORT=9995"
set "MON_PORT=9996"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=preview"

call :freeport %APP_PORT%
call :freeport %MON_PORT%

if /i "%MODE%"=="stop" (
  echo Ports %APP_PORT% and %MON_PORT% are free.
  exit /b 0
)

REM ---- pick a python: the repo venv if present, else whatever is on PATH ----
set "PY=python"
if exist "venv\Scripts\python.exe" set "PY=venv\Scripts\python.exe"

REM ---- find the tailnet address, for the URLs printed at the end ----
set "TSIP="
for /f "usebackq tokens=*" %%i in (`tailscale ip -4 2^>nul`) do if not defined TSIP set "TSIP=%%i"

if /i "%MODE%"=="dev" goto :dev

REM ---- production build, served exactly as it is deployed ----
echo Building...
call npm run build
if errorlevel 1 (
  echo.
  echo Build failed -- not starting. Fix the build, or use: start.bat dev
  exit /b 1
)
start "Krosalita app %APP_PORT%" cmd /k npx vite preview --port %APP_PORT% --strictPort --host
call :verify %APP_PORT% "the app"
goto :monitor

:dev
echo Starting the dev server ^(hot reload^)...
start "Krosalita dev %APP_PORT%" cmd /k npx vite --port %APP_PORT% --strictPort --host
goto :monitor

:monitor
start "Pipeline monitor %MON_PORT%" cmd /k "%PY%" pipeline\monitor\server.py --port %MON_PORT% --host 0.0.0.0

echo.
echo   Krosalita       http://localhost:%APP_PORT%
echo   Pipeline        http://localhost:%MON_PORT%
if defined TSIP (
  echo.
  echo   On the tailnet:
  echo     app          http://%TSIP%:%APP_PORT%
  echo     pipeline     http://%TSIP%:%MON_PORT%
) else (
  echo.
  echo   Tailscale not detected ^(`tailscale ip -4` returned nothing^), so only
  echo   localhost and the LAN address will work.
)
echo.
echo   Each server runs in its own window. Close it, or run: start.bat stop
echo.
exit /b 0

REM ---------------------------------------------------------------------------
:freeport
REM Kill whatever owns the given TCP port.
REM
REM This used to parse netstat with `findstr /r /c:":PORT .*LISTENING"`. findstr treats
REM /c: as a LITERAL string, so that pattern matched nothing and freeport silently freed
REM nothing. A preview server from the previous day was still holding 9995, the new one
REM could not bind because of --strictPort, and it died in its own window without a word.
REM The symptom was a stale build being served -- exactly what the note at the top of this
REM file warns about -- and it is why Browse appeared broken. Get-NetTCPConnection is
REM exact and does not depend on netstat's column spacing or locale.
set "P=%~1"
set "KILLED="
for /f %%a in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %~1 -State Listen -ErrorAction SilentlyContinue).OwningProcess" 2^>nul') do (
  if not "%%a"=="0" (
    taskkill /F /T /PID %%a >nul 2>&1
    set "KILLED=1"
  )
)
if defined KILLED (
  REM taskkill returns before Windows releases the socket; binding too soon still fails.
  powershell -NoProfile -Command "Start-Sleep -Milliseconds 800" >nul 2>&1
  echo Freed port %P%.
) else (
  echo Port %P% was free.
)
exit /b 0

REM ---------------------------------------------------------------------------
:verify
REM --strictPort makes a failed bind fatal, but the child dies in its own window where
REM nobody looks. Check the port really answers and say so if it does not.
powershell -NoProfile -Command "$ok=$false; foreach($i in 1..25){ try { if((Invoke-WebRequest -UseBasicParsing -Uri ('http://localhost:%~1/') -TimeoutSec 2).StatusCode -eq 200){$ok=$true;break} } catch {}; Start-Sleep -Milliseconds 600 }; if($ok){ Write-Host ('  %~2 is up on %~1.') } else { Write-Host ''; Write-Host ('  WARNING: nothing is answering on %~1 -- %~2 did not start.'); Write-Host '  Look at the window it opened; usually the port was still held.' }"
exit /b 0
