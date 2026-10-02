import datetime
import importlib
import io
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.parser import ParseError, parse_pdf, parse_text

# Fictitious debit notes laid out like the Mobiflow ones: (start, end, duration, rate, kWh, amount).
NOTE_A = {
    "number": "SB-DN-A00000000-1",
    "date": "2030-02-01",
    "due": "2030-02-28",
    "total": "11.00",
    "sessions": [
        ("2030-01-02 08:00", "2030-01-02 12:30", "4h 30min 0s", "0.2500", "20.00", "5.00"),
        ("2030-01-03 18:00", "2030-01-03 18:00", "10s", "0.2500", "0.00", "0.00"),
        # Displayed at €0.00 but included in the total.
        ("2030-01-05 20:00", "2030-01-07 07:15", "35h 15min 30s", "0.2500", "24.00", "0.00"),
    ],
}
NOTE_B = {
    "number": "SB-DN-A00000000-2",
    "date": "2030-03-01",
    "due": "2030-03-31",
    "total": "4.00",
    "sessions": [
        ("2030-02-10 09:00", "2030-02-10 17:00", "8h 0min 0s", "0.3000", "10.00", "3.00"),
        # Under-reimbursed and not covered by the total.
        ("2030-02-12 09:00", "2030-02-12 10:00", "1h 0min 0s", "0.3000", "10.00", "1.00"),
    ],
}


def make_pdf(note: dict) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    y = 800

    def line(*cols: str) -> None:
        nonlocal y
        c.drawString(40, y, "   ".join(cols))
        y -= 16

    line("From: Jane Doe", "To: Mobiflow")
    line("Debit note")
    line("Customer number", "Debit note number", "Debit note date", "Date due")
    line("A00000001", note["number"], note["date"], note["due"], "*")
    line("Charging sessions - t0000000000000000s1d1")
    line("Start time", "End time", "Duration", "Rate", "KWh", "Reimbursement")
    for start, end, duration, rate, kwh, amount in note["sessions"]:
        line(start, end, duration, f"€{rate}/kWh", kwh, f"€{amount}")
    line("Total", f"€{note['total']}")
    c.save()
    return buf.getvalue()


def test_parse_note():
    note = parse_pdf(make_pdf(NOTE_A))
    assert note.number == "SB-DN-A00000000-1"
    assert note.customer_number == "A00000001"
    assert note.note_date == datetime.date(2030, 2, 1)
    assert note.due_date == datetime.date(2030, 2, 28)
    assert note.charger_id == "t0000000000000000s1d1"
    assert note.total == Decimal("11.00")
    assert len(note.sessions) == 3
    assert note.sessions[0].start == datetime.datetime(2030, 1, 2, 8, 0)
    assert note.sessions[0].duration_s == 4 * 3600 + 30 * 60
    assert note.sessions[1].duration_s == 10
    assert note.sessions[2].duration_s == 35 * 3600 + 15 * 60 + 30
    assert note.sessions[2].kwh == Decimal("24.00")
    assert note.sessions[2].rate == Decimal("0.2500")


def test_parse_rejects_other_documents():
    with pytest.raises(ParseError):
        parse_text("Hello world")
    with pytest.raises(ParseError):
        parse_pdf(b"not a pdf")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MOBIFLOW_DATA_DIR", str(tmp_path))
    import app.main

    importlib.reload(app.main)
    return TestClient(app.main.app)


def test_upload_flow(client):
    files = [
        ("files", ("a.pdf", make_pdf(NOTE_A), "application/pdf")),
        ("files", ("b.pdf", make_pdf(NOTE_B), "application/pdf")),
        ("files", ("junk.pdf", b"junk", "application/pdf")),
    ]
    results = client.post("/api/upload", files=files).json()
    assert [r["ok"] for r in results] == [True, True, False]

    again = client.post("/api/upload", files=files[:1]).json()
    assert again[0]["replaced"]

    data = client.get("/api/dashboard").json()
    assert len(data["notes"]) == 2
    assert len(data["sessions"]) == 5
    flagged = [(s["start"], s["status"], s["gap"], s["amount"]) for s in data["sessions"] if s["status"] != "ok"]
    assert flagged == [
        ("2030-01-05T20:00:00", "covered", 6.0, 6.0),
        ("2030-02-12T09:00:00", "unpaid", 2.0, 1.0),
    ]
    note_a = next(n for n in data["notes"] if n["number"] == NOTE_A["number"])
    amounts = sum(s["amount"] for s in data["sessions"] if s["note_number"] == NOTE_A["number"])
    assert round(amounts, 2) == note_a["total"]

    number = NOTE_A["number"]
    assert client.get(f"/api/notes/{number}/pdf").content.startswith(b"%PDF")
    assert "2030-01-02T08:00" in client.get("/api/export.csv").text

    assert client.delete(f"/api/notes/{number}").status_code == 200
    assert len(client.get("/api/dashboard").json()["notes"]) == 1
    assert client.get(f"/api/notes/{number}/pdf").status_code == 404


def test_summary(client):
    empty = client.get("/api/summary").json()
    assert empty["total"] == 0 and empty["best_month"] is None and empty["last_note_number"] is None

    files = [("files", (f"{n['number']}.pdf", make_pdf(n), "application/pdf")) for n in (NOTE_A, NOTE_B)]
    client.post("/api/upload", files=files)
    summary = client.get("/api/summary").json()
    assert summary == {
        "total": 15.0,
        "kwh": 64.0,
        "year_total": 0.0,
        "monthly_average": 7.5,
        "best_month": "2030-01",
        "best_month_total": 11.0,
        "current_rate": 0.3,
        "last_note_number": "SB-DN-A00000000-2",
        "last_note_date": "2030-03-01",
        "last_note_total": 4.0,
        "note_count": 2,
        "session_count": 5,
    }
