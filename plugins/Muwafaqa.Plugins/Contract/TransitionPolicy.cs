using System.Linq;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>The verdict of a policy. Deny carries the English message shown to the user.</summary>
    public sealed class PolicyResult
    {
        public bool Allowed { get; }
        public string Message { get; }

        private PolicyResult(bool allowed, string message) { Allowed = allowed; Message = message; }

        public static readonly PolicyResult Allow = new PolicyResult(true, null);
        public static PolicyResult Deny(string message) { return new PolicyResult(false, message); }
    }

    /// <summary>Which Status Reason changes are allowed, decided by statuscode only.</summary>
    public static class TransitionPolicy
    {
        private static int[] AllowedNext(int from)
        {
            switch (from)
            {
                case ContractStatus.Draft: return new[] { ContractStatus.PendingApproval };
                case ContractStatus.PendingApproval: return new[] { ContractStatus.Draft, ContractStatus.InForce, ContractStatus.Rejected };
                case ContractStatus.Rejected: return new[] { ContractStatus.Draft };
                case ContractStatus.InForce: return new int[0];
                default: return null;
            }
        }

        /// <summary>Same status is not a transition (allowed). Everything not listed is rejected.</summary>
        public static PolicyResult Check(int from, int to)
        {
            if (from == to) return PolicyResult.Allow;

            var allowed = AllowedNext(from);
            if (allowed == null || !ContractStatus.IsKnown(to))
            {
                return PolicyResult.Deny("Cannot change the contract status from " + ContractStatus.NameOf(from) + " to "
                    + ContractStatus.NameOf(to) + ". The status is not one of the contract statuses.");
            }
            if (allowed.Contains(to)) return PolicyResult.Allow;

            var tail = allowed.Length == 0
                ? ContractStatus.NameOf(from) + " is final."
                : "Allowed next status: " + string.Join(", ", allowed.Select(a => ContractStatus.NameOf(a))) + ".";
            return PolicyResult.Deny("Cannot change the contract status from " + ContractStatus.NameOf(from) + " to "
                + ContractStatus.NameOf(to) + ". " + tail);
        }

        /// <summary>On Create the status may be absent (platform default Draft), Draft or Pending Approval.</summary>
        public static PolicyResult CheckCreate(int? requestedStatus)
        {
            if (!requestedStatus.HasValue) return PolicyResult.Allow;
            var s = requestedStatus.Value;
            if (s == ContractStatus.Draft || s == ContractStatus.PendingApproval) return PolicyResult.Allow;
            return PolicyResult.Deny("Cannot create a contract with status " + ContractStatus.NameOf(s)
                + ". A new contract starts as Draft or Pending Approval.");
        }
    }
}
