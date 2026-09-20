"""Seed (and remove) demo data for the Gigr demo video.

The map can only show what has coordinates, and most historical rows do not, so
a fresh recording looks empty. This creates a believable cluster of nearby jobs
and services around a point.

Safety, by design:

* It writes ONLY when you pass ``--yes``.
* Every id it creates is recorded in ``demo-data-manifest.json``, so
  ``--cleanup`` removes exactly what was seeded and nothing else.
* It reuses an existing account when the email already exists; it never deletes
  a user.

Usage (from ``backend/``)::

    # preview what would be created
    python scripts/seed_demo_data.py --email demo@gigr.dev

    # actually create it around Yaba, Lagos
    python scripts/seed_demo_data.py --email demo@gigr.dev --lat 6.5244 --lng 3.3792 --yes

    # remove everything it created
    python scripts/seed_demo_data.py --email demo@gigr.dev --cleanup --yes
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.main  # noqa: E402  (registers every ORM model before touching the DB)
from sqlalchemy import text  # noqa: E402
from app.core.database import async_session  # noqa: E402

MANIFEST = Path(__file__).resolve().parents[1] / "demo-data-manifest.json"

JOBS = [
    ("Fix a leaking kitchen tap", 6500, "Kitchen tap drips constantly. Need it replaced or resealed today."),
    ("Assemble a 3-door wardrobe", 12000, "Flat-pack wardrobe, tools not included. Two people preferred."),
    ("Deep clean a 2-bedroom flat", 15000, "Move-out clean. Kitchen and bathroom are the priority."),
    ("Install a wall-mounted TV", 9000, "65-inch TV, bracket already bought. Wall is concrete."),
    ("Rewire two bedrooms", 35000, "Old wiring, sockets sparking. Must be certified."),
    ("Sew a traditional outfit", 18000, "Ankara fabric already bought. Event is in ten days."),
    ("Deliver a cake to Lekki", 4000, "Pickup from Yaba at 2pm, deliver before 5pm. Cake is fragile."),
    ("Repair a generator", 22000, "Tiger generator won't start. Suspect the carburettor."),
    ("Paint a living room", 25000, "Two coats, paint supplied. Room is about 20 square metres."),
    ("Fix a broken phone screen", 11000, "Samsung A54, screen cracked but still displays."),
]

SERVICES = [
    ("Emergency Plumbing", 7000, "Leaks, blockages and tap replacements across the mainland.", 8),
    ("Furniture Assembly", 8000, "Flat-pack and custom furniture assembled same day.", 12),
    ("Home Deep Cleaning", 14000, "Kitchen, bathroom and full-flat deep cleans.", 10),
    ("Certified Electrician", 20000, "Wiring, sockets, inverters. Certified and insured.", 15),
    ("Tailoring and Alterations", 9000, "Traditional and modern outfits, fitted to measure.", 6),
    ("Generator Repair", 18000, "Diagnostics and repair for common generator faults.", 10),
    ("Painting and Finishing", 22000, "Interior painting, screeding and finishing.", 10),
    ("Phone Screen Repair", 9500, "Screen and battery replacements while you wait.", 5),
    ("Errand Runner", 3500, "Deliveries, pickups and queue-standing around town.", 7),
    ("Event Photography", 30000, "Half-day coverage with edited photos in 72 hours.", 20),
]


def _offset(lat: float, lng: float, radius_km: float) -> tuple[float, float]:
    """A random point within radius_km of the centre."""
    angle = random.uniform(0, 2 * math.pi)
    distance = radius_km * math.sqrt(random.random())
    d_lat = (distance / 111.32) * math.cos(angle)
    d_lng = (distance / (111.32 * math.cos(math.radians(lat)))) * math.sin(angle)
    return lat + d_lat, lng + d_lng


async def _ensure_user(db, email: str, display_name: str) -> str:
    row = (await db.execute(text("SELECT id FROM users WHERE email = :e"), {"e": email})).scalar()
    if row:
        print(f"reusing existing user {email}")
        return str(row)
    from app.core.security import get_password_hash
    user_id = str(uuid.uuid4())
    await db.execute(
        text(
            "INSERT INTO users (id, email, hashed_password, display_name, is_verified, role, ai_enabled) "
            "VALUES (:id, :email, :pw, :name, true, 'user', true)"
        ),
        {"id": user_id, "email": email, "pw": get_password_hash("DemoPass!123"), "name": display_name},
    )
    print(f"created demo user {email} (password: DemoPass!123)")
    return user_id


async def seed(email: str, lat: float, lng: float, radius_km: float, apply: bool) -> None:
    async with async_session() as db:
        created: dict[str, list[str]] = {"jobs": [], "services": []}

        job_ids = [str(uuid.uuid4()) for _ in JOBS]
        service_ids = [str(uuid.uuid4()) for _ in SERVICES]

        print(f"\nWould create {len(JOBS)} jobs and {len(SERVICES)} services around {lat}, {lng} (within {radius_km} km):")
        for (title, price, _), _id in zip(JOBS, job_ids):
            print(f"  job      {title:34} NGN {price:>7,}")
        for (title, price, _, _r), _id in zip(SERVICES, service_ids):
            print(f"  service  {title:34} NGN {price:>7,}")

        if not apply:
            print("\nDry run. Re-run with --yes to write.")
            return

        user_id = await _ensure_user(db, email, "Demo Account")

        category = (await db.execute(text("SELECT id FROM categories ORDER BY name LIMIT 1"))).scalar()
        if not category:
            category = str(uuid.uuid4())
            await db.execute(
                text("INSERT INTO categories (id, name) VALUES (:id, 'General')"), {"id": category}
            )
            print("created a 'General' category (none existed)")

        for (title, price, description), job_id in zip(JOBS, job_ids):
            j_lat, j_lng = _offset(lat, lng, radius_km)
            await db.execute(
                text(
                    "INSERT INTO jobs (id, client_id, title, description, price, status, location, "
                    "contract_job_id, category_id) VALUES (:id, :client, :title, :desc, :price, 'open', "
                    "ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :contract, :cat)"
                ),
                {
                    "id": job_id, "client": user_id, "title": title, "desc": description,
                    "price": price, "lat": j_lat, "lng": j_lng,
                    "contract": uuid.uuid4().hex[:16], "cat": category,
                },
            )
            created["jobs"].append(job_id)

        for (title, price, description, service_radius), service_id in zip(SERVICES, service_ids):
            s_lat, s_lng = _offset(lat, lng, radius_km)
            await db.execute(
                text(
                    "INSERT INTO service_listings (id, provider_id, category_id, title, description, price, "
                    "is_active, radius_km, location) VALUES (:id, :provider, :cat, :title, :desc, :price, true, "
                    ":radius, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography)"
                ),
                {
                    "id": service_id, "provider": user_id, "cat": category, "title": title,
                    "desc": description, "price": price, "radius": service_radius,
                    "lat": s_lat, "lng": s_lng,
                },
            )
            created["services"].append(service_id)

        await db.commit()

        MANIFEST.write_text(
            json.dumps(
                {
                    "email": email,
                    "note": "Ids created by scripts/seed_demo_data.py. Remove with --cleanup.",
                    **created,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\nCreated {len(created['jobs'])} jobs and {len(created['services'])} services.")
        print(f"Manifest written to {MANIFEST.name} — run with --cleanup --yes to remove them.")


async def cleanup(apply: bool) -> None:
    if not MANIFEST.exists():
        print(f"No manifest at {MANIFEST.name} — nothing to clean.")
        return
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    jobs = data.get("jobs", [])
    services = data.get("services", [])
    print(f"Manifest lists {len(jobs)} jobs and {len(services)} services for {data.get('email')}.")
    if not apply:
        print("Dry run. Re-run with --cleanup --yes to delete.")
        return

    async with async_session() as db:
        if jobs:
            incl = ",".join(f"'{i}'" for i in jobs)
            chat_tags = ",".join(f"'chat:{i}'" for i in jobs)
            for table in ("messages", "applications", "scope_amendments", "vouches", "job_categories"):
                await db.execute(text(f"DELETE FROM {table} WHERE job_id IN ({incl})"))
            await db.execute(text(f"DELETE FROM notifications WHERE tag IN ({chat_tags})"))
            deleted = await db.execute(text(f"DELETE FROM jobs WHERE id IN ({incl})"))
            print(f"  jobs deleted: {deleted.rowcount}")
        if services:
            incl = ",".join(f"'{i}'" for i in services)
            deleted = await db.execute(text(f"DELETE FROM service_listings WHERE id IN ({incl})"))
            print(f"  services deleted: {deleted.rowcount}")
        await db.commit()
    MANIFEST.unlink(missing_ok=True)
    print("Manifest removed. The demo user account was left in place on purpose.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed or remove Gigr demo data.")
    parser.add_argument("--email", default="demo@gigr.dev", help="Account to attach the demo data to.")
    parser.add_argument("--lat", type=float, default=6.5244, help="Centre latitude (default: Lagos).")
    parser.add_argument("--lng", type=float, default=3.3792, help="Centre longitude.")
    parser.add_argument("--radius-km", type=float, default=6.0, help="How far to scatter points.")
    parser.add_argument("--cleanup", action="store_true", help="Remove previously seeded data.")
    parser.add_argument("--yes", action="store_true", help="Actually write. Without it, this is a dry run.")
    args = parser.parse_args()

    if args.cleanup:
        asyncio.run(cleanup(args.yes))
    else:
        asyncio.run(seed(args.email, args.lat, args.lng, args.radius_km, args.yes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
