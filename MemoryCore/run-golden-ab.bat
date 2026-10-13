@echo off
rem M1 D1 A/B replay launcher (ASCII only: cmd reads GBK).
rem Injects vendor key env from the official gateway bat (values stay in process
rem env only, never echoed) then runs the golden A/B harness. Same injection
rem pattern as start-panel.bat.
for /f "usebackq tokens=* delims=" %%L in (`findstr /b /c:"set " "D:\develop\TencentDB-Agent-Memory\start-gateway-hidden.bat"`) do %%L
cd /d "D:\develop\TencentDB-Agent-Memory\repo\MemoryCore"
"D:\develop\TencentDB-Agent-Memory\node-v22\node.exe" --import tsx scripts\golden-ab.ts %*
