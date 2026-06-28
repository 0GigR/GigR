from solders.pubkey import Pubkey

client = Pubkey.from_string("HXsMabDEnppZXjhzqBUDYa1KDpxNMP9Rp8KV4CyvRr79")
contract_job_id = "0xbecbcb37dbabfcd9"
program_id = Pubkey.from_string("H3ETmNRWqkfFZmiZio2KsKpuntZ1X3awUwY8QUiGVAqA")
EXPECTED_ESCROW = "E7BkSTboJGwoiAZPejc6wSnuUmy6QAt9M26SUQsiiCNo"

job_id_int = int(contract_job_id, 16)
escrow_pda = Pubkey.find_program_address(
    [b"escrow", bytes(client), job_id_int.to_bytes(8, "little")],
    program_id
)[0]

vault_ata = Pubkey.find_program_address(
    [b"vault", bytes(escrow_pda)],
    program_id
)[0]

print(f"Derived escrow PDA : {escrow_pda}")
print(f"Expected escrow    : {EXPECTED_ESCROW}")
print(f"PDAs match         : {str(escrow_pda) == EXPECTED_ESCROW}")
print(f"Derived vault_ata  : {vault_ata}")

# Also check provider ATA
from spl.token.instructions import get_associated_token_address
provider = Pubkey.from_string("DDqJvZWjy2ykWiyzHESv5Axa1smCyZgRepAPs11nM4dL")
mint = Pubkey.from_string("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
provider_ata = get_associated_token_address(provider, mint)
print(f"Provider ATA       : {provider_ata}")
