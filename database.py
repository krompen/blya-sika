import sqlite3
import threading
from datetime import datetime
from config import config


class Database:
    def __init__(self):
        self._local = threading.local()

    def _conn(self):
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def init(self):
        c = self._conn()
        c.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                user_id     INTEGER PRIMARY KEY,
                username    TEXT,
                full_name   TEXT,
                ref_by      INTEGER,
                is_premium  INTEGER DEFAULT 0,
                premium_until TEXT,
                joined_at   TEXT,
                support_mode INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS referrals (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ref_by      INTEGER,
                ref_user    INTEGER,
                created_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS tickets (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER,
                text        TEXT,
                status      TEXT DEFAULT 'open',
                created_at  TEXT
            );
        """)
        c.commit()

    # ── USERS ──────────────────────────────────────────────
    def add_user(self, user_id, username, full_name, ref_by=None):
        c = self._conn()
        c.execute(
            "INSERT OR IGNORE INTO users (user_id, username, full_name, ref_by, joined_at) VALUES (?,?,?,?,?)",
            (user_id, username, full_name, ref_by, datetime.now().strftime("%d.%m.%Y"))
        )
        c.commit()

    def get_user(self, user_id):
        c = self._conn()
        row = c.execute("SELECT * FROM users WHERE user_id=?", (user_id,)).fetchone()
        return dict(row) if row else None

    def get_all_users(self):
        c = self._conn()
        rows = c.execute("SELECT * FROM users ORDER BY rowid").fetchall()
        return [dict(r) for r in rows]

    def set_premium(self, user_id, until: str):
        c = self._conn()
        c.execute(
            "UPDATE users SET is_premium=1, premium_until=? WHERE user_id=?",
            (until, user_id)
        )
        c.commit()

    def set_support_mode(self, user_id, active: bool):
        c = self._conn()
        c.execute("UPDATE users SET support_mode=? WHERE user_id=?", (int(active), user_id))
        c.commit()

    def get_support_mode(self, user_id) -> bool:
        user = self.get_user(user_id)
        return bool(user.get("support_mode")) if user else False

    # ── REFERRALS ──────────────────────────────────────────
    def add_referral(self, ref_by, ref_user):
        c = self._conn()
        c.execute(
            "INSERT OR IGNORE INTO referrals (ref_by, ref_user, created_at) VALUES (?,?,?)",
            (ref_by, ref_user, datetime.now().strftime("%d.%m.%Y %H:%M"))
        )
        c.commit()

    def get_referral_count(self, user_id) -> int:
        c = self._conn()
        row = c.execute("SELECT COUNT(*) as cnt FROM referrals WHERE ref_by=?", (user_id,)).fetchone()
        return row["cnt"] if row else 0

    # ── TICKETS ────────────────────────────────────────────
    def create_ticket(self, user_id, text) -> int:
        c = self._conn()
        cur = c.execute(
            "INSERT INTO tickets (user_id, text, created_at) VALUES (?,?,?)",
            (user_id, text, datetime.now().strftime("%d.%m.%Y %H:%M"))
        )
        c.commit()
        return cur.lastrowid

    def get_ticket(self, ticket_id):
        c = self._conn()
        row = c.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        return dict(row) if row else None

    def get_open_tickets(self):
        c = self._conn()
        rows = c.execute("SELECT * FROM tickets WHERE status='open' ORDER BY id DESC LIMIT 20").fetchall()
        return [dict(r) for r in rows]

    def close_ticket(self, ticket_id):
        c = self._conn()
        c.execute("UPDATE tickets SET status='closed' WHERE id=?", (ticket_id,))
        c.commit()

    # ── STATS ──────────────────────────────────────────────
    def get_stats(self) -> dict:
        c = self._conn()
        users = c.execute("SELECT COUNT(*) as cnt FROM users").fetchone()["cnt"]
        premium = c.execute("SELECT COUNT(*) as cnt FROM users WHERE is_premium=1").fetchone()["cnt"]
        open_t = c.execute("SELECT COUNT(*) as cnt FROM tickets WHERE status='open'").fetchone()["cnt"]
        total_t = c.execute("SELECT COUNT(*) as cnt FROM tickets").fetchone()["cnt"]
        refs = c.execute("SELECT COUNT(*) as cnt FROM referrals").fetchone()["cnt"]
        return {"users": users, "premium": premium, "open_tickets": open_t, "total_tickets": total_t, "referrals": refs}


db = Database()
