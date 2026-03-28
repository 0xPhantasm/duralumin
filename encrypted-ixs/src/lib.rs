use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Encrypted tally counters for up to 5 options.
    pub struct Tallies {
        o0: u64,
        o1: u64,
        o2: u64,
        o3: u64,
        o4: u64,
    }

    /// A single encrypted vote: the chosen option index (0-4).
    pub struct UserVote {
        choice: u8,
    }

    /// Initializes encrypted tally counters for a new poll.
    /// All five counters start at zero; unused options stay zero.
    #[instruction]
    pub fn init_tallies() -> Enc<Mxe, Tallies> {
        let tallies = Tallies {
            o0: 0,
            o1: 0,
            o2: 0,
            o3: 0,
            o4: 0,
        };
        Mxe::get().from_arcis(tallies)
    }

    /// Processes an encrypted vote and updates the running tallies.
    /// `num_options` is plaintext (2-5) so the circuit knows which slots are valid.
    /// If the vote choice >= num_options, all comparisons fail and no tally is incremented.
    #[instruction]
    pub fn vote(
        vote_ctxt: Enc<Shared, UserVote>,
        tallies_ctxt: Enc<Mxe, Tallies>,
        num_options: u8,
    ) -> Enc<Mxe, Tallies> {
        let user_vote = vote_ctxt.to_arcis();
        let mut tallies = tallies_ctxt.to_arcis();

        let choice = user_vote.choice;

        // Each comparison produces 1 if the vote matches that option, 0 otherwise.
        // Unused options (>= num_options) will never match a valid vote.
        if choice == 0u8 {
            tallies.o0 += 1;
        } else {
            tallies.o0 += 0;
        }

        if choice == 1u8 {
            tallies.o1 += 1;
        } else {
            tallies.o1 += 0;
        }

        if num_options > 2u8 {
            if choice == 2u8 {
                tallies.o2 += 1;
            } else {
                tallies.o2 += 0;
            }
        } else {
            tallies.o2 += 0;
        }

        if num_options > 3u8 {
            if choice == 3u8 {
                tallies.o3 += 1;
            } else {
                tallies.o3 += 0;
            }
        } else {
            tallies.o3 += 0;
        }

        if num_options > 4u8 {
            if choice == 4u8 {
                tallies.o4 += 1;
            } else {
                tallies.o4 += 0;
            }
        } else {
            tallies.o4 += 0;
        }

        tallies_ctxt.owner.from_arcis(tallies)
    }

    /// Reveals the raw tally counts for all 5 option slots.
    /// Frontend computes percentages and total from these values.
    #[instruction]
    pub fn reveal_result(tallies_ctxt: Enc<Mxe, Tallies>) -> (u64, u64, u64, u64, u64) {
        let tallies = tallies_ctxt.to_arcis();
        (
            tallies.o0.reveal(),
            tallies.o1.reveal(),
            tallies.o2.reveal(),
            tallies.o3.reveal(),
            tallies.o4.reveal(),
        )
    }
}
