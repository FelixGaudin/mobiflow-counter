import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from app.parser import DebitNote

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    number TEXT PRIMARY KEY,
    customer_number TEXT NOT NULL,
    note_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    charger_id TEXT,
    total TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_number TEXT NOT NULL REFERENCES notes(number) ON DELETE CASCADE,
    start TEXT NOT NULL,
    "end" TEXT NOT NULL,
    duration_s INTEGER NOT NULL,
    rate TEXT NOT NULL,
    kwh TEXT NOT NULL,
    reimbursement TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_note ON sessions(note_number);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def upsert_note(self, note: DebitNote, filename: str) -> bool:
        """Store a note, replacing any previous version. Returns True if it already existed."""
        with self.connect() as conn:
            existing = conn.execute("SELECT 1 FROM notes WHERE number = ?", (note.number,)).fetchone()
            conn.execute("DELETE FROM notes WHERE number = ?", (note.number,))
            conn.execute(
                "INSERT INTO notes (number, customer_number, note_date, due_date, charger_id, total, filename)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    note.number,
                    note.customer_number,
                    note.note_date.isoformat(),
                    note.due_date.isoformat(),
                    note.charger_id,
                    str(note.total),
                    filename,
                ),
            )
            conn.executemany(
                'INSERT INTO sessions (note_number, start, "end", duration_s, rate, kwh, reimbursement)'
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        note.number,
                        s.start.isoformat(timespec="minutes"),
                        s.end.isoformat(timespec="minutes"),
                        s.duration_s,
                        str(s.rate),
                        str(s.kwh),
                        str(s.reimbursement),
                    )
                    for s in note.sessions
                ],
            )
            return existing is not None

    def notes(self) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM notes ORDER BY note_date").fetchall()

    def note(self, number: str) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM notes WHERE number = ?", (number,)).fetchone()

    def sessions(self) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM sessions ORDER BY start").fetchall()

    def delete_note(self, number: str) -> bool:
        with self.connect() as conn:
            return conn.execute("DELETE FROM notes WHERE number = ?", (number,)).rowcount > 0
