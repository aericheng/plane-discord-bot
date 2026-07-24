' Runs start-bot.cmd in a hidden window (see lessons 2026-07-12: visible cmd windows get closed by accident)
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\user\Desktop\dev\plane\plane-discord-bot\start-bot.cmd""", 0, True
