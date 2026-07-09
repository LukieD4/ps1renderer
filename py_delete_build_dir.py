# Run before py_convert_assets.py!

from pathlib import Path
import shutil

BUILD_DIR = Path(__file__).resolve().parent / "build"
shutil.rmtree(BUILD_DIR, ignore_errors=True)