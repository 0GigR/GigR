import asyncio
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TokenAccountOpts
from solders.pubkey import Pubkey

async def main():
    async with AsyncClient('https://api.devnet.solana.com') as client:
        pubkey = Pubkey.from_string('C9Q65fcfaPi3s9MdjXDHwegYgUreKvB39Zc4w4KyxM1Q')
        
        # Check SOL
        sol_resp = await client.get_balance(pubkey)
        print(f"SOL Balance: {sol_resp.value / 1e9}")

        # Check USDC
        resp = await client.get_token_accounts_by_owner_json_parsed(
            pubkey, 
            TokenAccountOpts(program_id=Pubkey.from_string('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'))
        )
        accounts = resp.value
        if accounts:
            for acct in accounts:
                info = acct.account.data.parsed['info']
                print(f"Mint: {info['mint']}, Balance: {info['tokenAmount']['uiAmount']}, ATA: {acct.pubkey}")
        else:
            print("No token accounts found.")

asyncio.run(main())
