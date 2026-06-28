use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("C54m6YWGur2pW7urDWqdU7Em1vrjzCw2tiYFKZHGKpjw");

#[program]
pub mod gigr_escrow {
    use super::*;

    pub fn init_escrow(ctx: Context<InitEscrow>, job_id: u64, amount: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.provider = ctx.accounts.provider.key();
        escrow.job_id = job_id;
        escrow.amount = amount;
        escrow.bump = ctx.bumps.escrow;

        let cpi_accounts = Transfer {
            from: ctx.accounts.client_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn release_escrow(ctx: Context<ReleaseEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;

        let job_id_bytes = escrow.job_id.to_le_bytes();
        let seeds = &[
            b"escrow",
            escrow.client.as_ref(),
            job_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        // 1. Transfer USDC from vault to provider
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.provider_ata.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program.clone(), cpi_accounts, signer);
        token::transfer(cpi_ctx, escrow.amount)?;

        // 2. Close vault token account → refund rent to PLATFORM
        let close_accounts = CloseAccount {
            account: ctx.accounts.vault_ata.to_account_info(),
            destination: ctx.accounts.platform.to_account_info(), // platform gets rent back
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(cpi_program.clone(), close_accounts, signer);
        token::close_account(close_ctx)?;

        // 3. Close the escrow PDA and send its lamports to the platform
        let escrow_lamports = ctx.accounts.escrow.to_account_info().lamports();
        **ctx
            .accounts
            .escrow
            .to_account_info()
            .try_borrow_mut_lamports()? -= escrow_lamports;
        **ctx
            .accounts
            .platform
            .to_account_info()
            .try_borrow_mut_lamports()? += escrow_lamports;

        Ok(())
    }

    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;

        let job_id_bytes = escrow.job_id.to_le_bytes();
        let seeds = &[
            b"escrow",
            escrow.client.as_ref(),
            job_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&seeds[..]];

        // 1. Return USDC to client
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.client_ata.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program.clone(), cpi_accounts, signer);
        token::transfer(cpi_ctx, escrow.amount)?;

        // 2. Close vault token account → refund rent to PLATFORM
        let close_accounts = CloseAccount {
            account: ctx.accounts.vault_ata.to_account_info(),
            destination: ctx.accounts.platform.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(cpi_program.clone(), close_accounts, signer);
        token::close_account(close_ctx)?;

        // 3. Close the escrow PDA and send its lamports to the platform
        let escrow_lamports = ctx.accounts.escrow.to_account_info().lamports();
        **ctx
            .accounts
            .escrow
            .to_account_info()
            .try_borrow_mut_lamports()? -= escrow_lamports;
        **ctx
            .accounts
            .platform
            .to_account_info()
            .try_borrow_mut_lamports()? += escrow_lamports;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct InitEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(mut)]
    pub platform: Signer<'info>, // pays rent for vault_ata + escrow
    /// CHECK: Safe
    pub provider: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub client_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = platform,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = platform,
        space = 8 + 32 + 32 + 8 + 8 + 1,
        seeds = [b"escrow", client.key().as_ref(), &job_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    pub client: Signer<'info>,
    /// CHECK: Platform receives rent refunds, must be writable
    #[account(mut)]
    pub platform: AccountInfo<'info>,
    #[account(mut)]
    pub provider_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        has_one = client @ CustomError::UnauthorizedClient,
        close = platform   // Anchor will send the escrow's rent to the platform
    )]
    pub escrow: Account<'info, Escrow>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    pub client: Signer<'info>,
    /// CHECK: Platform receives rent refunds, must be writable
    #[account(mut)]
    pub platform: AccountInfo<'info>,
    #[account(mut)]
    pub client_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        has_one = client @ CustomError::UnauthorizedClient,
        close = platform   // Anchor will send the escrow's rent to the platform
    )]
    pub escrow: Account<'info, Escrow>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Escrow {
    pub client: Pubkey,
    pub provider: Pubkey,
    pub job_id: u64,
    pub amount: u64,
    pub bump: u8,
}

#[error_code]
pub enum CustomError {
    #[msg("Unauthorized: You are not the client.")]
    UnauthorizedClient,
}
