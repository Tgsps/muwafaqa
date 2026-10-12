using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class DeletePolicyTests
    {
        [Theory]
        [InlineData(ContractStatus.Draft, true)]
        [InlineData(ContractStatus.Rejected, true)]
        [InlineData(ContractStatus.PendingApproval, false)]
        [InlineData(ContractStatus.InForce, false)]
        [InlineData(999, false)]
        public void Delete_by_status(int status, bool expectedAllowed)
        {
            Assert.Equal(expectedAllowed, DeletePolicy.Check(status).Allowed);
            Assert.Equal(expectedAllowed, GuardEvaluator.EvaluateDelete(status).Allowed);
        }

        [Fact]
        public void Delete_message_names_the_status()
        {
            Assert.Equal("Cannot delete a contract whose status is Pending Approval.",
                DeletePolicy.Check(ContractStatus.PendingApproval).Message);
            Assert.Equal("Cannot delete a contract whose status is In Force.",
                DeletePolicy.Check(ContractStatus.InForce).Message);
        }
    }
}
