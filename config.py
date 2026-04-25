import os
from dataclasses import dataclass, field
from typing import List


@dataclass
class Config:
    BOT_TOKEN: str = os.getenv("BOT_TOKEN", "8786114291:AAF5RTTfxmKIG6-Gfmpm7WMazsCfa1tIx5A")
    ADMIN_IDS: List[int] = field(default_factory=lambda: [
        int(x) for x in os.getenv("ADMIN_IDS", "8032626504").split(",") if x.strip()
    ])
    CRYPTO_WALLET: str = os.getenv("CRYPTO_WALLET", "ТВОЙ_USDT_TRC20_КОШЕЛЁК")
    DB_PATH: str = os.getenv("DB_PATH", "bot_database.db")


config = Config()
