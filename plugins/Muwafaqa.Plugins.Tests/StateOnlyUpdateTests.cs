using Muwafaqa.Plugins.Contract;
using Xunit;
using static Muwafaqa.Plugins.Tests.GuardTestData;

namespace Muwafaqa.Plugins.Tests
{
    /// <summary>
    /// A request that carries statecode but no statuscode means the DEFAULT status of that state
    /// (state 0 = Draft, state 1 = Rejected). Decision approved for ADR-004.
    /// </summary>
    public class StateOnlyUpdateTests
    {
        [Fact]
        public void In_force_with_statecode_1_is_rejected()
        {
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.InForce, null, 1, Row(), Row());
            Assert.False(r.Allowed);
            Assert.Contains("from In Force to Rejected", r.Message);
        }

        [Fact]
        public void In_force_with_statecode_0_is_rejected_because_it_means_Draft()
        {
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.InForce, null, 0, Row(), Row());
            Assert.False(r.Allowed);
            Assert.Contains("from In Force to Draft", r.Message);
        }

        [Fact]
        public void Rejected_with_statecode_0_Activate_is_allowed()
        {
            Assert.True(GuardEvaluator.EvaluateUpdate(ContractStatus.Rejected, null, 0, Row(), Row()).Allowed);
        }

        [Fact]
        public void Pending_with_statecode_0_is_evaluated_as_Pending_to_Draft_and_allowed()
        {
            Assert.True(GuardEvaluator.EvaluateUpdate(ContractStatus.PendingApproval, null, 0, Row(), Row()).Allowed);
        }

        [Fact]
        public void Pending_with_statecode_0_and_a_changed_Value_is_rejected_by_the_locked_column()
        {
            var v = TwoValues(ContractColumns.Value);
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.PendingApproval, null, 0,
                Row(Col(ContractColumns.Value, v.Item2)), Row(Col(ContractColumns.Value, v.Item1)));
            Assert.False(r.Allowed);
            Assert.Contains("Cannot change Value", r.Message);
        }

        [Fact]
        public void Draft_with_statecode_1_is_rejected_because_it_means_Rejected()
        {
            Assert.False(GuardEvaluator.EvaluateUpdate(ContractStatus.Draft, null, 1, Row(), Row()).Allowed);
        }

        [Fact]
        public void Pending_with_statecode_1_is_allowed_as_Pending_to_Rejected()
        {
            Assert.True(GuardEvaluator.EvaluateUpdate(ContractStatus.PendingApproval, null, 1, Row(), Row()).Allowed);
        }

        [Fact]
        public void An_unknown_state_is_rejected()
        {
            Assert.False(GuardEvaluator.EvaluateUpdate(ContractStatus.Draft, null, 7, Row(), Row()).Allowed);
        }

        [Fact]
        public void A_status_in_the_request_wins_over_the_state()
        {
            // Pending (state 0) -> Rejected: status 2 with state 1 sent together
            Assert.True(GuardEvaluator.EvaluateUpdate(
                ContractStatus.PendingApproval, ContractStatus.Rejected, 1, Row(), Row()).Allowed);
            Assert.Equal(ContractStatus.Rejected, ContractStatus.ResolveRequested(ContractStatus.Rejected, 0));
        }

        [Theory]
        [InlineData(0, ContractStatus.Draft)]
        [InlineData(1, ContractStatus.Rejected)]
        [InlineData(7, ContractStatus.Unknown)]
        public void State_alone_resolves_to_the_default_status(int state, int expected)
        {
            Assert.Equal(expected, ContractStatus.ResolveRequested(null, state));
        }

        [Fact]
        public void Neither_status_nor_state_is_no_request()
        {
            Assert.Null(ContractStatus.ResolveRequested(null, null));
            Assert.True(GuardEvaluator.EvaluateUpdate(ContractStatus.InForce, null, null, Row(), Row()).Allowed);
        }

        [Theory]
        [InlineData(0, true)]
        [InlineData(1, false)]
        public void Create_with_state_only(int state, bool expectedAllowed)
        {
            Assert.Equal(expectedAllowed, GuardEvaluator.EvaluateCreate(null, state, Row()).Allowed);
        }
    }
}
