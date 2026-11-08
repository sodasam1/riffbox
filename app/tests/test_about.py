"""The private "How this works" page: access rules and the section order that was asked for."""
import re
from pathlib import Path

from conftest import PASS, TOKEN

ABOUT = Path(__file__).resolve().parents[1] / "riffbox" / "about.html"


def test_requires_a_login_session(client):
    assert client.get("/api/about").status_code == 401
    # the add-only upload token must not unlock it either
    assert client.get("/api/about", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401


def test_served_as_html_to_a_logged_in_session(client):
    client.post("/api/login", json={"passphrase": PASS})
    r = client.get("/api/about")
    assert r.status_code == 200
    assert r.mimetype == "text/html"
    assert r.headers["Cache-Control"] == "private, no-cache"
    assert b"Planned features" in r.data


def test_section_order_is_planned_features_then_roadmap_then_the_rest():
    headings = re.findall(r"<h2>(.*?)</h2>", ABOUT.read_text(), re.S)
    plain = [re.sub(r"<[^>]+>", "", h).strip() for h in headings]
    assert plain == [
        "Planned features",
        "Roadmap and progress",
        "Context",
        "What the guide and ti.sh already gave us",
        "Architecture",
        "Data model",
    ]


def test_page_covers_every_phase_and_table_column():
    text = ABOUT.read_text()
    for phase in ("<td>0</td>", "<td>1</td>", "<td>2</td>", "<td>3</td>", "<td>3.5</td>",
                  "<td>4</td>", "<td>5</td>", "<td>6</td>", "<td>7</td>", "<td>8</td>"):
        assert phase in text, phase
    # every column of the real schema is described, so the page cannot silently drift from the database
    schema = (Path(__file__).resolve().parents[1] / "riffbox" / "schema.sql").read_text()
    table = schema.split("CREATE TABLE IF NOT EXISTS recordings (")[1].split(");")[0]
    columns = re.findall(r"^\s{2}(\w+)\s+(?:INTEGER|TEXT|REAL)", table, re.M)
    assert len(columns) >= 24
    missing = [c for c in columns if f"<code>{c}</code>" not in text]
    assert not missing, f"about.html does not describe these columns: {missing}"


def test_fragment_is_not_part_of_the_public_static_files(client):
    """The page describes the server, so it must not be reachable without logging in."""
    assert client.get("/static/about.html").status_code == 404
    assert client.get("/static/../riffbox/about.html").status_code == 404
