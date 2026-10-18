using Muwafaqa.Plugins.Contract;
using Xunit;
using static Muwafaqa.Plugins.Tests.GuardTestData;

namespace Muwafaqa.Plugins.Tests
{
    public class GuardEvaluatorTests
    {
        private static readonly System.Tuple<ColumnValue, ColumnValue> V = TwoValues(ContractColumns.Value);

        // ---- Create: each status and none ----
        [Theory]
        [InlineData(null, null, true)]                              // status absent: platform default Draft
        [InlineData(ContractStatus.Draft, 0, true)]
        [InlineData(ContractStatus.PendingApproval, 0, true)]
        [InlineData(ContractStatus.InForce, 0, false)]
        [InlineData(ContractStatus.Rejected, 1, false)]
        public void Create_by_requested_status(int? status, int? state, bool expectedAllowed)
        {
            Assert.Equal(expectedAllowed, GuardEvaluator.EvaluateCreate(status, state, ValidCreateRow()).Allowed);
        }

        [Fact]
        public void Create_with_a_frozen_value_is_denied_even_with_an_allowed_status()
        {
            var r = GuardEvaluator.EvaluateCreate(ContractStatus.Draft, 0,
                ValidCreateRow(Col(ContractColumns.ValueUsdFrozen, ColumnValue.FromDecimal(5m))));
            Assert.False(r.Allowed);
        }

        // ---- Update ----
        [Fact]
        public void Same_status_save_is_a_no_op_in_every_status()
        {
            foreach (var s in Statuses)
            {
                var state = s == ContractStatus.Rejected ? 1 : 0;
                Assert.True(GuardEvaluator.EvaluateUpdate(s, s, state, Row(), Row()).Allowed);
            }
        }

        [Fact]
        public void Transition_is_checked_before_locked_columns()
        {
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.Draft, ContractStatus.InForce, 0,
                Row(Col(ContractColumns.Value, V.Item2)), Row(Col(ContractColumns.Value, V.Item1)));
            Assert.False(r.Allowed);
            Assert.StartsWith("Cannot change the contract status", r.Message);
        }

        [Fact]
        public void Identical_value_write_is_a_no_op_in_a_locked_status()
        {
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.InForce, null, null,
                Row(Col(ContractColumns.Value, V.Item1)), Row(Col(ContractColumns.Value, V.Item1)));
            Assert.True(r.Allowed);
        }

        // ---- one request that changes Value AND the status ----
        // Model A (PreValidation delivers ONE pass): the Target holds both, the PreImage is the row before the request.
        // Model B (the platform splits the request): pass 1 has the normal columns, pass 2 only the status, and in
        // pass 2 the PreImage already shows the NEW Value (verified with plug-in 1, documented for PreOperation).

        [Fact]
        public void Draft_to_Pending_with_a_changed_Value_single_pass_is_allowed()
        {
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.Draft, ContractStatus.PendingApproval, 0,
                Row(Col(ContractColumns.Value, V.Item2)), Row(Col(ContractColumns.Value, V.Item1)));
            Assert.True(r.Allowed);
        }

        [Fact]
        public void Draft_to_Pending_with_a_changed_Value_two_passes_both_allowed()
        {
            var pass1 = GuardEvaluator.EvaluateUpdate(ContractStatus.Draft, null, null,
                Row(Col(ContractColumns.Value, V.Item2)), Row(Col(ContractColumns.Value, V.Item1)));
            var pass2 = GuardEvaluator.EvaluateUpdate(ContractStatus.Draft, ContractStatus.PendingApproval, 0,
                Row(), Row(Col(ContractColumns.Value, V.Item2)));
            Assert.True(pass1.Allowed);
            Assert.True(pass2.Allowed);
        }

        [Fact]
        public void Pending_to_Draft_with_a_changed_Value_single_pass_is_rejected()
        {
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.PendingApproval, ContractStatus.Draft, 0,
                Row(Col(ContractColumns.Value, V.Item2)), Row(Col(ContractColumns.Value, V.Item1)));
            Assert.False(r.Allowed);
            Assert.Contains("Cannot change Value while the contract status is Pending Approval.", r.Message);
        }

        [Fact]
        public void Pending_to_Draft_with_a_changed_Value_two_passes_pass_1_rejects()
        {
            var pass1 = GuardEvaluator.EvaluateUpdate(ContractStatus.PendingApproval, null, null,
                Row(Col(ContractColumns.Value, V.Item2)), Row(Col(ContractColumns.Value, V.Item1)));
            Assert.False(pass1.Allowed);
            Assert.Contains("Value", pass1.Message);
        }

        [Fact]
        public void Pass_2_alone_cannot_see_the_value_change_so_the_guard_relies_on_pass_1()
        {
            // Documents the assumption: if pass 1 never reached the guard, pass 2 alone looks harmless.
            var pass2 = GuardEvaluator.EvaluateUpdate(ContractStatus.PendingApproval, ContractStatus.Draft, 0,
                Row(), Row(Col(ContractColumns.Value, V.Item2)));
            Assert.True(pass2.Allowed);
        }

        // ---- the two behaviors proven earlier (ADR-004) ----
        [Fact]
        public void A_late_flow_write_of_In_Force_over_Draft_is_rejected()
        {
            Assert.False(GuardEvaluator.EvaluateUpdate(
                ContractStatus.Draft, ContractStatus.InForce, 0, Row(), Row()).Allowed);
        }

        [Fact]
        public void Value_edit_while_Pending_is_rejected()
        {
            var r = GuardEvaluator.EvaluateUpdate(ContractStatus.PendingApproval, null, null,
                Row(Col(ContractColumns.Value, V.Item2)), Row(Col(ContractColumns.Value, V.Item1)));
            Assert.False(r.Allowed);
        }

        [Fact]
        public void Flow_approval_and_rejection_from_Pending_are_allowed()
        {
            Assert.True(GuardEvaluator.EvaluateUpdate(
                ContractStatus.PendingApproval, ContractStatus.InForce, 0, Row(), Row()).Allowed);
            Assert.True(GuardEvaluator.EvaluateUpdate(
                ContractStatus.PendingApproval, ContractStatus.Rejected, 1, Row(), Row()).Allowed);
        }
    }
}
