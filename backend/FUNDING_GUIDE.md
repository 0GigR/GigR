# Wallet Funding Guide

This document explains how to fund user wallets in the Gigr platform using Solana devnet.

## Overview

The Gigr platform stores Solana keypairs for each user in the database (encrypted). This guide provides scripts to fund all user wallets with SOL or USDC tokens on Solana devnet.

## Requirements

1. **Python 3.7+** with the following packages:
   - solana
   - solders
   - anchorpy3
   - sqlalchemy
   - asyncpg
   - fastapi
   - uvicorn
   - cryptography
   - python-dotenv

2. **Solana Devnet RPC URL** (configured in `.env` file)
3. **Platform Keypair** (configured in `.env` file)
4. **Wallet Encryption Key** (configured in `.env` file)
5. **Database connection** (configured in `.env` file)

## Environment Setup

### 1. Install Python Packages

```bash
pip install -r requirements.txt
```

### 2. Configure Environment Variables

Create or update a `.env` file in the backend directory with the following variables:

```env
# Database
DATABASE_URL=postgresql://username:password@localhost:5432/gigr

# Solana
BAROS_PROGRAM_ID=H3ETmNRWqkfFZmiZio2KsKpuntZ1X3awUwY8QUiGVAqA
SOLANA_RPC_URL=https://api.devnet.solana.com
PLATFORM_KEYPAIR=["your","platform","keypair","as","JSON","array"]
WALLET_ENCRYPTION_KEY=your_encryption_key_here
USDC_MINT_DEVNET=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU

# Other required variables...
```

## Funding Scripts

### Python Script (`fund_wallets.py`)

The primary funding script that can be run directly:

```bash
python fund_wallets.py [amount] [token_type]
```

**Parameters:**
- `amount`: Amount to fund each wallet (default: 1.0)
- `token_type`: "sol" for SOL, "usdc" for USDC (default: sol)

**Example:**
```bash
python fund_wallets.py 0.5 usdc
```

### PowerShell Script (`fund_all_wallets.ps1`)

A PowerShell wrapper script for Windows users:

```powershell
.
fund_all_wallets.ps1 [amount] [token_type]
```

**Example:**
```powershell
.
fund_all_wallets.ps1 1.0 sol
```

### Batch Script (`fund_all_wallets.bat`)

A batch file wrapper for Windows users:

```cmd
fund_all_wallets.bat [amount] [token_type]
```

**Example:**
```cmd
fund_all_wallets.bat 0.5 usdc
```

## How the Funding Process Works

1. **Database Connection**: The script connects to the PostgreSQL database
2. **User Retrieval**: It fetches all users with wallet_public_key set
3. **Wallet Funding**: For each user:
   - Decrypts the user's private key from the database
   - Creates an associated token account (for USDC) if needed
   - Transfers the specified amount from the platform wallet to the user's wallet
4. **Logging**: All operations are logged for tracking and debugging

## Security Considerations

- The platform keypair is used to fund user wallets
- All private keys are encrypted in the database using Fernet encryption
- The script should only be run in a development/devnet environment
- Never expose your `.env` file or platform keypair in production

## Troubleshooting

### Common Issues

1. **Database Connection Errors**: Ensure your DATABASE_URL is correct and the database is running
2. **Solana RPC Errors**: Check your SOLANA_RPC_URL and ensure devnet is accessible
3. **Missing Packages**: Install all required packages from requirements.txt
4. **Permission Errors**: Ensure the platform keypair has sufficient SOL for funding

### Debug Mode

To run with more verbose logging:

```bash
python fund_wallets.py 1.0 sol
```

## Testing

Before running on main devnet, consider:

1. **Test with small amounts**: Start with 0.1 SOL or USDC
2. **Check balances**: Use the `check_balance.py` script to verify funding
3. **Monitor transactions**: Check Solana explorer for transaction details

## Alternative: Manual Funding

If you need to fund specific wallets:

1. Use the `check_balance.py` script to verify current balances
2. Use the `verify_pda.py` script to verify PDA derivations
3. Fund wallets manually using Solana CLI or wallet applications

## Cleanup

After funding, you may want to:

1. **Wipe the database** (use `wipe_db.py` - USE WITH CAUTION):
   ```bash
   python wipe_db.py
   ```

2. **Restart the backend** to recreate tables

## Support

For issues with wallet funding:
1. Check the logs in the terminal
2. Verify your environment variables
3. Ensure all required packages are installed
4. Check Solana devnet status at https://solscan.io/?network=devnet