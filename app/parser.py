"""Parse Mobiflow debit note PDFs (home charging reimbursements)."""

import datetime
import io
import re
from decimal import Decimal

import pdfplumber
from pydantic import BaseModel


class ParseError(ValueError):
    pass


class Session(BaseModel):
    start: datetime.datetime
    end: datetime.datetime
    duration_s: int
    rate: Decimal
    kwh: Decimal
    reimbursement: Decimal


class DebitNote(BaseModel):
    number: str
    customer_number: str
    note_date: datetime.date
    due_date: datetime.date
    charger_id: str | None
    total: Decimal
    sessions: list[Session]


HEADER_RE = re.compile(
    r"^(?P<customer>\S+)\s+(?P<number>SB-DN-\S+)\s+(?P<date>\d{4}-\d{2}-\d{2})\s+(?P<due>\d{4}-\d{2}-\d{2})"
)
SESSION_RE = re.compile(
    r"^(?P<start>\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+"
    r"(?P<end>\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+"
    r"(?P<duration>(?:\d+h\s*)?(?:\d+min\s*)?(?:\d+s)?)\s+"
    r"€(?P<rate>[\d.,]+)/kWh\s+"
    r"(?P<kwh>[\d.,]+)\s+"
    r"€(?P<amount>-?[\d.,]+)$"
)
CHARGER_RE = re.compile(r"^Charging sessions\s*-\s*(?P<id>\S+)")
TOTAL_RE = re.compile(r"^Total\s+€(?P<total>-?[\d.,]+)$")
DURATION_RE = re.compile(r"(?:(\d+)h)?\s*(?:(\d+)min)?\s*(?:(\d+)s)?")


def _decimal(raw: str) -> Decimal:
    return Decimal(raw.replace(",", ""))


def _duration(raw: str) -> int:
    match = DURATION_RE.fullmatch(raw.strip())
    if not match:
        raise ParseError(f"Unrecognised duration: {raw!r}")
    h, m, s = (int(g) if g else 0 for g in match.groups())
    return h * 3600 + m * 60 + s


def _dt(raw: str) -> datetime.datetime:
    return datetime.datetime.strptime(raw, "%Y-%m-%d %H:%M")


def parse_text(text: str) -> DebitNote:
    header = None
    charger_id = None
    total = None
    sessions: list[Session] = []
    for line in (raw.strip() for raw in text.splitlines()):
        if header is None and (m := HEADER_RE.match(line)):
            header = m
        elif m := CHARGER_RE.match(line):
            charger_id = m["id"]
        elif m := SESSION_RE.match(line):
            sessions.append(
                Session(
                    start=_dt(m["start"]),
                    end=_dt(m["end"]),
                    duration_s=_duration(m["duration"]),
                    rate=_decimal(m["rate"]),
                    kwh=_decimal(m["kwh"]),
                    reimbursement=_decimal(m["amount"]),
                )
            )
        elif m := TOTAL_RE.match(line):
            total = _decimal(m["total"])

    if header is None:
        raise ParseError("Not a Mobiflow debit note: no debit note number found")
    if total is None:
        raise ParseError("No total found in debit note")
    return DebitNote(
        number=header["number"],
        customer_number=header["customer"],
        note_date=datetime.date.fromisoformat(header["date"]),
        due_date=datetime.date.fromisoformat(header["due"]),
        charger_id=charger_id,
        total=total,
        sessions=sessions,
    )


def parse_pdf(data: bytes) -> DebitNote:
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    except Exception as e:
        raise ParseError(f"Unreadable PDF: {e}") from e
    return parse_text(text)
