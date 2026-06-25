#!/usr/bin/env python3
"""
Fund all user wallets in the database with SOL or USDC on Solana devnet.

This script:
1. Connects to the database and retrieves all users with wallets
2. For each user, funds their wallet with a specified amount
3. Supports both SOL and USDC funding
4. Uses the existing solana_client infrastructure for blockchain operations

Usage: python fund_wallets.py [amount] [token_type]
  amount: Amount to fund each wallet (default: 1.0)
  token_type: "sol" for SOL, "usdc" for USDC (default: sol)
"""

import asyncio
import logging
from typing import List
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from spl.token.instructions import get_associated_token_address, create_associated_token_account
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TxOpts
from solders.transaction import VersionedTransaction
from solders.message import MessageV0
from solders.hash import Hash

from app.core.database import engine
from app.core.config import settings

# Import User model without triggering relationship initialization
from app.models.user import User
from app.services.solana_client import _get_payer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
USDC_MINT = Pubkey.from_string(settings.USDC_MINT_DEVNET)
PROGRAM_ID = Pubkey.from_string(settings.GIGR_PROGRAM_ID)
RPC_URL = settings.SOLANA_RPC_URL

async def get_all_users_with_wallets(db: AsyncSession) -> List[User]:
    """Get all users that have wallet_public_key set."""
    result = await db.execute(
        select(User).where(User.wallet_public_key.isnot(None))
    )
    return result.scalars().all()

async def fund_user_wallet(
    db: AsyncSession,
    user: User,
    amount: float,
    token_type: str,
    payer_kp: Keypair,
    rpc_client: AsyncClient
) -> bool:
    """Fund a single user's wallet with the specified amount."""
    try:
        user_pubkey = Pubkey.from_string(user.wallet_public_key)
        logger.info(f"Funding wallet for user {user.id} ({user.email}) with {amount} {token_type.upper()}")
        
        if token_type.lower() == "sol":
            # Fund with SOL
            from solders.system_program import transfer
            from solders.transaction import Transaction
            
            # Create transfer instruction
            lamports = int(amount * 1e9)  # Convert SOL to lamports
            transfer_ix = transfer(
                from_pubkey=payer_kp.pubkey(),
                to_pubkey=user_pubkey,
                lamports=lamports,
            )
            
            # Create and send transaction
            blockhash_resp = await rpc_client.get_latest_blockhash()
            recent_blockhash = blockhash_resp.value.blockhash
            msg = MessageV0.try_compile(
                payer=payer_kp.pubkey(),
                instructions=[transfer_ix],
                address_lookup_table_accounts=[],
                recent_blockhash=recent_blockhash,
            )
            tx = VersionedTransaction(msg, [payer_kp])
            
            resp = await rpc_client.send_transaction(tx, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))
            logger.info(f"SOL transfer transaction: {resp.value}")
            
        elif token_type.lower() == "usdc":
            # Fund with USDC
            # First ensure user has an ATA for USDC
            user_ata = get_associated_token_address(user_pubkey, USDC_MINT)
            
            # Check if ATA exists
            info = await rpc_client.get_account_info(user_ata)
            if info.value is None:
                # Create ATA
                logger.info(f"Creating ATA for user {user.id}")
                ix = create_associated_token_account(
                    payer=payer_kp.pubkey(),
                    owner=user_pubkey,
                    mint=USDC_MINT,
                )
                
                blockhash_resp = await rpc_client.get_latest_blockhash()
                recent_blockhash = blockhash_resp.value.blockhash
                msg = MessageV0.try_compile(
                    payer=payer_kp.pubkey(),
                    instructions=[ix],
                    address_lookup_table_accounts=[],
                    recent_blockhash=recent_blockhash,
                )
                tx = VersionedTransaction(msg, [payer_kp])
                await rpc_client.send_transaction(tx, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))
                await asyncio.sleep(2)  # Wait for ATA creation
            
            # Transfer USDC
            from spl.token.instructions import transfer as token_transfer
            
            # Get payer's ATA
            payer_ata = get_associated_token_address(payer_kp.pubkey(), USDC_MINT)
            
            # Calculate amount in smallest units (6 decimals for USDC)
            amount_smallest_units = int(amount * 1_000_000)
            
            transfer_ix = token_transfer(
                source=payer_ata,
                dest=user_ata,
                amount=amount_smallest_units,
                owner=payer_kp.pubkey(),
            )
            
            blockhash_resp = await rpc_client.get_latest_blockhash()
            recent_blockhash = blockhash_resp.value.blockhash
            msg = MessageV0.try_compile(
                payer=payer_kp.pubkey(),
                instructions=[transfer_ix],
                address_lookup_table_accounts=[],
                recent_blockhash=recent_blockhash,
            )
            tx = VersionedTransaction(msg, [payer_kp])
            
            resp = await rpc_client.send_transaction(tx, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))
            logger.info(f"USDC transfer transaction: {resp.value}")
            
        else:
            raise ValueError(f"Unsupported token type: {token_type}")
        
        logger.info(f"Successfully funded wallet for user {user.id}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to fund wallet for user {user.id}: {e}")
        return False

async def main():
    """Main funding function."""
    import sys
    
    # Parse command line arguments
    amount = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
    token_type = sys.argv[2] if len(sys.argv) > 2 else "sol"
    
    logger.info(f"Starting wallet funding process")
    logger.info(f"Amount: {amount} {token_type.upper()}")
    logger.info(f"Token type: {token_type}")
    
    # Initialize RPC client
    rpc_client = AsyncClient(RPC_URL, timeout=60)
    
    # Get payer keypair
    payer_kp = _get_payer()
    
    try:
        # Get all users with wallets
        async with AsyncSession(engine) as db:
            users = await get_all_users_with_wallets(db)
            logger.info(f"Found {len(users)} users with wallets")
            
            if not users:
                logger.warning("No users with wallets found in database")
                return
            
            # Fund each user
            success_count = 0
            for user in users:
                try:
                    success = await fund_user_wallet(db, user, amount, token_type, payer_kp, rpc_client)
                    if success:
                        success_count += 1
                    await asyncio.sleep(1)  # Rate limiting
                except Exception as e:
                    logger.error(f"Error processing user {user.id}: {e}")
                    continue
            
            logger.info(f"Funding completed: {success_count}/{len(users)} wallets funded successfully")
            
    finally:
        await rpc_client.close()

if __name__ == "__main__":
    asyncio.run(main())