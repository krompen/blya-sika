import asyncio
import logging
import random
import string
import re
import aiohttp
import json
from datetime import datetime, timedelta
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, ReplyKeyboardMarkup, KeyboardButton
from aiogram.utils.keyboard import InlineKeyboardBuilder
from database import db
from config import config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

bot = Bot(token=config.BOT_TOKEN)
storage = MemoryStorage()
dp = Dispatcher(storage=storage)


# ─────────────────────────────────────────
# STATES
# ─────────────────────────────────────────
class SearchStates(StatesGroup):
    waiting_pattern = State()

class SupportStates(StatesGroup):
    waiting_message = State()
    waiting_reply = State()

class BroadcastStates(StatesGroup):
    waiting_message = State()

class AdminStates(StatesGroup):
    waiting_user_id = State()


# ─────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────
def main_menu(is_admin=False):
    kb = ReplyKeyboardMarkup(keyboard=[
        [KeyboardButton(text="🔍 Поиск тегов"), KeyboardButton(text="👤 Профиль")],
        [KeyboardButton(text="💎 Премиум"), KeyboardButton(text="🤝 Реферальная система")],
        [KeyboardButton(text="🛠 Тех. поддержка")],
    ], resize_keyboard=True)
    if is_admin:
        kb.keyboard.append([KeyboardButton(text="⚙️ Админ панель")])
    return kb


def estimate_price(username: str) -> int:
    length = len(username)
    price = {3: 50000, 4: 10000, 5: 2000, 6: 500}.get(length, 100)
    return price


async def check_username_fragment(session: aiohttp.ClientSession, username: str) -> bool:
    """Check username availability via Fragment API"""
    try:
        url = f"https://fragment.com/username/{username}"
        headers = {"User-Agent": "Mozilla/5.0"}
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
            text = await resp.text()
            # Fragment shows "Buy" button only when username is available for purchase
            if '"available":true' in text or 'Buy username' in text or '"status":"available"' in text:
                return True
            # Double-check via Telegram getChat
            return False
    except Exception as e:
        logger.warning(f"Fragment check failed for {username}: {e}")
        return False


async def check_username_telegram(username: str) -> bool:
    """Additional check via Telegram: if getChat raises error — username is free"""
    try:
        await bot.get_chat(f"@{username}")
        return False  # username exists
    except Exception:
        return True  # username is free


async def is_username_free(session: aiohttp.ClientSession, username: str) -> bool:
    tg_free = await check_username_telegram(username)
    if not tg_free:
        return False
    fragment_free = await check_username_fragment(session, username)
    return fragment_free


def generate_usernames_by_pattern(pattern: str, count: int = 30) -> list:
    """Generate candidates from pattern like a?b?c?"""
    vowels = "aeiouаеёиоуыъьэюя"
    consonants = "bcdfghjklmnpqrstvwxyzбвгджзйклмнпрстфхцчшщ"
    chars = string.ascii_lowercase

    results = []
    attempts = 0
    while len(results) < count and attempts < 2000:
        attempts += 1
        name = ""
        for ch in pattern:
            if ch == "?":
                name += random.choice(chars)
            elif ch == "*":
                name += "".join(random.choices(chars, k=random.randint(1, 3)))
            else:
                name += ch
        if 5 <= len(name) <= 32 and name not in results:
            results.append(name)
    return results


def generate_random_usernames(length: int, count: int = 30) -> list:
    chars = string.ascii_lowercase + string.digits
    results = set()
    while len(results) < count:
        name = random.choice(string.ascii_lowercase)
        name += "".join(random.choices(chars, k=length - 1))
        if len(name) == length:
            results.add(name)
    return list(results)


def format_result_card(username: str, price: int, length: int) -> str:
    stars = "⭐" * min(5, max(1, 6 - length))
    return (
        f"┌─────────────────────────\n"
        f"│ 🏷 @{username}\n"
        f"│ 📏 Длина: {length} букв\n"
        f"│ 💰 ~{price:,} ⭐ Stars\n"
        f"│ ✅ Статус: Свободен\n"
        f"└─────────────────────────"
    )


# ─────────────────────────────────────────
# /START
# ─────────────────────────────────────────
@dp.message(CommandStart())
async def cmd_start(message: types.Message):
    args = message.text.split()
    ref_id = int(args[1][3:]) if len(args) > 1 and args[1].startswith("ref") else None

    user = db.get_user(message.from_user.id)
    if not user:
        db.add_user(
            user_id=message.from_user.id,
            username=message.from_user.username or "",
            full_name=message.from_user.full_name,
            ref_by=ref_id
        )
        if ref_id and ref_id != message.from_user.id:
            db.add_referral(ref_id, message.from_user.id)
            try:
                await bot.send_message(ref_id,
                    f"🎉 По вашей реферальной ссылке зарегистрировался новый пользователь!\n"
                    f"Вам начислено +1 к счётчику рефералов.")
            except:
                pass

    is_admin = message.from_user.id in config.ADMIN_IDS
    await message.answer(
        f"┌──────────────────────────\n"
        f"│ 👋 Добро пожаловать, {message.from_user.first_name}!\n"
        f"│\n"
        f"│ 🔍 Я помогу найти свободные\n"
        f"│    Telegram-теги (@username)\n"
        f"│\n"
        f"│ 💎 Есть премиум-возможности\n"
        f"│ 🤝 Реферальная система\n"
        f"└──────────────────────────",
        reply_markup=main_menu(is_admin)
    )


# ─────────────────────────────────────────
# SEARCH
# ─────────────────────────────────────────
@dp.message(F.text == "🔍 Поиск тегов")
async def search_menu(message: types.Message):
    user = db.get_user(message.from_user.id)
    is_premium = user and user.get("is_premium")

    kb = InlineKeyboardBuilder()
    kb.button(text="5️⃣ Поиск 5-буквенных", callback_data="search_5")
    kb.button(text="6️⃣ Поиск 6-буквенных", callback_data="search_6")
    kb.button(text="🎭 По паттерну (a?b?c?)", callback_data="search_pattern")
    if is_premium:
        kb.button(text="⚡ Быстрый поиск (x20)", callback_data="search_fast")
    kb.adjust(1)

    await message.answer(
        "┌──────────────────────────\n"
        "│ 🔍 ПОИСК ТЕГОВ\n"
        "│\n"
        "│ Выберите режим поиска:\n"
        "└──────────────────────────",
        reply_markup=kb.as_markup()
    )


@dp.callback_query(F.data.startswith("search_"))
async def handle_search(callback: types.CallbackQuery, state: FSMContext):
    mode = callback.data.replace("search_", "")

    if mode == "pattern":
        await callback.message.answer(
            "┌──────────────────────────\n"
            "│ 🎭 ПОИСК ПО ПАТТЕРНУ\n"
            "│\n"
            "│ Введите шаблон, где:\n"
            "│  • ? = любой символ\n"
            "│  • * = 1-3 символа\n"
            "│\n"
            "│ Примеры:\n"
            "│  a?b?c  →  axbxc\n"
            "│  cool?? →  coolxz\n"
            "└──────────────────────────"
        )
        await state.set_state(SearchStates.waiting_pattern)
        await callback.answer()
        return

    length = int(mode) if mode.isdigit() else 5
    count = 20 if mode != "fast" else 40

    await callback.message.edit_text(
        "┌──────────────────────────\n"
        "│ ⏳ Идёт поиск...\n"
        "│ Проверяю юзернеймы через\n"
        "│ Fragment + Telegram API\n"
        "└──────────────────────────"
    )

    candidates = generate_random_usernames(length, count * 3)
    found = []

    async with aiohttp.ClientSession() as session:
        for name in candidates:
            if len(found) >= count:
                break
            free = await is_username_free(session, name)
            if free:
                found.append(name)
            await asyncio.sleep(0.3)

    if not found:
        await callback.message.edit_text(
            "┌──────────────────────────\n"
            "│ 😔 Не найдено свободных\n"
            "│ тегов. Попробуйте снова.\n"
            "└──────────────────────────"
        )
        await callback.answer()
        return

    result_text = f"┌──────────────────────────\n│ ✅ Найдено: {len(found)} тегов\n└──────────────────────────\n\n"
    for name in found:
        price = estimate_price(name)
        result_text += format_result_card(name, price, len(name)) + "\n\n"

    # Split if too long
    if len(result_text) > 4000:
        chunks = []
        lines = result_text.split("\n\n")
        chunk = ""
        for block in lines:
            if len(chunk) + len(block) > 3800:
                chunks.append(chunk)
                chunk = block
            else:
                chunk += "\n\n" + block
        if chunk:
            chunks.append(chunk)
        await callback.message.edit_text(chunks[0])
        for ch in chunks[1:]:
            await callback.message.answer(ch)
    else:
        await callback.message.edit_text(result_text)

    await callback.answer()


@dp.message(SearchStates.waiting_pattern)
async def search_by_pattern(message: types.Message, state: FSMContext):
    pattern = message.text.strip().lower()
    if len(pattern) < 3 or len(pattern) > 32:
        await message.answer("❌ Паттерн должен быть от 3 до 32 символов.")
        return

    await state.clear()
    await message.answer(
        "┌──────────────────────────\n"
        f"│ ⏳ Ищу по паттерну: {pattern}\n"
        "└──────────────────────────"
    )

    candidates = generate_usernames_by_pattern(pattern, 60)
    found = []

    async with aiohttp.ClientSession() as session:
        for name in candidates:
            if len(found) >= 15:
                break
            free = await is_username_free(session, name)
            if free:
                found.append(name)
            await asyncio.sleep(0.3)

    if not found:
        await message.answer("😔 По данному паттерну свободных тегов не найдено.")
        return

    result_text = f"🔍 Результаты для паттерна `{pattern}`:\n\n"
    for name in found:
        price = estimate_price(name)
        result_text += format_result_card(name, price, len(name)) + "\n\n"

    await message.answer(result_text, parse_mode="Markdown")


# ─────────────────────────────────────────
# PROFILE
# ─────────────────────────────────────────
@dp.message(F.text == "👤 Профиль")
async def show_profile(message: types.Message):
    user = db.get_user(message.from_user.id)
    if not user:
        await message.answer("Профиль не найден. Нажмите /start")
        return

    refs = db.get_referral_count(message.from_user.id)
    premium_status = "💎 Активен" if user.get("is_premium") else "❌ Нет"
    premium_until = user.get("premium_until", "—")
    joined = user.get("joined_at", "—")

    await message.answer(
        f"┌──────────────────────────\n"
        f"│ 👤 ПРОФИЛЬ\n"
        f"├──────────────────────────\n"
        f"│ 🆔 ID: {message.from_user.id}\n"
        f"│ 📛 Имя: {message.from_user.full_name}\n"
        f"│ 🏷 @{message.from_user.username or '—'}\n"
        f"│ 📅 Регистрация: {joined}\n"
        f"├──────────────────────────\n"
        f"│ 💎 Премиум: {premium_status}\n"
        f"│ 📆 До: {premium_until}\n"
        f"├──────────────────────────\n"
        f"│ 🤝 Рефералов: {refs}\n"
        f"└──────────────────────────"
    )


# ─────────────────────────────────────────
# PREMIUM
# ─────────────────────────────────────────
@dp.message(F.text == "💎 Премиум")
async def premium_menu(message: types.Message):
    kb = InlineKeyboardBuilder()
    kb.button(text="⭐ Купить за Stars (299 ⭐/мес)", callback_data="buy_premium_stars")
    kb.button(text="₿ Купить за крипто ($4.99/мес)", callback_data="buy_premium_crypto")
    kb.button(text="📋 Что даёт Премиум?", callback_data="premium_info")
    kb.adjust(1)

    await message.answer(
        "┌──────────────────────────\n"
        "│ 💎 ПРЕМИУМ ПОДПИСКА\n"
        "├──────────────────────────\n"
        "│ ✅ Поиск x20 результатов\n"
        "│ ✅ Быстрый режим поиска\n"
        "│ ✅ Приоритет в тех. поддержке\n"
        "│ ✅ Поиск 3-4 буквенных тегов\n"
        "│ ✅ Без ограничений запросов\n"
        "└──────────────────────────",
        reply_markup=kb.as_markup()
    )


@dp.callback_query(F.data == "premium_info")
async def premium_info(callback: types.CallbackQuery):
    await callback.answer(
        "Премиум даёт: x20 результатов, быстрый поиск, приоритетная поддержка, поиск 3-4 буквенных!",
        show_alert=True
    )


@dp.callback_query(F.data == "buy_premium_stars")
async def buy_stars(callback: types.CallbackQuery):
    prices = [types.LabeledPrice(label="Премиум подписка на 30 дней", amount=299)]
    await bot.send_invoice(
        chat_id=callback.from_user.id,
        title="💎 Премиум подписка",
        description="30 дней премиум доступа: быстрый поиск, x20 результатов, приоритетная поддержка",
        payload="premium_30d",
        currency="XTR",
        prices=prices
    )
    await callback.answer()


@dp.callback_query(F.data == "buy_premium_crypto")
async def buy_crypto(callback: types.CallbackQuery):
    await callback.message.answer(
        "┌──────────────────────────\n"
        "│ ₿ ОПЛАТА КРИПТОВАЛЮТОЙ\n"
        "├──────────────────────────\n"
        "│ Цена: $4.99 / месяц\n"
        "│\n"
        "│ USDT (TRC-20):\n"
        f"│ `{config.CRYPTO_WALLET}`\n"
        "│\n"
        "│ После оплаты отправьте\n"
        "│ хэш транзакции в\n"
        "│ 🛠 Тех. поддержку\n"
        "└──────────────────────────",
        parse_mode="Markdown"
    )
    await callback.answer()


@dp.pre_checkout_query()
async def pre_checkout(pre_checkout_query: types.PreCheckoutQuery):
    await bot.answer_pre_checkout_query(pre_checkout_query.id, ok=True)


@dp.message(F.successful_payment)
async def successful_payment(message: types.Message):
    payload = message.successful_payment.invoice_payload
    if payload == "premium_30d":
        until = (datetime.now() + timedelta(days=30)).strftime("%d.%m.%Y")
        db.set_premium(message.from_user.id, until)
        await message.answer(
            "┌──────────────────────────\n"
            "│ 🎉 ОПЛАТА ПРОШЛА УСПЕШНО!\n"
            "├──────────────────────────\n"
            "│ 💎 Премиум активирован\n"
            f"│ 📅 Действует до: {until}\n"
            "└──────────────────────────",
            reply_markup=main_menu(message.from_user.id in config.ADMIN_IDS)
        )


# ─────────────────────────────────────────
# REFERRAL
# ─────────────────────────────────────────
@dp.message(F.text == "🤝 Реферальная система")
async def referral_menu(message: types.Message):
    ref_link = f"https://t.me/{(await bot.get_me()).username}?start=ref{message.from_user.id}"
    count = db.get_referral_count(message.from_user.id)

    await message.answer(
        f"┌──────────────────────────\n"
        f"│ 🤝 РЕФЕРАЛЬНАЯ СИСТЕМА\n"
        f"├──────────────────────────\n"
        f"│ 👥 Ваших рефералов: {count}\n"
        f"├──────────────────────────\n"
        f"│ 📎 Ваша ссылка:\n"
        f"│ {ref_link}\n"
        f"├──────────────────────────\n"
        f"│ 🎁 За каждого реферала:\n"
        f"│  +1 бесплатный поиск\n"
        f"│  За 10 рефералов — 3 дня\n"
        f"│  премиума бесплатно!\n"
        f"└──────────────────────────"
    )


# ─────────────────────────────────────────
# SUPPORT
# ─────────────────────────────────────────
@dp.message(F.text == "🛠 Тех. поддержка")
async def support_menu(message: types.Message):
    await message.answer(
        "┌──────────────────────────\n"
        "│ 🛠 ТЕХ. ПОДДЕРЖКА\n"
        "├──────────────────────────\n"
        "│ Опишите вашу проблему,\n"
        "│ и мы ответим как можно\n"
        "│ скорее.\n"
        "└──────────────────────────\n\n"
        "✏️ Напишите ваш вопрос:"
    )
    # Use state to capture next message
    # Inline approach: mark user as "in support"
    db.set_support_mode(message.from_user.id, True)


@dp.message(F.text & ~F.text.startswith("/"))
async def handle_support_message(message: types.Message):
    if not db.get_support_mode(message.from_user.id):
        return

    db.set_support_mode(message.from_user.id, False)
    ticket_id = db.create_ticket(message.from_user.id, message.text)

    await message.answer(
        f"┌──────────────────────────\n"
        f"│ ✅ Обращение принято!\n"
        f"│ 🎫 Тикет #{ticket_id}\n"
        f"│ Ответим в ближайшее время\n"
        f"└──────────────────────────"
    )

    # Notify admins
    for admin_id in config.ADMIN_IDS:
        try:
            kb = InlineKeyboardBuilder()
            kb.button(text="💬 Ответить", callback_data=f"reply_ticket_{ticket_id}")
            await bot.send_message(
                admin_id,
                f"┌──────────────────────────\n"
                f"│ 🆕 НОВЫЙ ТИКЕТ #{ticket_id}\n"
                f"├──────────────────────────\n"
                f"│ 👤 От: {message.from_user.full_name}\n"
                f"│ 🆔 ID: {message.from_user.id}\n"
                f"│ @{message.from_user.username or '—'}\n"
                f"├──────────────────────────\n"
                f"│ 💬 {message.text}\n"
                f"└──────────────────────────",
                reply_markup=kb.as_markup()
            )
        except:
            pass


@dp.callback_query(F.data.startswith("reply_ticket_"))
async def reply_ticket(callback: types.CallbackQuery, state: FSMContext):
    ticket_id = int(callback.data.replace("reply_ticket_", ""))
    await state.update_data(ticket_id=ticket_id)
    await state.set_state(SupportStates.waiting_reply)
    await callback.message.answer(f"✏️ Введите ответ для тикета #{ticket_id}:")
    await callback.answer()


@dp.message(SupportStates.waiting_reply)
async def send_reply(message: types.Message, state: FSMContext):
    data = await state.get_data()
    ticket_id = data.get("ticket_id")
    ticket = db.get_ticket(ticket_id)
    await state.clear()

    if not ticket:
        await message.answer("❌ Тикет не найден.")
        return

    try:
        await bot.send_message(
            ticket["user_id"],
            f"┌──────────────────────────\n"
            f"│ 💬 ОТВЕТ ОТ ПОДДЕРЖКИ\n"
            f"│ Тикет #{ticket_id}\n"
            f"├──────────────────────────\n"
            f"│ {message.text}\n"
            f"└──────────────────────────"
        )
        await message.answer(f"✅ Ответ отправлен пользователю (тикет #{ticket_id})")
        db.close_ticket(ticket_id)
    except Exception as e:
        await message.answer(f"❌ Не удалось отправить: {e}")


# ─────────────────────────────────────────
# ADMIN PANEL
# ─────────────────────────────────────────
@dp.message(F.text == "⚙️ Админ панель")
async def admin_panel(message: types.Message):
    if message.from_user.id not in config.ADMIN_IDS:
        return

    stats = db.get_stats()
    kb = InlineKeyboardBuilder()
    kb.button(text="📢 Рассылка", callback_data="admin_broadcast")
    kb.button(text="👥 Пользователи", callback_data="admin_users")
    kb.button(text="🎫 Тикеты", callback_data="admin_tickets")
    kb.button(text="💎 Выдать премиум", callback_data="admin_give_premium")
    kb.button(text="📊 Статистика", callback_data="admin_stats")
    kb.adjust(2)

    await message.answer(
        f"┌──────────────────────────\n"
        f"│ ⚙️ АДМИН ПАНЕЛЬ\n"
        f"├──────────────────────────\n"
        f"│ 👥 Всего юзеров: {stats['users']}\n"
        f"│ 💎 Премиум: {stats['premium']}\n"
        f"│ 🎫 Открытых тикетов: {stats['open_tickets']}\n"
        f"└──────────────────────────",
        reply_markup=kb.as_markup()
    )


@dp.callback_query(F.data == "admin_broadcast")
async def admin_broadcast(callback: types.CallbackQuery, state: FSMContext):
    if callback.from_user.id not in config.ADMIN_IDS:
        return
    await state.set_state(BroadcastStates.waiting_message)
    await callback.message.answer("✏️ Введите сообщение для рассылки:")
    await callback.answer()


@dp.message(BroadcastStates.waiting_message)
async def do_broadcast(message: types.Message, state: FSMContext):
    await state.clear()
    users = db.get_all_users()
    sent, failed = 0, 0

    await message.answer(f"⏳ Начинаю рассылку {len(users)} пользователям...")

    for user in users:
        try:
            await bot.send_message(
                user["user_id"],
                f"📢 Сообщение от администратора:\n\n{message.text}"
            )
            sent += 1
        except:
            failed += 1
        await asyncio.sleep(0.05)

    await message.answer(
        f"┌──────────────────────────\n"
        f"│ ✅ Рассылка завершена!\n"
        f"│ 📤 Отправлено: {sent}\n"
        f"│ ❌ Ошибок: {failed}\n"
        f"└──────────────────────────"
    )


@dp.callback_query(F.data == "admin_stats")
async def admin_stats(callback: types.CallbackQuery):
    if callback.from_user.id not in config.ADMIN_IDS:
        return
    stats = db.get_stats()
    await callback.message.answer(
        f"┌──────────────────────────\n"
        f"│ 📊 СТАТИСТИКА БОТА\n"
        f"├──────────────────────────\n"
        f"│ 👥 Всего пользователей: {stats['users']}\n"
        f"│ 💎 Премиум юзеров: {stats['premium']}\n"
        f"│ 🎫 Открытых тикетов: {stats['open_tickets']}\n"
        f"│ 🎫 Всего тикетов: {stats['total_tickets']}\n"
        f"│ 🤝 Рефералов: {stats['referrals']}\n"
        f"└──────────────────────────"
    )
    await callback.answer()


@dp.callback_query(F.data == "admin_give_premium")
async def give_premium_prompt(callback: types.CallbackQuery, state: FSMContext):
    if callback.from_user.id not in config.ADMIN_IDS:
        return
    await state.set_state(AdminStates.waiting_user_id)
    await callback.message.answer("✏️ Введите ID пользователя для выдачи премиума:")
    await callback.answer()


@dp.message(AdminStates.waiting_user_id)
async def give_premium_execute(message: types.Message, state: FSMContext):
    await state.clear()
    try:
        uid = int(message.text.strip())
        until = (datetime.now() + timedelta(days=30)).strftime("%d.%m.%Y")
        db.set_premium(uid, until)
        await message.answer(f"✅ Премиум выдан пользователю {uid} до {until}")
        try:
            await bot.send_message(uid,
                f"┌──────────────────────────\n"
                f"│ 🎁 ВАМ ВЫДАН ПРЕМИУМ!\n"
                f"│ 📅 До: {until}\n"
                f"└──────────────────────────"
            )
        except:
            pass
    except ValueError:
        await message.answer("❌ Неверный ID. Введите число.")


@dp.callback_query(F.data == "admin_tickets")
async def admin_tickets(callback: types.CallbackQuery):
    if callback.from_user.id not in config.ADMIN_IDS:
        return
    tickets = db.get_open_tickets()
    if not tickets:
        await callback.answer("Открытых тикетов нет!", show_alert=True)
        return

    text = "┌──────────────────────────\n│ 🎫 ОТКРЫТЫЕ ТИКЕТЫ\n└──────────────────────────\n\n"
    kb = InlineKeyboardBuilder()
    for t in tickets[:10]:
        text += f"#{t['id']} | {t['text'][:50]}...\n"
        kb.button(text=f"Ответить #{t['id']}", callback_data=f"reply_ticket_{t['id']}")
    kb.adjust(1)

    await callback.message.answer(text, reply_markup=kb.as_markup())
    await callback.answer()


@dp.callback_query(F.data == "admin_users")
async def admin_users(callback: types.CallbackQuery):
    if callback.from_user.id not in config.ADMIN_IDS:
        return
    users = db.get_all_users()
    text = f"┌──────────────────────────\n│ 👥 ПОСЛЕДНИЕ ПОЛЬЗОВАТЕЛИ\n└──────────────────────────\n\n"
    for u in users[-10:]:
        prem = "💎" if u.get("is_premium") else ""
        text += f"{prem} {u['full_name']} | ID: {u['user_id']}\n"
    await callback.message.answer(text)
    await callback.answer()


# ─────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────
async def main():
    db.init()
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
