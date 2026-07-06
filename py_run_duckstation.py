import subprocess
import sys
from pathlib import Path

# Build path without exposing your username
emu = (
    Path.home()
    / "Desktop"
    / "Files"
    / "_EMULATORS"
    / "duckstation-windows-x64-release"
    / "duckstation-qt-x64-ReleaseLTCG.exe"
)

game = sys.argv[1]

# Fire and forget
subprocess.Popen([str(emu), "-fastboot", game])
