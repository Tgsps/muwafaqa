namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Status Reason values of mwf_contract and the default status of each state (src/Entities/mwf_Contract/Entity.xml).</summary>
    public static class ContractStatus
    {
        public const int Draft = 1;                 // state 0 (Active)
        public const int Rejected = 2;              // state 1 (Inactive)
        public const int PendingApproval = 867640000; // state 0
        public const int InForce = 867640001;       // state 0

        public const int ActiveState = 0;
        public const int InactiveState = 1;

        /// <summary>A value that is not a status of this table. Always rejected by the policies.</summary>
        public const int Unknown = -1;

        public static string NameOf(int? status)
        {
            switch (status)
            {
                case Draft: return "Draft";
                case PendingApproval: return "Pending Approval";
                case InForce: return "In Force";
                case Rejected: return "Rejected";
                case null: return "(none)";
                default: return "status " + status.Value;
            }
        }

        public static bool IsKnown(int status)
        {
            return status == Draft || status == PendingApproval || status == InForce || status == Rejected;
        }

        /// <summary>The status the platform sets when a state is changed without a Status Reason (DefaultStatus of the state).</summary>
        public static int DefaultStatusOfState(int state)
        {
            if (state == ActiveState) return Draft;
            if (state == InactiveState) return Rejected;
            return Unknown;
        }

        /// <summary>
        /// The status a request asks for. A Status Reason in the request wins. If only the state is sent, the platform
        /// applies the default status of that state, so that is what the request means. Null if the request has neither.
        /// </summary>
        public static int? ResolveRequested(int? statusInRequest, int? stateInRequest)
        {
            if (statusInRequest.HasValue) return statusInRequest.Value;
            if (stateInRequest.HasValue) return DefaultStatusOfState(stateInRequest.Value);
            return null;
        }
    }
}
