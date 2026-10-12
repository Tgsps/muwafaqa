using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class SubmissionDetectorTests
    {
        private const int Pending = SubmissionDetector.PendingApproval;
        private const int Draft = 1;
        private const int Rejected = 2;
        private const int InForce = 867640001;

        [Fact]
        public void Create_as_pending_approval_is_an_entry()
        {
            Assert.True(SubmissionDetector.EntersPendingApproval("Create", Pending, null));
        }

        [Fact]
        public void Create_as_draft_is_not_an_entry()
        {
            Assert.False(SubmissionDetector.EntersPendingApproval("Create", Draft, null));
        }

        [Fact]
        public void Create_without_status_in_target_is_not_an_entry()
        {
            Assert.False(SubmissionDetector.EntersPendingApproval("Create", null, null));
        }

        [Theory]
        [InlineData(Draft)]
        [InlineData(Rejected)]
        [InlineData(InForce)]
        public void Update_to_pending_from_another_status_is_an_entry(int before)
        {
            Assert.True(SubmissionDetector.EntersPendingApproval("Update", Pending, before));
        }

        [Fact]
        public void Update_pending_to_pending_is_not_an_entry()
        {
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", Pending, Pending));
        }

        [Fact]
        public void Update_without_status_in_target_is_not_an_entry()
        {
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", null, Pending));
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", null, Draft));
        }

        [Theory]
        [InlineData(Draft)]
        [InlineData(InForce)]
        public void Update_away_from_pending_is_not_an_entry(int after)
        {
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", after, Pending));
        }

        [Fact]
        public void Reentry_pending_to_draft_to_pending_counts_each_entry()
        {
            Assert.True(SubmissionDetector.EntersPendingApproval("Update", Pending, Draft));
            Assert.False(SubmissionDetector.EntersPendingApproval("Update", Draft, Pending));
            Assert.True(SubmissionDetector.EntersPendingApproval("Update", Pending, Draft));
        }

        [Fact]
        public void Other_messages_are_ignored()
        {
            Assert.False(SubmissionDetector.EntersPendingApproval("Delete", Pending, Draft));
        }
    }
}
