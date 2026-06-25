#!/usr/bin/env python3
"""
Simple wallet funding using Solana CLI airdrop.

This script:
1. Reads user wallet public keys from the database
2. Uses Solana CLI to airdrop SOL to each wallet
3. Much simpler than the complex blockchain transfer approach

Requirements:
- Solana CLI installed and configured for devnet
- Database access to read user wallets
- Sufficient SOL in the default keypair for airdrops

Usage: python simple_fund_wallets.py [amount] [token_type]
  amount: Amount to airdrop to each wallet (default: 1.0)
  token_type: "sol" for SOL airdrop (default: sol)
"""

import asyncio
import logging
import subprocess
import sys
from typing import List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import engine
from app.core.config import settings
from app.models.user import User

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def get_all_users_with_wallets(db: AsyncSession) -> List[User]:
    """Get all users that have wallet_public_key set."""
    result = await db.execute(
        select(User).where(User.wallet_public_key.isnot(None))
    )
    return result.scalars().all()

async def airdrop_to_wallet(wallet_address: str, amount: float) -> bool:
    """Use Solana CLI to airdrop SOL to a wallet."""
    try:
        logger.info(f"Airdropping {amount} SOL to {wallet_address}")
        
        # Use Solana CLI airdrop command
        # Note: This requires Solana CLI to be installed and configured for devnet
        cmd = [
            "solana", "airdrop", str(amount), wallet_address,
            "--url", "https://api.devnet.solana.com"
        ]
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60  # 60 second timeout
        )
        
        if result.returncode == 0:
            logger.info(f"Airdrop successful: {result.stdout.strip()}")
            return True
        else:
            logger.error(f"Airdrop failed: {result.stderr.strip()}")
            return False
            
    except subprocess.TimeoutExpired:
        logger.error(f"Airdrop timeout for {wallet_address}")
        return False
    except Exception as e:
        logger.error(f"Error airdropping to {wallet_address}: {e}")
        return False

async def main():
    """Main funding function."""
    import sys
    
    # Parse command line arguments
    amount = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
    token_type = sys.argv[2] if len(sys.argv) > 2 else "sol"
    
    # Only support SOL airdrops via CLI
    if token_type.lower() != "sol":
        logger.error("Simple funding only supports SOL airdrops via CLI")
        logger.error("For USDC funding, use the complex fund_wallets.py script")
        sys.exit(1)
    
    logger.info(f"Starting simple wallet funding process")
    logger.info(f"Amount: {amount} SOL")
    logger.info(f"Token type: {token_type}")
    
    # Check if Solana CLI is available
    try:
        # Try to find solana executable
        solana_path = "C:\\Users\\hmmm\\Downloads\\solana-release-x86_64-pc-windows-msvc\\solana-release\\bin\\solana.exe"
        for path in ["C:\\Users\\hmmm\\Downloads\\solana-release-x86_64-pc-windows-msvc\\solana-release\\bin\\solana.exe",]:
            try:
                result = subprocess.run([path, "version"], capture_output=True, text=True, timeout=10)
                if result.returncode == 0:
                    solana_path = path
                    break
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        
        if not solana_path:
            logger.error("Solana CLI not found")
            logger.error("Please install Solana CLI: https://docs.solana.com/cli/install-solana-cli")
            logger.error("Or add Solana to your PATH environment variable")
            sys.exit(1)
        
        logger.info(f"Solana CLI found at: {solana_path}")
        
        # Test airdrop command
        test_result = subprocess.run([solana_path, "airdrop", "0.1", "11111111111111111111111111111112", "--url", "https://api.devnet.solana.com"], 
                                   capture_output=True, text=True, timeout=30)
        if test_result.returncode != 0:
            logger.warning(f"Solana airdrop test failed: {test_result.stderr.strip()}")
            logger.warning("This might be due to faucet limits or network issues")
        else:
            logger.info("Solana CLI airdrop command works correctly")
            
    except Exception as e:
        logger.error(f"Error checking Solana CLI: {e}")
        logger.error("Please install Solana CLI: https://docs.solana.com/cli/install-solana-cli")
        sys.exit(1)
    
    try:
        # Get all users with wallets
        async with AsyncSession(engine) as db:
            users = await get_all_users_with_wallets(db)
            logger.info(f"Found {len(users)} users with wallets")
            
            if not users:
                logger.warning("No users with wallets found in database")
                return
            
            # Airdrop to each user
            success_count = 0
            for user in users:
                try:
                    success = await airdrop_to_wallet(user.wallet_public_key, amount)
                    if success:
                        success_count += 1
                    await asyncio.sleep(1)  # Rate limiting
                except Exception as e:
                    logger.error(f"Error processing user {user.id}: {e}")
                    continue
            
            logger.info(f"Funding completed: {success_count}/{len(users)} wallets funded successfully")
            
    except Exception as e:
        logger.error(f"Error during funding process: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())