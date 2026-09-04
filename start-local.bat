@echo off
setlocal
pushd "%~dp0"

if not exist "dist\index.html" (
  echo Standalone HTML not found. Building...
  call build-standalone.bat
  if errorlevel 1 (
    popd
    exit /b 1
  )
)

start "" "%CD%\dist\index.html"
popd
