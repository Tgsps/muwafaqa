using System.Collections.Generic;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>
    /// Composes the three policies for one (Target, PreImage) pair. Pure, so the same code is unit tested and shipped.
    /// The status BEFORE the request always comes from the PreImage, in every pass of a request.
    /// </summary>
    public static class GuardEvaluator
    {
        public static PolicyResult EvaluateCreate(
            int? statusInTarget, int? stateInTarget, IDictionary<string, ColumnValue> target)
        {
            var transition = TransitionPolicy.CheckCreate(ContractStatus.ResolveRequested(statusInTarget, stateInTarget));
            if (!transition.Allowed) return transition;
            return LockedColumnsPolicy.CheckCreate(target);
        }

        public static PolicyResult EvaluateUpdate(
            int preStatus, int? statusInTarget, int? stateInTarget,
            IDictionary<string, ColumnValue> target, IDictionary<string, ColumnValue> preImage)
        {
            var requested = ContractStatus.ResolveRequested(statusInTarget, stateInTarget);
            if (requested.HasValue && requested.Value != preStatus)
            {
                var transition = TransitionPolicy.Check(preStatus, requested.Value);
                if (!transition.Allowed) return transition;
            }
            return LockedColumnsPolicy.CheckUpdate(preStatus, target, preImage);
        }

        public static PolicyResult EvaluateDelete(int preStatus)
        {
            return DeletePolicy.Check(preStatus);
        }
    }
}
