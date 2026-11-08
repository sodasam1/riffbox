"""Loads a module from app/riffbox/ by file path, WITHOUT importing the riffbox package (whose __init__ needs
Flask). That keeps these command-line tools working with nothing but Python."""
import importlib.util
from pathlib import Path


def load(name):
    path = Path(__file__).resolve().parents[1] / "app" / "riffbox" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"riffbox_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
