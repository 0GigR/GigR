"""The USDC transfer the profile sends: its atomic amount and its instruction.

Two real defects came out of the same send, and this file pins both.

The first is why the profile reported "network request failed". The route built
its instruction with ``transfer_checked(source=..., mint=..., dest=..., owner=...,
amount=..., decimals=6)``. This ``spl.token`` takes one ``TransferCheckedParams``,
so that call raised ``TypeError`` before a transaction existed. Nothing caught it,
so the framework answered 500 without the CORS headers a browser requires, and
axios therefore reported no response at all. The builder is called here, so a
regression to keyword arguments fails this file immediately.

The second is the amount. ``int(amount * 1_000_000)`` is 2_009_999 for 2.01 USDC:
the binary float product lands just under the true value and truncation eats an
atomic unit. The cent amounts below are ones the float product rounds down.

Nothing here touches the network. The instruction is built and its bytes are
read: the token program's own layout is what a transfer is judged by.
"""

from __future__ import annotations

import pytest
from solders.pubkey import Pubkey

from app.services.wallet_transfer_service import (
    MAX_USDC_TRANSFER,
    USDC_DECIMALS,
    build_usdc_transfer_instruction,
    usdc_amount_atomic,
)

SENDER_ATA = Pubkey.from_string("3bX6nZcuUAhtQCYGL1To7LwDJUmRituJ9Gu8bo8hXMib")
USDC_MINT = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
RECIPIENT_ATA = Pubkey.from_string("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")
OWNER = Pubkey.from_string("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1")

TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

# The token program's discriminator for TransferChecked. A transfer with another
# discriminator is a different instruction, whatever the rest of the bytes say.
TRANSFER_CHECKED_DISCRIMINATOR = 12


def an_instruction(amount_atomic: int = 2_010_000):
    return build_usdc_transfer_instruction(
        source=SENDER_ATA,
        mint=USDC_MINT,
        dest=RECIPIENT_ATA,
        owner=OWNER,
        amount_atomic=amount_atomic,
    )


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        (2.01, 2_010_000),
        (2.03, 2_030_000),
        (2.05, 2_050_000),
        (70, 70_000_000),
        (0.000001, 1),
        (1, 1_000_000),
    ],
)
def test_usdc_amount_atomic_never_lands_below_the_amount_asked_for(amount, expected):
    assert usdc_amount_atomic(amount) == expected


def test_usdc_amount_atomic_accepts_the_transfer_limit_exactly():
    assert usdc_amount_atomic(float(MAX_USDC_TRANSFER)) == int(
        MAX_USDC_TRANSFER * 10**USDC_DECIMALS
    )


@pytest.mark.parametrize(
    "amount",
    [
        0,
        -1,
        -0.01,
        1.0000001,
        0.0000001,
        float(MAX_USDC_TRANSFER) + 1,
        float("inf"),
        float("nan"),
    ],
)
def test_usdc_amount_atomic_refuses_an_amount_that_cannot_be_sent(amount):
    with pytest.raises(ValueError):
        usdc_amount_atomic(amount)


def test_the_instruction_is_a_checked_transfer_of_the_usdc_mint():
    instruction = an_instruction()

    assert str(instruction.program_id) == TOKEN_PROGRAM
    assert instruction.data[0] == TRANSFER_CHECKED_DISCRIMINATOR
    assert instruction.data[-1] == USDC_DECIMALS


def test_the_instruction_carries_the_amount_in_atomic_units():
    instruction = an_instruction(2_010_000)

    assert int.from_bytes(instruction.data[1:9], "little") == 2_010_000


def test_the_instruction_addresses_the_sender_the_mint_the_recipient_and_the_owner():
    instruction = an_instruction()

    assert [str(meta.pubkey) for meta in instruction.accounts] == [
        str(SENDER_ATA),
        str(USDC_MINT),
        str(RECIPIENT_ATA),
        str(OWNER),
    ]
