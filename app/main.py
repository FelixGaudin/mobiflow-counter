import csv
import datetime
import io
import os
import re
import sqlite3
from collections import Counter, defaultdict
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.db import Database
from app.parser import ParseError, parse_pdf

DATA_DIR = Path(os.environ.get("MOBIFLOW_DATA_DIR", "data"))
PDF_DIR = DATA_DIR / "pdfs"
STATIC_DIR = Path(__file__).parent / "static"
# Amounts are rounded to the cent on the debit note, so allow one cent of slack.
ROUNDING_TOLERANCE = Decimal("0.01")

app = FastAPI(title="Mobiflow counter")
db = Database(DATA_DIR / "mobiflow.sqlite3")


class SessionOut(BaseModel):
    id: int
    note_number: str
    start: datetime.datetime
    end: datetime.datetime
    duration_s: int
    rate: float
    kwh: float
    reimbursement: float
    expected: float
    # Amount actually paid for this session once the note total is taken into account.
    amount: float
    # "ok", "covered" (line amount is wrong but the note total includes the right amount)
    # or "unpaid" (the session is under-reimbursed).
    status: str
    gap: float
    duplicate: bool


class NoteOut(BaseModel):
    number: str
    customer_number: str
    note_date: datetime.date
    due_date: datetime.date
    charger_id: str | None
    total: float
    kwh: float
    session_count: int
    filename: str
    uploaded_at: str


class Dashboard(BaseModel):
    notes: list[NoteOut]
    sessions: list[SessionOut]


class UploadResult(BaseModel):
    filename: str
    ok: bool
    number: str | None = None
    replaced: bool = False
    session_count: int = 0
    total: float = 0
    error: str | None = None


def _expected(kwh: Decimal, rate: Decimal) -> Decimal:
    return (kwh * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


@app.get("/api/dashboard")
def dashboard() -> Dashboard:
    by_note: dict[str, list[sqlite3.Row]] = defaultdict(list)
    rows = db.sessions()
    for r in rows:
        by_note[r["note_number"]].append(r)
    starts = Counter(r["start"] for r in rows)

    notes = []
    sessions = []
    for n in db.notes():
        own = by_note[n["number"]]
        lines_total = sum((Decimal(r["reimbursement"]) for r in own), Decimal(0))
        # The note total is authoritative: when it exceeds the sum of the lines, attribute the
        # surplus to the lines that were displayed below their kWh x rate value.
        unexplained = Decimal(n["total"]) - lines_total
        for r in own:
            kwh, rate, shown = Decimal(r["kwh"]), Decimal(r["rate"]), Decimal(r["reimbursement"])
            expected = _expected(kwh, rate)
            gap = expected - shown
            amount, status = shown, "ok"
            if gap > ROUNDING_TOLERANCE:
                if unexplained >= gap - ROUNDING_TOLERANCE:
                    unexplained -= gap
                    amount, status = expected, "covered"
                else:
                    status = "unpaid"
            sessions.append(
                SessionOut(
                    id=r["id"],
                    note_number=r["note_number"],
                    start=r["start"],
                    end=r["end"],
                    duration_s=r["duration_s"],
                    rate=float(rate),
                    kwh=float(kwh),
                    reimbursement=float(shown),
                    expected=float(expected),
                    amount=float(amount),
                    status=status,
                    gap=float(gap) if status != "ok" else 0.0,
                    duplicate=starts[r["start"]] > 1,
                )
            )
        notes.append(
            NoteOut(
                number=n["number"],
                customer_number=n["customer_number"],
                note_date=n["note_date"],
                due_date=n["due_date"],
                charger_id=n["charger_id"],
                total=float(n["total"]),
                kwh=float(sum((Decimal(r["kwh"]) for r in own), Decimal(0))),
                session_count=len(own),
                filename=n["filename"],
                uploaded_at=n["uploaded_at"],
            )
        )
    sessions.sort(key=lambda s: s.start)
    return Dashboard(notes=notes, sessions=sessions)


@app.post("/api/upload")
async def upload(files: list[UploadFile]) -> list[UploadResult]:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    for f in files:
        name = f.filename or "fiche.pdf"
        data = await f.read()
        try:
            note = parse_pdf(data)
        except ParseError as e:
            results.append(UploadResult(filename=name, ok=False, error=str(e)))
            continue
        (PDF_DIR / f"{_safe(note.number)}.pdf").write_bytes(data)
        replaced = db.upsert_note(note, name)
        results.append(
            UploadResult(
                filename=name,
                ok=True,
                number=note.number,
                replaced=replaced,
                session_count=len(note.sessions),
                total=float(note.total),
            )
        )
    return results


@app.delete("/api/notes/{number}")
def delete_note(number: str) -> None:
    if not db.delete_note(number):
        raise HTTPException(404, "Unknown debit note")
    (PDF_DIR / f"{_safe(number)}.pdf").unlink(missing_ok=True)


@app.get("/api/notes/{number}/pdf")
def note_pdf(number: str) -> FileResponse:
    path = PDF_DIR / f"{_safe(number)}.pdf"
    if db.note(number) is None or not path.exists():
        raise HTTPException(404, "Unknown debit note")
    return FileResponse(path, media_type="application/pdf", filename=f"{number}.pdf")


@app.get("/api/export.csv")
def export_csv() -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["debit_note", "start", "end", "duration_s", "rate_eur_kwh", "kwh", "reimbursement_eur"])
    for r in db.sessions():
        writer.writerow([r["note_number"], r["start"], r["end"], r["duration_s"], r["rate"], r["kwh"], r["reimbursement"]])
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=mobiflow-sessions.csv"},
    )


def _safe(number: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", number)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
