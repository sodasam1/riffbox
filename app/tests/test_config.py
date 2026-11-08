import os

from riffbox.config import load_config_file, parse_config


def test_parse_handles_comments_quotes_blank_and_equals_in_value():
    text = '# comment\n\nA=1\nB = "two words"\nC=\'x\'\nD=a=b=c\nnot a line\n'
    assert parse_config(text) == {"A": "1", "B": "two words", "C": "x", "D": "a=b=c"}


def test_load_sets_missing_but_keeps_existing_env(tmp_path, monkeypatch):
    conf = tmp_path / "riffbox.conf"
    conf.write_text("RIFFBOX_T1=fromfile\nRIFFBOX_T2=fromfile\n")
    monkeypatch.setenv("RIFFBOX_T2", "fromenv")
    monkeypatch.delenv("RIFFBOX_T1", raising=False)
    assert load_config_file(str(conf)) is True
    assert os.environ["RIFFBOX_T1"] == "fromfile"
    assert os.environ["RIFFBOX_T2"] == "fromenv"
    monkeypatch.delenv("RIFFBOX_T1", raising=False)


def test_missing_file_is_not_an_error(tmp_path):
    assert load_config_file(str(tmp_path / "nope.conf")) is False
