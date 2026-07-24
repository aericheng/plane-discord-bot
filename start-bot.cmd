@echo off
rem Plane Discord Bot launcher (ASCII only - see lessons re: Big5 codepage)
rem Auto-restarts node if the bot crashes; 10s delay between restarts.
set PATH=C:\Program Files\nodejs;%PATH%
cd /d C:\Users\user\Desktop\dev\plane\plane-discord-bot
:loop
"C:\Program Files\nodejs\node.exe" bot.js >> bot.log 2>&1
ping -n 11 127.0.0.1 >nul
goto loop
