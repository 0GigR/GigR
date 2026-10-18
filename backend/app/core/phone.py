"""
phone.py - Phone number normalization and validation utilities.

Normalizes phone numbers to standard E.164 format.
Specifically handles Nigerian numbers where local formats like:
  - +2349019549999
  - 2349019549999
  - 09019549999
  - 9019549999
  - +234 901 954 9999
  - +23409019549999
all resolve consistently to '+2349019549999'.
"""

from __future__ import annotations

import re
from typing import Optional


def normalize_phone_number(raw_input: Optional[str]) -> Optional[str]:
    """Normalize a phone number string to an E.164-compatible format.

    Returns None when the input is empty, invalid, or cannot be normalized.
    """
    if not raw_input or not isinstance(raw_input, str):
        return None

    cleaned_text = raw_input.strip()
    if not cleaned_text:
        return None

    has_leading_plus = cleaned_text.startswith("+")
    digits_only = re.sub(r"\D", "", cleaned_text)
    if not digits_only:
        return None

    # Handle international dialing prefix '00'
    if digits_only.startswith("00"):
        digits_only = digits_only[2:]
        has_leading_plus = True

    # 1. Starts with 234: e.g. '2349019549999' or '23409019549999'
    if digits_only.startswith("234"):
        local_segment = digits_only[3:]
        if local_segment.startswith("0"):
            local_segment = local_segment[1:]
        if len(local_segment) == 10:
            return f"+234{local_segment}"
        return f"+234{local_segment}" if local_segment else None

    # 2. Local format starting with 0 (11 digits): e.g. '09019549999', '08031234567'
    if digits_only.startswith("0") and len(digits_only) == 11:
        return f"+234{digits_only[1:]}"

    # 3. 10 digits without leading 0: e.g. '9019549999', '8031234567', '7011234567'
    if len(digits_only) == 10 and digits_only[0] in ("7", "8", "9"):
        return f"+234{digits_only}"

    # 4. Standard international with leading plus
    if has_leading_plus:
        return f"+{digits_only}"

    # 5. International number typed without leading plus (11-15 digits)
    if len(digits_only) >= 11:
        return f"+{digits_only}"

    # Fallback for other valid digit sequences
    if len(digits_only) >= 7:
        return f"+{digits_only}"

    return None
