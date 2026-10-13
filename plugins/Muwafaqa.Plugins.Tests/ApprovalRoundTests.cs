using System;
using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class ApprovalRoundTests
    {
        [Theory]
        [InlineData(null, 1)]       // never submitted (a Whole Number column has no default, so the row holds null)
        [InlineData(0, 1)]
        [InlineData(1, 2)]
        [InlineData(2, 3)]
        [InlineData(41, 42)]
        public void Next_is_current_or_zero_plus_one(int? current, int expected)
        {
            Assert.Equal(expected, ApprovalRound.Next(current));
        }

        [Fact]
        public void A_negative_stored_value_is_treated_as_zero()
        {
            Assert.Equal(1, ApprovalRound.Next(-5));
        }

        [Fact]
        public void The_maximum_value_overflows_loudly_instead_of_wrapping()
        {
            Assert.Throws<OverflowException>(() => ApprovalRound.Next(int.MaxValue));
        }

        [Fact]
        public void Round_follows_the_same_condition_as_the_frozen_value()
        {
            // Plug-in 1 sets the round exactly when SubmissionDetector says the contract enters Pending Approval.
            Assert.True(SubmissionDetector.EntersPendingApproval("Update", SubmissionDetector.PendingApproval, ContractStatus.Draft));
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", SubmissionDetector.PendingApproval, SubmissionDetector.PendingApproval));
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", ContractStatus.InForce, SubmissionDetector.PendingApproval));
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", null, ContractStatus.Draft));
        }
    }
}
