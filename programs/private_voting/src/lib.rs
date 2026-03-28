use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

const COMP_DEF_OFFSET_INIT_TALLIES: u32 = comp_def_offset("init_tallies");
const COMP_DEF_OFFSET_VOTE: u32 = comp_def_offset("vote");
const COMP_DEF_OFFSET_REVEAL_RESULT: u32 = comp_def_offset("reveal_result");

/// Byte offset of vote_state within PollAccount (after discriminator).
/// vote_state is placed FIRST after bump so the offset is fixed
/// regardless of variable-length String fields that follow.
/// 8 (discriminator) + 1 (bump) = 9
const VOTE_STATE_OFFSET: u32 = 9;
const VOTE_STATE_SIZE: u32 = 32 * 5; // 5 encrypted u64 tallies

declare_id!("HumFumqkg2zvc1pyXymGtJ7b2GY3RhxbYy7TEJtWdmA5");

#[arcium_program]
pub mod private_voting {
    use super::*;

    // ── Comp Def Inits ──────────────────────────────────────────────

    pub fn init_tallies_comp_def(ctx: Context<InitTalliesCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_vote_comp_def(ctx: Context<InitVoteCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_reveal_result_comp_def(ctx: Context<InitRevealResultCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    // ── Create Poll ─────────────────────────────────────────────────

    pub fn create_poll(
        ctx: Context<CreatePoll>,
        computation_offset: u64,
        id: u64,
        question: String,
        options: Vec<String>,
        deadline: i64,
    ) -> Result<()> {
        let num_options = options.len() as u8;
        require!(num_options >= 2 && num_options <= 5, ErrorCode::InvalidNumOptions);

        let clock = Clock::get()?;
        require!(deadline > clock.unix_timestamp, ErrorCode::DeadlineInPast);

        let poll = &mut ctx.accounts.poll_acc;
        poll.bump = ctx.bumps.poll_acc;
        // vote_state and nonce are set by the init_tallies callback
        poll.vote_state = [[0u8; 32]; 5];
        poll.nonce = 0;
        poll.id = id;
        poll.creator = ctx.accounts.payer.key();
        poll.question = question;
        poll.num_options = num_options;
        poll.options = options;
        poll.status = PollStatus::Open;
        poll.vote_count = 0;
        poll.created_at = clock.unix_timestamp;
        poll.deadline = deadline;
        poll.results = [0u64; 5];

        // Queue MPC computation to initialize encrypted tallies
        let args = ArgBuilder::new().build();
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![InitTalliesCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.poll_acc.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_tallies")]
    pub fn init_tallies_callback(
        ctx: Context<InitTalliesCallback>,
        output: SignedComputationOutputs<InitTalliesOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitTalliesOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.poll_acc.vote_state = o.ciphertexts;
        ctx.accounts.poll_acc.nonce = o.nonce;

        emit!(PollCreatedEvent {
            poll: ctx.accounts.poll_acc.key(),
            creator: ctx.accounts.poll_acc.creator,
            id: ctx.accounts.poll_acc.id,
        });

        Ok(())
    }

    // ── Cast Vote ───────────────────────────────────────────────────

    pub fn cast_vote(
        ctx: Context<CastVote>,
        computation_offset: u64,
        _id: u64,
        encrypted_choice: [u8; 32],
        voter_pubkey: [u8; 32],
        voter_nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.poll_acc.status == PollStatus::Open,
            ErrorCode::PollNotOpen
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < ctx.accounts.poll_acc.deadline,
            ErrorCode::PollDeadlinePassed
        );

        // Build args: encrypted vote + MXE-owned tally state + num_options plaintext
        let args = ArgBuilder::new()
            // vote_ctxt: Enc<Shared, UserVote>
            .x25519_pubkey(voter_pubkey)
            .plaintext_u128(voter_nonce)
            .encrypted_u8(encrypted_choice)
            // tallies_ctxt: Enc<Mxe, Tallies> — read from onchain account
            .plaintext_u128(ctx.accounts.poll_acc.nonce)
            .account(
                ctx.accounts.poll_acc.key(),
                VOTE_STATE_OFFSET,
                VOTE_STATE_SIZE,
            )
            // num_options: u8 plaintext
            .plaintext_u8(ctx.accounts.poll_acc.num_options)
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Create vote receipt PDA (double-vote prevention)
        ctx.accounts.vote_receipt.poll_id = ctx.accounts.poll_acc.id;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![VoteCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.poll_acc.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        // Increment public vote count
        ctx.accounts.poll_acc.vote_count += 1;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "vote")]
    pub fn vote_callback(
        ctx: Context<VoteCallback>,
        output: SignedComputationOutputs<VoteOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(VoteOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.poll_acc.vote_state = o.ciphertexts;
        ctx.accounts.poll_acc.nonce = o.nonce;

        emit!(VoteCastEvent {
            poll: ctx.accounts.poll_acc.key(),
        });

        Ok(())
    }

    // ── Close Poll ──────────────────────────────────────────────────

    /// Anyone can close a poll after its deadline has passed.
    /// The creator can close it early at any time.
    pub fn close_poll(ctx: Context<ClosePoll>, _id: u64) -> Result<()> {
        require!(
            ctx.accounts.poll_acc.status == PollStatus::Open,
            ErrorCode::PollNotOpen
        );

        let clock = Clock::get()?;
        let is_creator = ctx.accounts.payer.key() == ctx.accounts.poll_acc.creator;
        let past_deadline = clock.unix_timestamp >= ctx.accounts.poll_acc.deadline;

        require!(
            is_creator || past_deadline,
            ErrorCode::NotAuthorized
        );

        ctx.accounts.poll_acc.status = PollStatus::Closed;

        emit!(PollClosedEvent {
            poll: ctx.accounts.poll_acc.key(),
            vote_count: ctx.accounts.poll_acc.vote_count,
        });

        Ok(())
    }

    // ── Reveal Result ───────────────────────────────────────────────

    pub fn reveal_result(
        ctx: Context<RevealResult>,
        computation_offset: u64,
        _id: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.poll_acc.creator,
            ErrorCode::NotAuthorized
        );
        require!(
            ctx.accounts.poll_acc.status == PollStatus::Closed,
            ErrorCode::PollNotClosed
        );

        let args = ArgBuilder::new()
            .plaintext_u128(ctx.accounts.poll_acc.nonce)
            .account(
                ctx.accounts.poll_acc.key(),
                VOTE_STATE_OFFSET,
                VOTE_STATE_SIZE,
            )
            .build();

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealResultCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.poll_acc.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_result")]
    pub fn reveal_result_callback(
        ctx: Context<RevealResultCallback>,
        output: SignedComputationOutputs<RevealResultOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealResultOutput {
                field_0:
                    RevealResultOutputStruct0 {
                        field_0: o0,
                        field_1: o1,
                        field_2: o2,
                        field_3: o3,
                        field_4: o4,
                    },
            }) => (o0, o1, o2, o3, o4),
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let poll = &mut ctx.accounts.poll_acc;
        poll.results = [o.0, o.1, o.2, o.3, o.4];
        poll.status = PollStatus::Revealed;

        emit!(PollRevealedEvent {
            poll: poll.key(),
            results: poll.results,
            vote_count: poll.vote_count,
        });

        Ok(())
    }
}

// ══════════════════════════════════════════════════════════════════════
// Account Structs
// ══════════════════════════════════════════════════════════════════════

// ── Create Poll Accounts ────────────────────────────────────────────

#[queue_computation_accounts("init_tallies", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, id: u64)]
pub struct CreatePoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account, checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_TALLIES))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        init,
        payer = payer,
        space = 8 + PollAccount::INIT_SPACE,
        seeds = [b"poll", payer.key().as_ref(), id.to_le_bytes().as_ref()],
        bump,
    )]
    pub poll_acc: Box<Account<'info, PollAccount>>,
}

#[callback_accounts("init_tallies")]
#[derive(Accounts)]
pub struct InitTalliesCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_TALLIES))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub poll_acc: Account<'info, PollAccount>,
}

#[init_computation_definition_accounts("init_tallies", payer)]
#[derive(Accounts)]
pub struct InitTalliesCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── Cast Vote Accounts ──────────────────────────────────────────────

#[queue_computation_accounts("vote", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _id: u64)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account, checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOTE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"poll", poll_acc.creator.as_ref(), _id.to_le_bytes().as_ref()],
        bump = poll_acc.bump,
    )]
    pub poll_acc: Box<Account<'info, PollAccount>>,
    #[account(
        init,
        payer = payer,
        space = 8 + VoteReceipt::INIT_SPACE,
        seeds = [b"receipt", _id.to_le_bytes().as_ref(), payer.key().as_ref()],
        bump,
    )]
    pub vote_receipt: Account<'info, VoteReceipt>,
}

#[callback_accounts("vote")]
#[derive(Accounts)]
pub struct VoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_VOTE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub poll_acc: Account<'info, PollAccount>,
}

#[init_computation_definition_accounts("vote", payer)]
#[derive(Accounts)]
pub struct InitVoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ── Close Poll Accounts ─────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(_id: u64)]
pub struct ClosePoll<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"poll", poll_acc.creator.as_ref(), _id.to_le_bytes().as_ref()],
        bump = poll_acc.bump,
    )]
    pub poll_acc: Account<'info, PollAccount>,
}

// ── Reveal Result Accounts ──────────────────────────────────────────

#[queue_computation_accounts("reveal_result", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, _id: u64)]
pub struct RevealResult<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account, checked by the arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool, checked by the arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account, checked by the arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_RESULT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"poll", poll_acc.creator.as_ref(), _id.to_le_bytes().as_ref()],
        bump = poll_acc.bump,
    )]
    pub poll_acc: Box<Account<'info, PollAccount>>,
}

#[callback_accounts("reveal_result")]
#[derive(Accounts)]
pub struct RevealResultCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_RESULT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account, checked by arcium program via constraints in the callback context.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub poll_acc: Account<'info, PollAccount>,
}

#[init_computation_definition_accounts("reveal_result", payer)]
#[derive(Accounts)]
pub struct InitRevealResultCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ══════════════════════════════════════════════════════════════════════
// Data Accounts
// ══════════════════════════════════════════════════════════════════════

#[account]
#[derive(InitSpace)]
pub struct PollAccount {
    pub bump: u8,
    // vote_state and nonce MUST be first after bump — ArgBuilder .account()
    // reads raw bytes at a fixed offset (9) that must not shift.
    pub vote_state: [[u8; 32]; 5],
    pub nonce: u128,
    pub id: u64,
    pub creator: Pubkey,
    #[max_len(200)]
    pub question: String,
    pub num_options: u8,
    #[max_len(5, 50)]
    pub options: Vec<String>,
    pub status: PollStatus,
    pub vote_count: u64,
    pub created_at: i64,
    pub deadline: i64,
    pub results: [u64; 5],
}

#[account]
#[derive(InitSpace)]
pub struct VoteReceipt {
    pub poll_id: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PollStatus {
    Open,
    Closed,
    Revealed,
}

// ══════════════════════════════════════════════════════════════════════
// Events
// ══════════════════════════════════════════════════════════════════════

#[event]
pub struct PollCreatedEvent {
    pub poll: Pubkey,
    pub creator: Pubkey,
    pub id: u64,
}

#[event]
pub struct VoteCastEvent {
    pub poll: Pubkey,
}

#[event]
pub struct PollClosedEvent {
    pub poll: Pubkey,
    pub vote_count: u64,
}

#[event]
pub struct PollRevealedEvent {
    pub poll: Pubkey,
    pub results: [u64; 5],
    pub vote_count: u64,
}

// ══════════════════════════════════════════════════════════════════════
// Errors
// ══════════════════════════════════════════════════════════════════════

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Number of options must be between 2 and 5")]
    InvalidNumOptions,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Poll is not open for voting")]
    PollNotOpen,
    #[msg("Poll voting deadline has passed")]
    PollDeadlinePassed,
    #[msg("Not authorized to perform this action")]
    NotAuthorized,
    #[msg("Poll must be closed before revealing")]
    PollNotClosed,
}
