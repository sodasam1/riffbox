"""Production entry point: python3 -m waitress --listen=127.0.0.1:8100 wsgi:app"""
from riffbox import create_app
from riffbox.config import load_config_file

load_config_file()
app = create_app()
