@echo off
REM Double-click this, or run it from a cmd window. It pushes stack.sh, runs it on the
REM device as root, pulls the staging dir, checks it, and writes everything to service.txt
REM in this folder. Put this file next to adb.exe (in platform-tools) and it just works.
REM
REM If 'adb' is not found, set ADB below to the full path of adb.exe, e.g.:
REM   set "ADB=C:\platform-tools\adb.exe"

setlocal
cd /d "%~dp0"
if "%ADB%"=="" set "ADB=adb"
set "OUT=service.txt"

echo run  %date% %time% > "%OUT%"
echo.>> "%OUT%"

echo === devices ===>> "%OUT%"
"%ADB%" devices >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === push ===>> "%OUT%"
"%ADB%" push stack.sh /data/local/tmp/ >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === run on device ===>> "%OUT%"
"%ADB%" shell "su -c 'sh /data/local/tmp/stack.sh'" >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === pull ===>> "%OUT%"
if exist out rmdir /s /q out
"%ADB%" pull /data/local/tmp/out out >> "%OUT%" 2>&1
echo.>> "%OUT%"

echo === log ===>> "%OUT%"
if exist "out\run.log" ( type "out\run.log" >> "%OUT%" ) else ( echo (no log pulled)>> "%OUT%" )
echo.>> "%OUT%"

echo === check ===>> "%OUT%"
where py >nul 2>&1
if %errorlevel%==0 (
  py -3 stack.py out >> "%OUT%" 2>&1
) else (
  python stack.py out >> "%OUT%" 2>&1
)
echo.>> "%OUT%"

echo === done ===>> "%OUT%"
echo Saved to %OUT%  (copies are in the out folder).
echo.
echo After sending service.txt, remove the staging folder from the device:
echo   "%ADB%" shell "su -c 'rm -rf /data/local/tmp/out'"
echo.
type "%OUT%"
endlocal
