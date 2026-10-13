"""Демо-база интернет-магазина: 12 таблиц, self-refs, 1:1, n:m, два view.

Генерируется один раз в data/shop.db, чтобы сразу было что смотреть.
"""
from __future__ import annotations

import random
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "shop.db"

FIRST = ["Анна", "Борис", "Вера", "Глеб", "Дана", "Егор", "Жанна", "Захар",
         "Ирина", "Кирилл", "Лена", "Марат", "Нина", "Олег", "Поля", "Рустам"]
LAST = ["Смирнова", "Кузнецов", "Орлова", "Волков", "Егорова", "Фетисов",
        "Захарова", "Ибрагимов", "Леонова", "Марченко", "Носов", "Осипова"]
CITIES = [("Москва", "RU"), ("Алматы", "KZ"), ("Минск", "BY"), ("Тбилиси", "GE"),
          ("Ереван", "AM"), ("Санкт-Петербург", "RU")]
CATS = ["Компьютеры", "Смартфоны", "Аудио", "Фото", "Аксессуары", "Игры", "Умный дом"]
SUBCATS = {"Компьютеры": ["Ноутбуки", "Моноблоки"], "Смартфоны": ["Флагманы", "Бюджетные"],
           "Аудио": ["Наушники", "Колонки"], "Фото": ["Зеркалки", "Экшн-камеры"],
           "Аксессуары": ["Чехлы", "Зарядки"], "Игры": ["Консоли", "Геймпады"],
           "Умный дом": ["Лампы", "Розетки"]}
PRODUCTS = [("Ноутбук ZenAir 14", 98990), ("Моноблок Studio 27", 145000), ("Смартфон Pixel X", 79990),
            ("Смартфон Lite M2", 24990), ("Наушники SoundPro ANC", 28490), ("Колонка Boom Mini", 6990),
            ("Зеркалка Retro FX", 89900), ("Экшн-камера GoWide 4K", 34990), ("Чехол Leather for Pixel X", 4790),
            ("Зарядка Turbo 65W GaN", 5490), ("Консоль PlayBox X", 59990), ("Геймпад Precision Pro", 12590),
            ("Лампа Ambient RGB", 8990), ("Розетка Smarthome Wi-Fi", 3290), ("Наушники Studio Wire 2", 14990),
            ("Ноутбук DevBook Pro 16", 199990), ("Смартфон Pixel XL Max", 119990), ("Колонка Bass Tower", 26990)]
STATUSES = ["new", "paid", "shipped", "delivered", "cancelled"]


def ensure_demo_db(force: bool = False) -> Path:
    """Создать демо-базу, если её нет (или нужен refresh). Возвращает путь."""
    if DB_PATH.exists() and not force:
        return DB_PATH
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = DB_PATH.with_suffix(".tmp.db")
    temp_path.unlink(missing_ok=True)
    rng = random.Random(42)
    conn = sqlite3.connect(temp_path)
    try:
        _build(conn, rng)
        conn.commit()
    except Exception:
        conn.close()
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        if conn:
            conn.close()
    temp_path.replace(DB_PATH)
    return DB_PATH


def _build(conn: sqlite3.Connection, rng: random.Random) -> None:
    c = conn.cursor()
    c.executescript("""
    PRAGMA foreign_keys = ON;

    CREATE TABLE users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        email       TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        referred_by_id INTEGER REFERENCES users(id),
        default_address_id INTEGER REFERENCES addresses(id)
    );

    CREATE TABLE addresses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        street      TEXT NOT NULL,
        city        TEXT NOT NULL,
        country_code TEXT NOT NULL,
        is_default  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE categories (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT NOT NULL,
        parent_id INTEGER REFERENCES categories(id)
    );

    CREATE TABLE coupons (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        code     TEXT NOT NULL UNIQUE,
        discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 90),
        active_until TEXT
    );

    CREATE TABLE products (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        sku      TEXT NOT NULL UNIQUE,
        name     TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        stock    INTEGER NOT NULL DEFAULT 0,
        category_id INTEGER REFERENCES categories(id),
        created_at TEXT NOT NULL
    );

    CREATE TABLE tags (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE product_tags (
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (product_id, tag_id)
    );

    CREATE TABLE orders (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id  INTEGER NOT NULL REFERENCES users(id),
        status   TEXT NOT NULL DEFAULT 'new',
        total_cents INTEGER NOT NULL DEFAULT 0,
        coupon_id INTEGER REFERENCES coupons(id),
        placed_at TEXT NOT NULL
    );

    CREATE TABLE order_items (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        qty      INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL
    );

    CREATE TABLE payments (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
        provider TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status   TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE shipments (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        carrier  TEXT NOT NULL,
        tracking_no TEXT NOT NULL UNIQUE,
        sent_at  TEXT,
        delivered_at TEXT
    );

    CREATE TABLE reviews (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        body       TEXT,
        created_at TEXT NOT NULL
    );

    CREATE INDEX idx_orders_user   ON orders(user_id, placed_at);
    CREATE INDEX idx_items_order   ON order_items(order_id);
    CREATE INDEX idx_items_product ON order_items(product_id);
    CREATE INDEX idx_reviews_prod  ON reviews(product_id);
    CREATE INDEX idx_ship_track    ON shipments(tracking_no);

    CREATE VIEW monthly_revenue AS
    SELECT strftime('%Y-%m', placed_at) AS month,
           COUNT(*)          AS order_count,
           SUM(total_cents)/100.0 AS revenue
    FROM orders GROUP BY strftime('%Y-%m', placed_at);

    CREATE VIEW product_ratings AS
    SELECT p.id AS product_id, p.name AS product_name,
           ROUND(AVG(r.rating), 2) AS avg_rating,
           COUNT(r.id) AS review_count
    FROM products p LEFT JOIN reviews r ON r.product_id = p.id
    GROUP BY p.id;
    """)

    # --- данныe: users ------------------------------------------------------
    n_users = 14
    emails = []
    for i in range(1, n_users + 1):
        fn, ln = rng.choice(FIRST), rng.choice(LAST)
        email = f"{fn.lower()}.{ln.lower()}{i}@ex.dev"
        emails.append(email)
        c.execute("INSERT INTO users(email,name,created_at) VALUES (?,?,?)",
                  (email, f"{fn} {ln}", f"2025-{rng.randint(1,9):02d}-{rng.randint(1,28):02d}"))
    # self-ref: половина пользователей приведена кем-то
    for i in range(2, n_users + 1):
        ref = rng.randrange(1, i)
        c.execute("UPDATE users SET referred_by_id=? WHERE id=?", (ref, i))

    c.execute("INSERT INTO addresses(user_id,street,city,country_code,is_default) VALUES (?,?,?,?,1)",
              (1, "ул. Ленина, 5", "Москва", "RU"))
    for uid in range(2, n_users + 1):
        city, cc = rng.choice(CITIES)
        c.execute("INSERT INTO addresses(user_id,street,city,country_code,is_default) VALUES (?,?,?,?,1)",
                  (uid, f"ул. {rng.choice(LAST)}, {rng.randint(1,120)}", city, cc))
    c.execute("UPDATE users SET default_address_id=1 WHERE id=1")
    for uid in range(2, n_users + 1):
        addr = c.execute("SELECT id FROM addresses WHERE user_id=? LIMIT 1", (uid,)).fetchone()
        c.execute("UPDATE users SET default_address_id=? WHERE id=?", (addr[0], uid))

    c.execute("INSERT INTO categories(name,parent_id) VALUES (?,NULL)", ("Каталог",))
    root = c.lastrowid
    cat_ids = {}
    for cat in CATS:
        c.execute("INSERT INTO categories(name,parent_id) VALUES (?,?)", (cat, root))
        cat_ids[cat] = c.lastrowid
    for cat, subs in SUBCATS.items():
        for sub in subs:
            c.execute("INSERT INTO categories(name,parent_id) VALUES (?,?)", (sub, cat_ids[cat]))

    c.executemany("INSERT INTO coupons(code,discount_percent,active_until) VALUES (?,?,?)",
                  [("WELCOME10", 10, "2026-12-31"), ("BLACKFRIDAY30", 30, "2026-11-01"),
                   ("SPRING5", 5, "2026-06-01"), ("DEAD20", 20, "2025-01-01")])

    prod_ids, prod_names = [], []
    for i, (pname, price) in enumerate(PRODUCTS, 1):
        sku = f"SKU-{i:04d}"
        cat = c.execute("SELECT id FROM categories WHERE name=? AND parent_id IS NOT NULL LIMIT 1",
                        (SUBCATS[rng.choice(CATS)][0],)).fetchone()[0]
        c.execute("INSERT INTO products(sku,name,price_cents,stock,category_id,created_at) VALUES (?,?,?,?,?,?)",
                  (sku, pname, price, rng.randint(0, 300), cat, f"2025-0{rng.randint(1,9)}-{rng.randint(10,28):02d}"))
        prod_ids.append(c.lastrowid)
        prod_names.append(pname)

    c.executemany("INSERT INTO tags(name) VALUES (?)",
                  [("новинка",), ("скидка",), ("бестселлер",), ("хит",), ("лимитка",)])
    tag_ids = [r[0] for r in c.execute("SELECT id FROM tags")]
    for pid in prod_ids:
        for tid in rng.sample(tag_ids, rng.randint(1, 3)):
            c.execute("INSERT OR IGNORE INTO product_tags(product_id,tag_id) VALUES (?,?)", (pid, tid))

    # orders + items + 1:1 payments + shipments
    n_orders = 40
    for i in range(1, n_orders + 1):
        uid = rng.randint(1, n_users)
        status = rng.choice(STATUSES[:4] if i <= 35 else STATUSES[4:])
        day = rng.randint(1, 28)
        month = rng.randint(1, 12)
        coupon = rng.choice([None, 1, 2, 3, 4])
        c.execute("INSERT INTO orders(user_id,status,total_cents,coupon_id,placed_at) VALUES (?,?,?,?,?)",
                  (uid, status, 0, coupon, f"2025-{month:02d}-{day:02d} {rng.randint(8,22)}:{rng.randint(0,59):02d}"))
        oid = c.lastrowid
        total = 0
        for _ in range(rng.randint(1, 4)):
            pos = rng.randrange(len(prod_ids))
            pid, price, pname = prod_ids[pos], PRODUCTS[pos][1], prod_names[pos]
            qty = rng.randint(1, 3)
            c.execute("INSERT INTO order_items(order_id,product_id,qty,unit_price_cents) VALUES (?,?,?,?)",
                      (oid, pid, qty, price))
            total += price * qty
        c.execute("UPDATE orders SET total_cents=? WHERE id=?", (total, oid))
        if status != "new":
            c.execute("INSERT INTO payments(order_id,provider,amount_cents,status) VALUES (?,?,?,?)",
                      (oid, rng.choice(["card", "apple-pay", "paypal"]), total,
                       "paid" if status != "cancelled" else "refunded"))
        if status in ("shipped", "delivered"):
            sent = rng.randint(1, 27)
            delivered = sent + 3 if rng.random() < 0.7 else None
            c.execute("INSERT INTO shipments(order_id,carrier,tracking_no,sent_at,delivered_at) VALUES (?,?,?,?,?)",
                      (oid, rng.choice(["CDEK", "Boxberry", "DPD"]), f"TRK-{oid:06d}",
                       f"2025-{month:02d}-{sent:02d}", f"2025-{month:02d}-{delivered:02d}" if delivered else None))

    # reviews
    for _ in range(60):
        c.execute("INSERT INTO reviews(product_id,user_id,rating,body,created_at) VALUES (?,?,?,?,?)",
                  (rng.choice(prod_ids), rng.randint(1, n_users), rng.randint(1, 5),
                   rng.choice([None, "Отлично!", "Не подошло, вернул.", "Работает норм.", "Советую!"]),
                   f"2025-{rng.randint(1,12):02d}-{rng.randint(1,28):02d}"))


if __name__ == "__main__":
    print(ensure_demo_db(force=True))
