using System.Collections.Generic;
using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class TransitionPolicyTests
    {
        private const int Draft = ContractStatus.Draft;
        private const int Pending = ContractStatus.PendingApproval;
        private const int InForce = ContractStatus.InForce;
        private const int Rejected = ContractStatus.Rejected;

        // all 16 pairs (4x4 including same status)
        public static IEnumerable<object[]> AllPairs()
        {
            var allowed = new HashSet<string>
            {
                Draft + ">" + Pending,
                Pending + ">" + Draft, Pending + ">" + InForce, Pending + ">" + Rejected,
                Rejected + ">" + Draft,
            };
            foreach (var from in GuardTestData.Statuses)
            {
                foreach (var to in GuardTestData.Statuses)
                {
                    yield return new object[] { from, to, from == to || allowed.Contains(from + ">" + to) };
                }
            }
        }

        [Theory]
        [MemberData(nameof(AllPairs))]
        public void Status_pair_is_decided_by_the_table(int from, int to, bool expectedAllowed)
        {
            Assert.Equal(expectedAllowed, TransitionPolicy.Check(from, to).Allowed);
        }

        [Fact]
        public void There_are_16_pairs_and_9_are_allowed()
        {
            var all = new List<object[]>(AllPairs());
            Assert.Equal(16, all.Count);
            Assert.Equal(9, all.FindAll(p => (bool)p[2]).Count); // 4 same-status + 5 transitions
        }

        [Theory]
        [InlineData(Draft, Pending)]
        [InlineData(Pending, Draft)]
        [InlineData(Pending, InForce)]
        [InlineData(Pending, Rejected)]
        [InlineData(Rejected, Draft)]
        public void Allowed_transition_has_no_message(int from, int to)
        {
            var r = TransitionPolicy.Check(from, to);
            Assert.True(r.Allowed);
            Assert.Null(r.Message);
        }

        [Fact]
        public void Denied_transition_names_the_from_and_to_status()
        {
            var r = TransitionPolicy.Check(Draft, InForce);
            Assert.False(r.Allowed);
            Assert.StartsWith("Cannot change the contract status from Draft to In Force.", r.Message);
            Assert.Contains("Allowed next status: Pending Approval.", r.Message);
        }

        [Fact]
        public void In_force_is_final_and_the_message_says_so()
        {
            var r = TransitionPolicy.Check(InForce, Draft);
            Assert.False(r.Allowed);
            Assert.Contains("In Force is final.", r.Message);
        }

        [Fact]
        public void Unknown_status_is_denied_in_both_directions()
        {
            Assert.False(TransitionPolicy.Check(999, Draft).Allowed);
            Assert.False(TransitionPolicy.Check(Draft, 999).Allowed);
            Assert.False(TransitionPolicy.Check(Draft, ContractStatus.Unknown).Allowed);
        }

        // ---- Create ----
        [Theory]
        [InlineData(null, true)]
        [InlineData(Draft, true)]
        [InlineData(Pending, false)]      // changed 2026-10-22 (ADR-004): was true
        [InlineData(InForce, false)]
        [InlineData(Rejected, false)]
        [InlineData(0, false)]
        [InlineData(-1, false)]
        [InlineData(867640099, false)]
        public void Create_status_rules(int? status, bool expectedAllowed)
        {
            Assert.Equal(expectedAllowed, TransitionPolicy.CheckCreate(status).Allowed);
        }

        [Fact]
        public void Create_denied_message_names_the_status()
        {
            Assert.Contains("Cannot create a contract with status In Force.", TransitionPolicy.CheckCreate(InForce).Message);
        }

        [Theory]
        [InlineData(Pending)]
        [InlineData(InForce)]
        [InlineData(Rejected)]
        public void Create_denied_message_tells_the_user_what_to_do(int status)
        {
            Assert.EndsWith("A contract must be created as Draft; submit it for approval afterwards.", TransitionPolicy.CheckCreate(status).Message);
        }

        [Fact]
        public void Create_pending_message_names_pending_approval()
        {
            Assert.Equal("Cannot create a contract with status Pending Approval. A contract must be created as Draft; submit it for approval afterwards.",
                TransitionPolicy.CheckCreate(Pending).Message);
        }
    }
}
