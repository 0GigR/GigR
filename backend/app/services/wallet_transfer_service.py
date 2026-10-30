"""Building the SPL token transfer the profile's USDC send submits.

This module exists because of one concrete failure. The profile's USDC send built
its instruction with ``transfer_checked(source=..., mint=..., dest=..., owner=...,
amount=..., decimals=6)``. In the installed ``spl.token`` that function takes a
single ``TransferCheckedParams``, so the call raised ``TypeError`` before a
transaction existed. The route caught nothing, the framework answered 500 without
the CORS headers a browser needs, and the client reported the whole thing as
"network request failed". The instruction is built here so the fix has one
testable seam instead of living in the middle of a route.

The amount is converted with ``Decimal``, not with a float product. ``int(2.01 *
1_000_000)`` is 2_009_999: the binary product lands just under the true value and
truncation drops an atomic unit. USDC has six decimals, and six decimals is what
this module moves.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from solders.instruction import Instruction
from solders.pubkey import Pubkey
from spl.token.instructions import (
    TOKEN_PROGRAM_ID,
    TransferCheckedParams,
    transfer_checked,
)

# USDC has six decimals on Solana; every amount in this module is atomic units.
USDC_DECIMALS = 6

# The most a single transfer may move. A bound is required on a money field, and
# this one is far above any peer transfer the product is for, so it only ever
# catches a decimal point in the wrong place.
MAX_USDC_TRANSFER = Decimal("1000000")


def usdc_amount_atomic(amount: float) -> int:
    """The USDC amount in atomic units, exactly as written.

    ``Decimal(str(amount))`` and not ``int(amount * 1_000_000)``: the float
    product is below the true value for many cent amounts (2.01 becomes
    2_009_999), so the transfer would quietly move one atomic unit less than the
    sender asked for.

    Raises :class:`ValueError` when the amount is not a finite number, is not
    greater than zero, is above :data:`MAX_USDC_TRANSFER`, or carries more than
    six decimal places. The route turns each of those into one 400 that names the
    rules, and nothing is sent.
    """
    try:
        value = Decimal(str(amount))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("the amount is not a number") from exc
    if not value.is_finite():
        raise ValueError("the amount is not a finite number")
    if value <= 0:
        raise ValueError("the amount must be greater than zero")
    if value > MAX_USDC_TRANSFER:
        raise ValueError("the amount is above the transfer limit")
    atomic = value.scaleb(USDC_DECIMALS)
    if atomic != atomic.to_integral_value():
        raise ValueError("the amount has more than six decimal places")
    return int(atomic)


def build_usdc_transfer_instruction(
    *,
    source: Pubkey,
    mint: Pubkey,
    dest: Pubkey,
    owner: Pubkey,
    amount_atomic: int,
) -> Instruction:
    """The checked SPL transfer, built the way this ``spl.token`` version takes it.

    ``TransferCheckedParams`` carries the mint and the decimals, which is what
    makes the transfer *checked*: the token program verifies that the source
    account holds that mint with those decimals, so a transfer cannot silently
    move a different token. Returning the instruction keeps the caller in charge
    of the blockhash and the send, which is where the write actually happens.
    """
    return transfer_checked(
        TransferCheckedParams(
            program_id=TOKEN_PROGRAM_ID,
            source=source,
            mint=mint,
            dest=dest,
            owner=owner,
            amount=amount_atomic,
            decimals=USDC_DECIMALS,
        )
    )
