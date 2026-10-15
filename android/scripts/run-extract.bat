@echo off
REM IVY milestone 1 runner (Windows). Double-click it, or run it from a cmd window.
REM It pushes the extract script, runs it on the phone as root, pulls the staging dir,
REM verifies it, and writes EVERYTHING to service.txt in this folder. Send me service.txt.
REM
REM If 'adb' is not recognized, set ADB below to the full path of adb.exe, e.g.:
REM   set "ADB=C:\platform-tools\adb.exe"

setlocal
cd /d "%~dp0"
if "%ADB%"=="" set "ADB=adb"
set "OUT=service.txt"

echo IVY extract run  %date% %time% > "%OUT%"
echo.>> "%OUT%"

echo === adb devices ===>> "%OUT%"
"%ADB%" devices >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === push extract script ===>> "%OUT%"
"%ADB%" push ivy-extract.sh /data/local/tmp/ >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === run on device (root) ===>> "%OUT%"
"%ADB%" shell "su -c 'sh /data/local/tmp/ivy-extract.sh'" >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === pull staging dir ===>> "%OUT%"
if exist ivy_stage rmdir /s /q ivy_stage
"%ADB%" pull /data/local/tmp/ivy_stage ivy_stage >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === device extract.log ===>> "%OUT%"
if exist "ivy_stage\extract.log" ( type "ivy_stage\extract.log" >> "%OUT%" ) else ( echo (no extract.log pulled)>> "%OUT%" )
echo.>> "%OUT%"

echo === verify (tables + row counts) ===>> "%OUT%"
where py >nul 2>&1
if %errorlevel%==0 (
  py -3 ivy-verify.py ivy_stage >> "%OUT%" 2>&1
) else (
  python ivy-verify.py ivy_stage >> "%OUT%" 2>&1
)
echo.>> "%OUT%"

echo === done ===>> "%OUT%"
echo Saved to %OUT%  (and the staging copies are in the ivy_stage folder).
echo.
echo Reminder: the staging dir is plaintext. After you send service.txt, wipe it:
echo   "%ADB%" shell "su -c 'rm -rf /data/local/tmp/ivy_stage'"
echo.
type "%OUT%"
endlocal
